import { timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import * as lark from "@larksuiteoapi/node-sdk";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { UmaClient } from "@uma-agent/client";
import { createFeishuMcp, type FeishuBusinessGateway, retryFeishuOperation } from "./service.js";

const required = (name: string) => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
};
const sdk = new lark.Client({ appId: required("FEISHU_APP_ID"), appSecret: required("FEISHU_APP_SECRET") });
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
const core = new UmaClient({ baseUrl: required("UMA_SERVER_URL"), token: required("UMA_TOKEN") });
const mcp = createFeishuMcp({ gateway, core });
const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined } as never);
transport.onerror = (error) => console.error("MCP transport error", error);
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
const readJsonBody = (request: import("node:http").IncomingMessage): Promise<unknown> =>
  new Promise((resolve, reject) => {
    if (request.method !== "POST") return resolve(undefined);
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 2_000_000) reject(new Error("MCP request body is too large"));
    });
    request.on("end", () => {
      if (!body) return resolve(undefined);
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error("Invalid MCP JSON body"));
      }
    });
    request.on("error", reject);
  });
const server = createServer((request, response) => {
  if (request.url === "/health" && request.method === "GET") {
    response
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({ status: "ok", service: "feishu-mcp" }));
    return;
  }
  if (request.url === "/mcp") {
    if (!authenticated(request.headers.authorization)) {
      response.writeHead(401).end();
      return;
    }
    void readJsonBody(request)
      .then((body) => transport.handleRequest(request, response, body))
      .catch(() => {
        if (!response.headersSent) response.writeHead(400, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "invalid MCP request" }));
      });
    return;
  }
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
