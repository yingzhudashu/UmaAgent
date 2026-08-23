import { spawn } from "node:child_process";
import { lookup } from "node:dns/promises";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { dirname, join, relative } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { Session } from "@uma-agent/protocol";
import Type, { type TSchema } from "typebox";
import { Agent as HttpAgent, fetch as undiciFetch } from "undici";
import type { UmaDatabase } from "./database.js";
import type { KnowledgeService } from "./knowledge.js";
import type { SearchService } from "./search.js";
import type { SkillRegistry } from "./skills.js";
import type { WorkspacePolicy } from "./workspace.js";

type ToolDetails = Record<string, unknown>;
function defineTool<T extends TSchema>(value: AgentTool<T, ToolDetails>): AgentTool<T, ToolDetails> {
  return value;
}
const result = (text: string, details: Record<string, unknown> = {}) => ({
  content: [{ type: "text" as const, text }],
  details,
});

async function readTextFile(path: string): Promise<string> {
  const bytes = await readFile(path);
  const limited = bytes.subarray(0, 400_000);
  let encoding = "utf-8";
  let offset = 0;
  if (limited[0] === 0xef && limited[1] === 0xbb && limited[2] === 0xbf) offset = 3;
  else if (limited[0] === 0xff && limited[1] === 0xfe) {
    encoding = "utf-16le";
    offset = 2;
  } else if (limited[0] === 0xfe && limited[1] === 0xff) {
    encoding = "utf-16be";
    offset = 2;
  }
  try {
    return new TextDecoder(encoding, { fatal: true }).decode(limited.subarray(offset)).slice(0, 100_000);
  } catch {
    throw new Error(`Attachment text encoding is not supported: ${encoding}`);
  }
}

async function walk(directory: string, root: string, output: string[], query?: RegExp): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === ".git" || entry.name === "node_modules" || entry.name === "dist") continue;
    const path = join(directory, entry.name);
    const rel = relative(root, path);
    if (entry.isDirectory()) await walk(path, root, output, query);
    else if (entry.isFile()) {
      if (!query) output.push(rel);
      else {
        const content = await readFile(path, "utf8").catch(() => "");
        content.split(/\r?\n/).forEach((line, index) => {
          if (query.test(line)) output.push(`${rel}:${index + 1}:${line}`);
          query.lastIndex = 0;
        });
      }
    }
    if (output.length >= 2_000) return;
  }
}

function runShell(
  command: string,
  cwd: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const executable = process.platform === "win32" ? "powershell.exe" : "/bin/bash";
    const args =
      process.platform === "win32"
        ? ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command]
        : ["-lc", command];
    const child = spawn(executable, args, { cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const limit = 200_000;
    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length < limit) stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < limit) stderr += chunk.toString();
    });
    const timer = setTimeout(() => child.kill(), timeoutMs);
    const abort = () => child.kill();
    signal?.addEventListener("abort", abort, { once: true });
    child.once("error", reject);
    child.once("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (signal?.aborted) reject(new Error("Shell command cancelled"));
      else resolve({ stdout, stderr, code });
    });
  });
}

function privateAddress(address: string): boolean {
  const normalized = address.toLowerCase();
  const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  if (mapped) return privateAddress(mapped);
  if (
    normalized === "::" ||
    normalized === "::1" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    /^fe[89ab]/.test(normalized) ||
    normalized.startsWith("ff")
  )
    return true;
  if (isIP(normalized) === 4) {
    const [a = 0, b = 0, c = 0] = normalized.split(".").map(Number);
    return (
      a === 10 ||
      a === 127 ||
      a === 0 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 198 && (b === 18 || b === 19)) ||
      (a === 192 && b === 0 && (c === 0 || c === 2)) ||
      (a === 198 && b === 51 && c === 100) ||
      (a === 203 && b === 0 && c === 113) ||
      a >= 224
    );
  }
  return false;
}

export async function safeFetch(raw: string, signal?: AbortSignal): Promise<string> {
  let url = new URL(raw);
  for (let redirects = 0; redirects <= 3; redirects++) {
    if (url.protocol !== "http:" && url.protocol !== "https:")
      throw new Error("Only HTTP(S) URLs are supported");
    const resolved = await lookup(url.hostname, { all: true });
    if (!resolved.length || resolved.some((item) => privateAddress(item.address)))
      throw new Error("Private or unresolved network targets are blocked");
    const selected = resolved[0];
    if (!selected) throw new Error("Network target did not resolve");
    const dispatcher = new HttpAgent({
      connect: {
        lookup(_hostname, _options, callback) {
          callback(null, selected.address, selected.family);
        },
      },
    });
    try {
      const response = await undiciFetch(url, {
        method: "GET",
        redirect: "manual",
        dispatcher,
        ...(signal ? { signal } : {}),
        headers: { "user-agent": "UmaAgent/0.7" },
      });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) throw new Error("Redirect has no location");
        url = new URL(location, url);
        continue;
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.text();
      return body.slice(0, 100_000);
    } finally {
      await dispatcher.close();
    }
  }
  throw new Error("Too many redirects");
}

export function createBuiltinTools(input: {
  session: Session;
  database: UmaDatabase;
  knowledge: KnowledgeService;
  skills: SkillRegistry;
  workspacePolicy: WorkspacePolicy;
  toolTimeoutMs: number;
  search: SearchService;
  scheduleManage: (input: Record<string, unknown>) => unknown;
  memoryWrite: (scope: "global" | "session", content: string) => ReturnType<UmaDatabase["addMemoryFact"]>;
  attachmentCreateFromWorkspace?: (path: string) => Promise<{ id: string; name: string }>;
}): AgentTool[] {
  const {
    session,
    database,
    knowledge,
    skills,
    workspacePolicy,
    toolTimeoutMs,
    search,
    scheduleManage,
    memoryWrite,
    attachmentCreateFromWorkspace,
  } = input;
  const webSearchTool = () =>
    defineTool({
      name: "web_search",
      label: "Search web",
      description: "Search Tavily or Stack Overflow and return traceable citations.",
      parameters: Type.Object({
        query: Type.String(),
        provider: Type.Optional(Type.Union([Type.Literal("tavily"), Type.Literal("stackexchange")])),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })),
      }),
      executionMode: "parallel",
      async execute(_id, params, signal) {
        const citations = await search.search(
          params.provider ?? "tavily",
          params.query,
          params.limit ?? 5,
          signal,
        );
        return result(
          citations
            .map((item, index) => `[${index + 1}] ${item.title}\n${item.url}\n${item.snippet}`)
            .join("\n\n") || "No search results",
          { citations },
        );
      },
    });
  const scheduleTool = () =>
    defineTool({
      name: "schedule_manage",
      label: "Manage schedule",
      description:
        "List, create, update, run, or delete persistent scheduled tasks. Changes require approval.",
      parameters: Type.Object({
        operation: Type.Union([
          Type.Literal("list"),
          Type.Literal("create"),
          Type.Literal("update"),
          Type.Literal("run"),
          Type.Literal("delete"),
        ]),
        id: Type.Optional(Type.String()),
        name: Type.Optional(Type.String()),
        prompt: Type.Optional(Type.String()),
        kind: Type.Optional(
          Type.Union([Type.Literal("once"), Type.Literal("interval"), Type.Literal("cron")]),
        ),
        at: Type.Optional(Type.Integer({ minimum: 0 })),
        everyMs: Type.Optional(Type.Integer({ minimum: 60_000 })),
        expression: Type.Optional(Type.String()),
        timezone: Type.Optional(Type.String()),
        enabled: Type.Optional(Type.Boolean()),
      }),
      executionMode: "sequential",
      async execute(_id, params) {
        return result(JSON.stringify(scheduleManage(params), null, 2));
      },
    });
  const historyTools = (): AgentTool[] => [
    defineTool({
      name: "history_search",
      label: "Search history",
      description: "Search this session's durable transcript and return matching public messages.",
      parameters: Type.Object({
        query: Type.String(),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
      }),
      executionMode: "parallel",
      async execute(_id, params) {
        const items = database.searchHistory(session.id, params.query, params.limit ?? 20);
        return result(
          items.map((item) => `[${item.sequence}] ${item.role}: ${item.content}`).join("\n\n") ||
            "No history found",
          { sequences: items.map((item) => item.sequence) },
        );
      },
    }),
    defineTool({
      name: "history_read",
      label: "Read history",
      description: "Read a bounded sequence range from this session's public transcript.",
      parameters: Type.Object({
        fromSequence: Type.Integer({ minimum: 1 }),
        toSequence: Type.Integer({ minimum: 1 }),
      }),
      executionMode: "parallel",
      async execute(_id, params) {
        const items = database.readHistoryRange(session.id, params.fromSequence, params.toSequence);
        return result(items.map((item) => `[${item.sequence}] ${item.role}: ${item.content}`).join("\n\n"));
      },
    }),
  ];
  if (!session.workspace) throw new Error("Session workspace is required");
  const workspace = session.workspace;
  const readSchema = Type.Object({
    path: Type.String(),
    offset: Type.Optional(Type.Integer({ minimum: 1 })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 2_000 })),
  });
  const writeSchema = Type.Object({ path: Type.String(), content: Type.String() });
  const editSchema = Type.Object({ path: Type.String(), oldText: Type.String(), newText: Type.String() });
  const pathSchema = Type.Object({ path: Type.Optional(Type.String()) });
  const searchSchema = Type.Object({ query: Type.String(), path: Type.Optional(Type.String()) });
  const shellSchema = Type.Object({ command: Type.String() });
  const fetchSchema = Type.Object({ url: Type.String() });
  const memoryWriteSchema = Type.Object({
    content: Type.String(),
    scope: Type.Optional(Type.Union([Type.Literal("session"), Type.Literal("global")])),
  });
  const querySchema = Type.Object({
    query: Type.String(),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
  });
  const attachmentSchema = Type.Object({ attachmentId: Type.String() });

  return [
    ...historyTools(),
    defineTool({
      name: "read",
      label: "Read file",
      description: "Read a UTF-8 file inside the session workspace.",
      parameters: readSchema,
      executionMode: "parallel",
      async execute(_id, params) {
        const path = await workspacePolicy.resolvePath(workspace, params.path);
        const lines = (await readFile(path, "utf8")).split(/\r?\n/);
        const start = (params.offset ?? 1) - 1;
        return result(lines.slice(start, start + (params.limit ?? 500)).join("\n"), {
          path,
          totalLines: lines.length,
        });
      },
    }),
    defineTool({
      name: "write",
      label: "Write file",
      description: "Create or replace a UTF-8 file inside the session workspace.",
      parameters: writeSchema,
      executionMode: "sequential",
      async execute(_id, params) {
        const path = await workspacePolicy.resolvePath(workspace, params.path, true);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, params.content, "utf8");
        return result(`Wrote ${params.content.length} characters to ${relative(workspace, path)}`, {
          path,
        });
      },
    }),
    defineTool({
      name: "edit",
      label: "Edit file",
      description: "Replace one exact text occurrence in a UTF-8 file.",
      parameters: editSchema,
      executionMode: "sequential",
      async execute(_id, params) {
        const path = await workspacePolicy.resolvePath(workspace, params.path);
        const current = await readFile(path, "utf8");
        const first = current.indexOf(params.oldText);
        if (first < 0) throw new Error("oldText was not found");
        if (current.indexOf(params.oldText, first + params.oldText.length) >= 0)
          throw new Error("oldText is not unique");
        await writeFile(path, current.replace(params.oldText, params.newText), "utf8");
        return result(`Edited ${relative(workspace, path)}`, { path });
      },
    }),
    defineTool({
      name: "list",
      label: "List files",
      description: "List files recursively inside the workspace.",
      parameters: pathSchema,
      executionMode: "parallel",
      async execute(_id, params) {
        const root = await workspacePolicy.resolvePath(workspace, params.path ?? ".");
        const output: string[] = [];
        await walk(root, root, output);
        return result(output.join("\n") || "No files", { root, truncated: output.length >= 2_000 });
      },
    }),
    defineTool({
      name: "search",
      label: "Search files",
      description: "Search workspace text files with a regular expression.",
      parameters: searchSchema,
      executionMode: "parallel",
      async execute(_id, params) {
        const root = await workspacePolicy.resolvePath(workspace, params.path ?? ".");
        const output: string[] = [];
        await walk(root, root, output, new RegExp(params.query, "i"));
        return result(output.join("\n") || "No matches", { root, truncated: output.length >= 2_000 });
      },
    }),
    defineTool({
      name: "shell",
      label: "Run shell",
      description: "Run a non-interactive shell command in the session workspace. Requires approval.",
      parameters: shellSchema,
      executionMode: "sequential",
      async execute(_id, params, signal) {
        const output = await runShell(params.command, workspace, toolTimeoutMs, signal);
        return result([output.stdout, output.stderr].filter(Boolean).join("\n"), output);
      },
    }),
    defineTool({
      name: "http_get",
      label: "Fetch URL",
      description: "Fetch public HTTP(S) text. Private network destinations are blocked.",
      parameters: fetchSchema,
      executionMode: "sequential",
      async execute(_id, params, signal) {
        return result(await safeFetch(params.url, signal), { url: params.url });
      },
    }),
    defineTool({
      name: "memory_write",
      label: "Remember",
      description: "Store an explicit durable fact in session or global memory. Requires approval.",
      parameters: memoryWriteSchema,
      executionMode: "sequential",
      async execute(_id, params) {
        const scope = params.scope ?? "session";
        const fact = memoryWrite(scope, params.content);
        return result("Memory stored", { id: fact.id, scope });
      },
    }),
    defineTool({
      name: "memory_search",
      label: "Search memory",
      description: "Search durable session and global memories.",
      parameters: querySchema,
      executionMode: "parallel",
      async execute(_id, params) {
        return result(
          database.searchMemory(session.id, params.query, params.limit ?? 5).join("\n\n") ||
            "No memories found",
        );
      },
    }),
    defineTool({
      name: "knowledge_search",
      label: "Search knowledge",
      description: "Search indexed knowledge sources.",
      parameters: querySchema,
      executionMode: "parallel",
      async execute(_id, params) {
        const found = knowledge.search(params.query, params.limit ?? 5);
        return result(
          found.map((item) => `### ${item.filePath}\n${item.content}`).join("\n\n") || "No knowledge found",
        );
      },
    }),
    defineTool({
      name: "skill_read",
      label: "Read skill",
      description: "Load one enabled skill by name.",
      parameters: Type.Object({ name: Type.String() }),
      executionMode: "parallel",
      async execute(_id, params) {
        return result(skills.read(params.name), { name: params.name });
      },
    }),
    defineTool({
      name: "attachment_read",
      label: "Read attachment",
      description: "Read a text attachment uploaded to the server.",
      parameters: attachmentSchema,
      executionMode: "parallel",
      async execute(_id, params) {
        database.validateAttachmentForSession(params.attachmentId, session.id);
        const attachment = database.getAttachment(params.attachmentId);
        if (!attachment) throw new Error(`Attachment not found: ${params.attachmentId}`);
        if (
          !attachment.mimeType.startsWith("text/") &&
          !/(^|\/)(json|yaml|xml|javascript|typescript)$/.test(attachment.mimeType)
        )
          throw new Error(`Attachment is not readable text: ${attachment.mimeType}`);
        const path = database.getAttachmentPath(params.attachmentId, session.id);
        return result(await readTextFile(path), { name: attachment.name });
      },
    }),
    ...(attachmentCreateFromWorkspace
      ? [
          defineTool({
            name: "attachment_create_from_workspace",
            label: "Create attachment from workspace",
            description:
              "Copy one file from the current workspace into this session as an attachment after path validation.",
            parameters: Type.Object({ path: Type.String() }),
            executionMode: "sequential",
            async execute(_id, params) {
              const path = await workspacePolicy.resolvePath(workspace, params.path);
              const attachment = await attachmentCreateFromWorkspace(path);
              return result(JSON.stringify(attachment), attachment);
            },
          }),
        ]
      : []),
    webSearchTool(),
    scheduleTool(),
  ];
}
