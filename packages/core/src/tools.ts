import { spawn } from "node:child_process";
import { lookup } from "node:dns/promises";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { basename, dirname, join, relative } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { Session } from "@uma-agent/protocol";
import Type, { type TSchema } from "typebox";
import { Agent as HttpAgent, fetch as undiciFetch } from "undici";
import type { UmaDatabase } from "./database.js";
import type { KnowledgeService } from "./knowledge.js";
import type { WorkspacePolicy } from "./workspace.js";

type ToolDetails = Record<string, unknown>;
function defineTool<T extends TSchema>(value: AgentTool<T, ToolDetails>): AgentTool<T, ToolDetails> {
  return value;
}
const result = (text: string, details: Record<string, unknown> = {}) => ({
  content: [{ type: "text" as const, text }],
  details,
});

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
        headers: { "user-agent": "UmaAgent/0.1" },
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
  workspacePolicy: WorkspacePolicy;
  toolTimeoutMs: number;
}): AgentTool[] {
  const { session, database, knowledge, workspacePolicy, toolTimeoutMs } = input;
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
    defineTool({
      name: "read",
      label: "Read file",
      description: "Read a UTF-8 file inside the session workspace.",
      parameters: readSchema,
      executionMode: "parallel",
      async execute(_id, params) {
        const path = await workspacePolicy.resolvePath(session.workspace, params.path);
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
        const path = await workspacePolicy.resolvePath(session.workspace, params.path, true);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, params.content, "utf8");
        return result(`Wrote ${params.content.length} characters to ${relative(session.workspace, path)}`, {
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
        const path = await workspacePolicy.resolvePath(session.workspace, params.path);
        const current = await readFile(path, "utf8");
        const first = current.indexOf(params.oldText);
        if (first < 0) throw new Error("oldText was not found");
        if (current.indexOf(params.oldText, first + params.oldText.length) >= 0)
          throw new Error("oldText is not unique");
        await writeFile(path, current.replace(params.oldText, params.newText), "utf8");
        return result(`Edited ${relative(session.workspace, path)}`, { path });
      },
    }),
    defineTool({
      name: "list",
      label: "List files",
      description: "List files recursively inside the workspace.",
      parameters: pathSchema,
      executionMode: "parallel",
      async execute(_id, params) {
        const root = await workspacePolicy.resolvePath(session.workspace, params.path ?? ".");
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
        const root = await workspacePolicy.resolvePath(session.workspace, params.path ?? ".");
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
        const output = await runShell(params.command, session.workspace, toolTimeoutMs, signal);
        return result([output.stdout, output.stderr].filter(Boolean).join("\n"), output);
      },
    }),
    defineTool({
      name: "http_get",
      label: "Fetch URL",
      description: "Fetch public HTTP(S) text. Private network destinations are blocked.",
      parameters: fetchSchema,
      executionMode: "parallel",
      async execute(_id, params, signal) {
        return result(await safeFetch(params.url, signal), { url: params.url });
      },
    }),
    defineTool({
      name: "memory_write",
      label: "Remember",
      description: "Store an explicit durable fact in session or global memory.",
      parameters: memoryWriteSchema,
      executionMode: "sequential",
      async execute(_id, params) {
        const scope = params.scope ?? "session";
        const id = database.addMemory(scope === "session" ? session.id : undefined, scope, params.content);
        return result("Memory stored", { id, scope });
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
      name: "attachment_read",
      label: "Read attachment",
      description: "Read a text attachment uploaded to the server.",
      parameters: attachmentSchema,
      executionMode: "parallel",
      async execute(_id, params) {
        const path = database.getAttachmentPath(params.attachmentId);
        return result((await readFile(path, "utf8")).slice(0, 100_000), {
          name: basename(path),
          path: dirname(path),
        });
      },
    }),
  ];
}
