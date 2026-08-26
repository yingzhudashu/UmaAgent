import { randomUUID, timingSafeEqual } from "node:crypto";
import * as lark from "@larksuiteoapi/node-sdk";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { loadUserConfig } from "@uma-agent/channel-adapter";
import { UmaClient } from "@uma-agent/client";
import type { Request, Response } from "express";
import { createFeishuMcp, type FeishuBusinessGateway, retryFeishuOperation } from "./service.js";

const configPath = process.argv.find((arg) => arg.startsWith("--config="))?.slice(9) ?? "config.user.json";
const user = await loadUserConfig(configPath, "feishu");
const sdk = new lark.Client({ appId: user.feishu.appId, appSecret: user.feishu.appSecret });
const gateway: FeishuBusinessGateway = {
  request: (method, url, input) =>
    retryFeishuOperation(() =>
      sdk.request({ method, url, ...(method === "GET" ? { params: input } : { data: input }) }),
    ),
  async upload(url, file, input) {
    const form = new FormData();
    form.set("file_name", file.name);
    form.set("file", new Blob([file.bytes.slice().buffer as ArrayBuffer], { type: file.type }), file.name);
    for (const [key, value] of Object.entries((input ?? {}) as Record<string, unknown>))
      form.set(key, String(value));
    return retryFeishuOperation(() => sdk.request({ method: "POST", url, data: form }));
  },
  async download(url) {
    const response = await retryFeishuOperation(() =>
      sdk.request<ArrayBuffer>({ method: "GET", url, responseType: "arraybuffer" }),
    );
    return { name: "feishu-download", type: "application/octet-stream", bytes: new Uint8Array(response) };
  },
};
const core = new UmaClient({ baseUrl: user.core.serverUrl, token: user.core.token });
type FeishuMcp = ReturnType<typeof createFeishuMcp>;
type McpSession = { server: FeishuMcp; transport: StreamableHTTPServerTransport };
const sessions = new Map<string, McpSession>();
const createSession = async (): Promise<McpSession> => {
  const server = createFeishuMcp({ gateway, core });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID } as never);
  transport.onerror = (error) => console.error("feishu.mcp.error", { error: error.message });
  const session = { server, transport };
  transport.onclose = () => {
    if (transport.sessionId) sessions.delete(transport.sessionId);
  };
  await server.connect(transport as Parameters<FeishuMcp["connect"]>[0]);
  return session;
};
const host = user.feishu.mcpHost;
const port = user.feishu.mcpPort;
const token = process.env.FEISHU_MCP_TOKEN?.trim();
if (!new Set(["127.0.0.1", "localhost", "::1", "[::1]"]).has(host) && !token)
  throw new Error("FEISHU_MCP_TOKEN is required for non-loopback hosts");
const authenticated = (header?: string) => {
  if (!token) return true;
  const actual = Buffer.from(header ?? "");
  const expected = Buffer.from(`Bearer ${token}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
};
const app = createMcpExpressApp({ host });
app.get("/health", (_request: Request, response: Response) => {
  response.json({ status: "ok", service: "feishu-mcp" });
});
app.all("/mcp", async (request: Request, response: Response) => {
  if (!authenticated(request.headers.authorization)) {
    response.status(401).end();
    return;
  }
  try {
    const rawSessionId = request.headers["mcp-session-id"];
    const sessionId = Array.isArray(rawSessionId) ? rawSessionId[0] : rawSessionId;
    const session = sessionId
      ? sessions.get(sessionId)
      : request.method === "POST"
        ? await createSession()
        : undefined;
    if (!session) {
      response.status(400).json({ error: "MCP session is missing or expired" });
      return;
    }
    await session.transport.handleRequest(request, response, request.body);
    if (session.transport.sessionId) sessions.set(session.transport.sessionId, session);
  } catch (error) {
    console.error("feishu.mcp.failed", {
      error: error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300),
    });
    if (!response.headersSent) response.status(500).end();
  }
});
const server = app.listen(port, host);
const stop = async () => {
  core.close();
  await Promise.allSettled([...sessions.values()].map(({ transport }) => transport.close()));
  sessions.clear();
  server.close();
};
process.once("SIGINT", () => void stop());
process.once("SIGTERM", () => void stop());
