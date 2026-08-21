import { timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import * as lark from "@larksuiteoapi/node-sdk";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { UmaClient } from "@uma-agent/client";
import { createFeishuMcp, type FeishuBusinessGateway } from "./service.js";

const required = (name: string) => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
};
const sdk = new lark.Client({ appId: required("FEISHU_APP_ID"), appSecret: required("FEISHU_APP_SECRET") });
const gateway: FeishuBusinessGateway = {
  request: (method, url, input) =>
    sdk.request({ method, url, ...(method === "GET" ? { params: input } : { data: input }) }),
  async upload(url, file, input) {
    const form = new FormData();
    form.set("file_name", file.name);
    form.set("file", new Blob([file.bytes.slice().buffer as ArrayBuffer], { type: file.type }), file.name);
    for (const [key, value] of Object.entries((input ?? {}) as Record<string, unknown>))
      form.set(key, String(value));
    return sdk.request({ method: "POST", url, data: form });
  },
  async download(url) {
    const response = await sdk.request<ArrayBuffer>({ method: "GET", url, responseType: "arraybuffer" });
    return { name: "feishu-download", type: "application/octet-stream", bytes: new Uint8Array(response) };
  },
};
const core = new UmaClient({ baseUrl: required("UMA_SERVER_URL"), token: required("UMA_TOKEN") });
const mcp = createFeishuMcp({ gateway, core });
const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined } as never);
await mcp.connect(transport as Parameters<typeof mcp.connect>[0]);
const host = process.env.FEISHU_MCP_HOST?.trim() || "127.0.0.1";
const port = Number(process.env.FEISHU_MCP_PORT ?? 3240);
const token = process.env.FEISHU_MCP_AUTH_TOKEN?.trim();
if (!new Set(["127.0.0.1", "localhost", "::1", "[::1]"]).has(host) && !token)
  throw new Error("FEISHU_MCP_AUTH_TOKEN is required for non-loopback hosts");
const authenticated = (header?: string) => {
  if (!token) return true;
  const actual = Buffer.from(header ?? "");
  const expected = Buffer.from(`Bearer ${token}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
};
const server = createServer((request, response) => {
  if (request.url === "/health" && request.method === "GET") {
    response
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({ status: "ok", service: "feishu-mcp" }));
    return;
  }
  if (request.url === "/mcp" && authenticated(request.headers.authorization))
    return void transport.handleRequest(request, response);
  response.writeHead(request.url === "/mcp" ? 401 : 404).end();
});
server.listen(port, host);
const stop = async () => {
  core.close();
  await transport.close();
  server.close();
};
process.once("SIGINT", () => void stop());
process.once("SIGTERM", () => void stop());
