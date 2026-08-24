import { timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { loadApprovedSkills } from "./loader.js";

const root = process.env.SKILL_WORKER_PACKAGES_DIR?.trim();
if (!root) throw new Error("SKILL_WORKER_PACKAGES_DIR is required");
const allowed = new Set(
  (process.env.SKILL_WORKER_ALLOWED_HASHES ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean),
);
if (!allowed.size) throw new Error("SKILL_WORKER_ALLOWED_HASHES is required");
const packages = await loadApprovedSkills(root, allowed);
const mcp = new McpServer({ name: "uma-skill-worker", version: "1.3.0" });
for (const pkg of packages)
  for (const tool of pkg.manifest.tools) {
    const execute = pkg.module[tool.export];
    if (typeof execute !== "function")
      throw new Error(`Missing export ${tool.export} in ${pkg.manifest.name}`);
    mcp.registerTool(
      `${pkg.manifest.name}_${tool.name}`.replace(/[^a-zA-Z0-9_-]/g, "_"),
      { description: tool.description, inputSchema: { input: z.record(z.string(), z.unknown()).optional() } },
      async ({ input }) => ({
        content: [{ type: "text", text: JSON.stringify(await execute(input ?? {})) }],
      }),
    );
  }
const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined } as never);
await mcp.connect(transport as Parameters<typeof mcp.connect>[0]);
const host = process.env.SKILL_WORKER_HOST?.trim() || "127.0.0.1";
const port = Number(process.env.SKILL_WORKER_PORT ?? 3250);
const token = process.env.SKILL_WORKER_AUTH_TOKEN?.trim();
if (!new Set(["127.0.0.1", "localhost", "::1", "[::1]"]).has(host) && !token)
  throw new Error("SKILL_WORKER_AUTH_TOKEN is required for non-loopback hosts");
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
      .end(JSON.stringify({ status: "ok", service: "skill-worker", packages: packages.length }));
    return;
  }
  if (request.url === "/mcp" && authenticated(request.headers.authorization))
    return void transport.handleRequest(request, response);
  response.writeHead(request.url === "/mcp" ? 401 : 404).end();
});
server.listen(port, host);
const stop = async () => {
  await transport.close();
  server.close();
};
process.once("SIGINT", () => void stop());
process.once("SIGTERM", () => void stop());
