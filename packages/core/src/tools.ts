import { spawn } from "node:child_process";
import { lookup } from "node:dns/promises";
import { mkdir, open, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { dirname, join, relative } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { Session } from "@uma-agent/protocol";
import type { TraceParent } from "@uma-agent/telemetry";
import Type, { type TSchema } from "typebox";
import type { UmaDatabase } from "./database.js";
import type { KnowledgeService } from "./knowledge.js";
import type { SearchService } from "./search.js";
import type { SkillRegistry } from "./skills.js";
import type { SmathWorkerClient } from "./smath-worker.js";
import type { WorkspacePolicy } from "./workspace.js";

type ToolDetails = Record<string, unknown>;
function defineTool<T extends TSchema>(value: AgentTool<T, ToolDetails>): AgentTool<T, ToolDetails> {
  return value;
}
const result = (text: string, details: Record<string, unknown> = {}) => ({
  content: [{ type: "text" as const, text }],
  details,
});

export interface XianyuAgentApi {
  health: () => Promise<unknown>;
  loginStatus: () => Promise<unknown>;
  conversations: () => Promise<unknown>;
  history: (conversationId: string) => Promise<unknown>;
  item: (itemId: string) => Promise<unknown>;
  chat: (input: { receiverId: string; itemId: string }) => Promise<unknown>;
  send: (input: { sessionId: string; text: string }) => Promise<unknown>;
  publish: (input: Record<string, unknown>) => Promise<unknown>;
  service: (action: "start" | "stop" | "pause" | "resume") => Promise<unknown>;
  setAutoReply: (enabled: boolean) => Promise<unknown>;
  workspace: () => unknown;
}

function jsonToolResult(value: unknown, empty = "咸鱼 Adapter 没有返回数据") {
  return result(typeof value === "string" ? value : JSON.stringify(value, null, 2) || empty, {
    xianyu: true,
  });
}

function createXianyuTools(api: XianyuAgentApi): AgentTool[] {
  return [
    defineTool({
      name: "xianyu_status",
      label: "查看咸鱼状态",
      description:
        "查询咸鱼服务、连接、登录状态、自动回复开关和当前咸鱼会话。咸鱼总控会话询问账号状态时必须使用此工具，不要查找文件工作区。",
      parameters: Type.Object({}),
      executionMode: "parallel",
      async execute() {
        const [health, login] = await Promise.all([api.health(), api.loginStatus()]);
        return jsonToolResult({ workspace: api.workspace(), service: health, login });
      },
    }),
    defineTool({
      name: "xianyu_conversations",
      label: "查看咸鱼会话",
      description: "列出 Adapter 当前已映射的咸鱼买家会话和会话 ID。",
      parameters: Type.Object({}),
      executionMode: "parallel",
      async execute() {
        return jsonToolResult(await api.conversations());
      },
    }),
    defineTool({
      name: "xianyu_history",
      label: "查看咸鱼历史",
      description: "读取指定咸鱼 conversationId 的历史消息。",
      parameters: Type.Object({ conversationId: Type.String({ minLength: 1 }) }),
      executionMode: "parallel",
      async execute(_id, params) {
        return jsonToolResult(await api.history(params.conversationId));
      },
    }),
    defineTool({
      name: "xianyu_item",
      label: "查看咸鱼商品",
      description: "读取指定咸鱼商品 ID 的详情。",
      parameters: Type.Object({ itemId: Type.String({ minLength: 1 }) }),
      executionMode: "parallel",
      async execute(_id, params) {
        return jsonToolResult(await api.item(params.itemId));
      },
    }),
    defineTool({
      name: "xianyu_send",
      label: "发送咸鱼回复",
      description:
        "向已映射的咸鱼买家会话发送一条明确指定的回复。只在管理员明确要求发送时使用；sessionId 必须来自咸鱼会话列表。",
      parameters: Type.Object({
        sessionId: Type.String({ minLength: 1 }),
        text: Type.String({ minLength: 1 }),
      }),
      executionMode: "sequential",
      async execute(_id, params) {
        return jsonToolResult(await api.send({ sessionId: params.sessionId, text: params.text }));
      },
    }),
    defineTool({
      name: "xianyu_auto_reply",
      label: "设置咸鱼自动回复",
      description: "开启或关闭咸鱼自动回复。关闭时入站消息只生成草稿，不会直接发送给买家。",
      parameters: Type.Object({ enabled: Type.Boolean() }),
      executionMode: "sequential",
      async execute(_id, params) {
        return jsonToolResult(await api.setAutoReply(params.enabled));
      },
    }),
    defineTool({
      name: "xianyu_service",
      label: "控制咸鱼服务",
      description: "启动、停止、暂停或恢复咸鱼 Adapter 服务。",
      parameters: Type.Object({
        action: Type.Union([
          Type.Literal("start"),
          Type.Literal("stop"),
          Type.Literal("pause"),
          Type.Literal("resume"),
        ]),
      }),
      executionMode: "sequential",
      async execute(_id, params) {
        return jsonToolResult(await api.service(params.action));
      },
    }),
    defineTool({
      name: "xianyu_chat",
      label: "创建咸鱼会话",
      description: "根据买家 receiverId 和商品 itemId 在咸鱼发起新会话。该操作会触发审批。",
      parameters: Type.Object({
        receiverId: Type.String({ minLength: 1 }),
        itemId: Type.String({ minLength: 1 }),
      }),
      executionMode: "sequential",
      async execute(_id, params) {
        return jsonToolResult(await api.chat({ receiverId: params.receiverId, itemId: params.itemId }));
      },
    }),
    defineTool({
      name: "xianyu_publish",
      label: "发布咸鱼商品",
      description: "发布咸鱼商品。必须先确认商品描述、图片、价格、配送和坐标；该操作会触发审批。",
      parameters: Type.Object({
        description: Type.String({ minLength: 1 }),
        imagePaths: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: 20 }),
        delivery: Type.Union([
          Type.Literal("free_shipping"),
          Type.Literal("distance_based"),
          Type.Literal("fixed"),
          Type.Literal("pickup_only"),
        ]),
        longitude: Type.Union([Type.String({ minLength: 1 }), Type.Number()]),
        latitude: Type.Union([Type.String({ minLength: 1 }), Type.Number()]),
        currentPrice: Type.Optional(Type.Union([Type.String(), Type.Number()])),
        originalPrice: Type.Optional(Type.Union([Type.String(), Type.Number()])),
        shippingFee: Type.Optional(Type.Union([Type.String(), Type.Number()])),
        selfPickup: Type.Optional(Type.Boolean()),
      }),
      executionMode: "sequential",
      async execute(_id, params) {
        return jsonToolResult(await api.publish(params));
      },
    }),
  ];
}

const MAX_READ_FILE_BYTES = 5 * 1024 * 1024;
const MAX_SEARCH_FILE_BYTES = 2 * 1024 * 1024;
const SEARCH_CHUNK_BYTES = 64 * 1024;
const MAX_LIST_RESULTS = 2_000;
const MAX_SEARCH_RESULTS = 500;
const MAX_SEARCH_MATCH_CHARS = 1_000;

async function readTextFile(path: string): Promise<string> {
  const metadata = await stat(path);
  if (metadata.size > 400_000) throw new Error("Attachment text file exceeds the 400 KiB read limit");
  const limited = await readFile(path);
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

async function searchFile(
  path: string,
  relativePath: string,
  output: string[],
  query: RegExp,
): Promise<void> {
  const metadata = await stat(path).catch(() => undefined);
  if (!metadata?.isFile() || metadata.size > MAX_SEARCH_FILE_BYTES) return;
  const handle = await open(path, "r");
  try {
    const decoder = new TextDecoder("utf-8");
    let position = 0;
    let lineNumber = 1;
    let pending = "";
    let firstChunk = true;
    while (position < metadata.size && output.length < MAX_SEARCH_RESULTS) {
      const chunk = Buffer.alloc(Math.min(SEARCH_CHUNK_BYTES, metadata.size - position));
      const read = await handle.read(chunk, 0, chunk.length, position);
      if (!read.bytesRead) break;
      position += read.bytesRead;
      const bytes = chunk.subarray(0, read.bytesRead);
      if (firstChunk) {
        firstChunk = false;
        // Workspace search is for text. Reject binary content before it can be decoded into a large string.
        if (bytes.includes(0)) return;
      }
      pending += decoder.decode(bytes, { stream: position < metadata.size });
      let newline = pending.indexOf("\n");
      while (newline >= 0 && output.length < MAX_SEARCH_RESULTS) {
        const line = pending.slice(0, newline).replace(/\r$/, "");
        query.lastIndex = 0;
        if (query.test(line))
          output.push(`${relativePath}:${lineNumber}:${line.slice(0, MAX_SEARCH_MATCH_CHARS)}`);
        lineNumber++;
        pending = pending.slice(newline + 1);
        newline = pending.indexOf("\n");
      }
    }
    if (output.length >= MAX_SEARCH_RESULTS) return;
    pending += decoder.decode();
    if (pending) {
      query.lastIndex = 0;
      if (query.test(pending))
        output.push(
          `${relativePath}:${lineNumber}:${pending.replace(/\r$/, "").slice(0, MAX_SEARCH_MATCH_CHARS)}`,
        );
    }
  } finally {
    await handle.close();
  }
}

async function walk(directory: string, root: string, output: string[], query?: RegExp): Promise<void> {
  const maxResults = query ? MAX_SEARCH_RESULTS : MAX_LIST_RESULTS;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === ".git" || entry.name === "node_modules" || entry.name === "dist") continue;
    const path = join(directory, entry.name);
    const rel = relative(root, path);
    if (entry.isDirectory()) await walk(path, root, output, query);
    else if (entry.isFile()) {
      if (!query) output.push(rel);
      else {
        await searchFile(path, rel, output, query).catch(() => undefined);
      }
    }
    if (output.length >= maxResults) return;
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
    // PowerShell 的 -Command 会再次解释参数中的引号；使用 UTF-16LE 编码
    // 的 -EncodedCommand 让整段脚本作为一个不可歧义的参数传递。
    const args =
      process.platform === "win32"
        ? [
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-EncodedCommand",
            Buffer.from(command, "utf16le").toString("base64"),
          ]
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
    let resolved: Array<{ address: string; family: number }>;
    try {
      resolved = await lookup(url.hostname, { all: true });
    } catch (error) {
      const cause = error instanceof Error ? error : new Error(String(error));
      const code = "code" in cause && typeof cause.code === "string" ? cause.code : cause.name;
      throw new Error(`http_get_dns_failed (${code}): ${cause.message}`, { cause });
    }
    if (!resolved.length || resolved.some((item) => privateAddress(item.address)))
      throw new Error("Private or unresolved network targets are blocked");
    const selected = resolved[0];
    if (!selected) throw new Error("Network target did not resolve");
    // 专用 DNS 绑定传输只在网页抓取时加载，仍保留重定向和 SSRF 校验。
    const { Agent: HttpAgent, fetch: undiciFetch } = await import("undici");
    const dispatcher = new HttpAgent({
      connect: {
        lookup(_hostname, options, callback) {
          if (options.all) callback(null, [selected]);
          else callback(null, selected.address, selected.family);
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
        if (!location) throw new Error("http_get_redirect: Redirect has no location");
        url = new URL(location, url);
        continue;
      }
      if (!response.ok) throw new Error(`http_get_http_status: HTTP ${response.status}`);
      const body = await response.text();
      return body.slice(0, 100_000);
    } catch (error) {
      if (signal?.aborted) throw error;
      if (error instanceof Error && error.message.startsWith("http_get_")) throw error;
      const cause = error instanceof Error ? error : new Error(String(error));
      const nested = cause.cause instanceof Error ? cause.cause : undefined;
      const diagnostic = nested ?? cause;
      const code =
        "code" in diagnostic && typeof diagnostic.code === "string" ? diagnostic.code : diagnostic.name;
      throw new Error(`http_get_connection_failed (${code}): ${diagnostic.message}`, { cause });
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
  imageGenerate?: (
    prompt: string,
    signal: AbortSignal,
  ) => Promise<{ id: string; name: string; size: number }>;
  smath?: SmathWorkerClient;
  traceParent?: TraceParent;
  xianyu?: XianyuAgentApi | undefined;
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
    imageGenerate,
    smath,
    traceParent,
    xianyu,
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
  const smathPathSchema = Type.Object({ path: Type.Optional(Type.String()) });
  const smathWriteSchema = Type.Object({
    path: Type.String(),
    content: Type.String({ maxLength: 1_000_000 }),
  });
  const ownerId = database.sessionOwner(session.id);
  if (!ownerId) throw new Error("Session owner is missing");
  const smathTools: AgentTool[] = smath
    ? [
        defineTool({
          name: "smath_list",
          label: "List SMath worksheets",
          description: "List SMath files in this user's isolated SMath workspace.",
          parameters: smathPathSchema,
          executionMode: "parallel",
          async execute(_id, params, signal) {
            const value = await smath.execute(
              ownerId,
              { operation: "list", ...(params.path ? { path: params.path } : {}) },
              signal,
              traceParent,
            );
            return result(value.output ?? "No SMath worksheets", { ...value });
          },
        }),
        defineTool({
          name: "smath_read",
          label: "Read SMath worksheet",
          description: "Read a worksheet source file from this user's isolated SMath workspace.",
          parameters: Type.Object({ path: Type.String() }),
          executionMode: "parallel",
          async execute(_id, params, signal) {
            const value = await smath.execute(
              ownerId,
              { operation: "read", path: params.path },
              signal,
              traceParent,
            );
            return result(value.output ?? "", { ...value });
          },
        }),
        ...(["create", "update"] as const).map((operation) =>
          defineTool({
            name: `smath_${operation}`,
            label: `${operation === "create" ? "Create" : "Update"} SMath worksheet`,
            description:
              "Write a worksheet source file in this user's isolated SMath workspace. Requires approval.",
            parameters: smathWriteSchema,
            executionMode: "sequential",
            async execute(_id, params, signal) {
              const value = await smath.execute(
                ownerId,
                { operation, path: params.path, content: params.content },
                signal,
                traceParent,
              );
              return result(value.output ?? `${operation}d ${params.path}`, { ...value });
            },
          }),
        ),
        defineTool({
          name: "smath_delete",
          label: "Delete SMath worksheet",
          description: "Delete one worksheet in this user's isolated SMath workspace. Requires approval.",
          parameters: Type.Object({ path: Type.String() }),
          executionMode: "sequential",
          async execute(_id, params, signal) {
            const value = await smath.execute(
              ownerId,
              { operation: "delete", path: params.path },
              signal,
              traceParent,
            );
            return result(value.output ?? `Deleted ${params.path}`, { ...value });
          },
        }),
        defineTool({
          name: "smath_calculate",
          label: "Calculate SMath worksheet",
          description: "Run a worksheet through the isolated SMath worker. Requires approval.",
          parameters: Type.Object({ path: Type.String() }),
          executionMode: "sequential",
          async execute(_id, params, signal) {
            const value = await smath.execute(
              ownerId,
              { operation: "calculate", path: params.path },
              signal,
              traceParent,
            );
            return result(value.output ?? "SMath calculation completed", { ...value });
          },
        }),
      ]
    : [];

  return [
    ...historyTools(),
    ...(xianyu && database.isChannelSession(session.id, "xianyu") ? createXianyuTools(xianyu) : []),
    ...smathTools,
    defineTool({
      name: "read",
      label: "Read file",
      description: "Read a UTF-8 file inside the session workspace.",
      parameters: readSchema,
      executionMode: "parallel",
      async execute(_id, params) {
        const path = await workspacePolicy.resolvePath(workspace, params.path);
        const metadata = await stat(path);
        if (metadata.size > MAX_READ_FILE_BYTES)
          throw new Error("File exceeds the 5 MiB read limit; narrow the request or use an attachment tool");
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
        const metadata = await stat(path);
        if (metadata.size > MAX_READ_FILE_BYTES) throw new Error("File exceeds the 5 MiB edit limit");
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
        return result(output.join("\n") || "No files", {
          root,
          truncated: output.length >= MAX_LIST_RESULTS,
        });
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
        return result(output.join("\n") || "No matches", {
          root,
          truncated: output.length >= MAX_SEARCH_RESULTS,
        });
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
        const ownerId = database.sessionOwner(session.id);
        if (!ownerId) throw new Error("Session owner is missing");
        const found = knowledge.search(params.query, params.limit ?? 5, undefined, ownerId);
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
        return result(skills.read(params.name, session.id), { name: params.name });
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
    ...(imageGenerate
      ? [
          defineTool({
            name: "image_generate",
            label: "Generate image",
            description: "Generate one PNG image from a text prompt and attach it to the current response.",
            parameters: Type.Object({ prompt: Type.String({ minLength: 1, maxLength: 32_000 }) }),
            executionMode: "parallel",
            async execute(_id, params, signal) {
              const attachment = await imageGenerate(params.prompt, signal ?? new AbortController().signal);
              return result(`Generated image ${attachment.name}`, { attachment });
            },
          }),
        ]
      : []),
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
