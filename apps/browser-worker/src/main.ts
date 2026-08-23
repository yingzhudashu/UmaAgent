import { randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { type Browser, type BrowserContext, chromium, type Page } from "playwright";
import { z } from "zod";
import { assertPublicUrl, createValidatingProxy } from "./network.js";

type Handle = { context: BrowserContext; page: Page; expiresAt: number };
const handles = new Map<string, Handle>();
let browser: Browser | undefined;
const proxy = await createValidatingProxy();

async function browserInstance(): Promise<Browser> {
  browser ??= await chromium.launch({ headless: true, args: [`--proxy-server=${proxy.url}`] });
  return browser;
}

function getHandle(id: string): Handle {
  const handle = handles.get(id);
  if (!handle || handle.expiresAt <= Date.now()) throw new Error("Browser handle is missing or expired");
  handle.expiresAt = Date.now() + 15 * 60_000;
  return handle;
}

async function closeHandle(id: string): Promise<void> {
  const handle = handles.get(id);
  handles.delete(id);
  await handle?.context.close();
}

const mcp = new McpServer({ name: "uma-browser-worker", version: "1.2.0" });
mcp.registerTool(
  "open",
  { description: "Open a public HTTP(S) page.", inputSchema: { url: z.url() } },
  async ({ url }) => {
    await assertPublicUrl(url);
    for (const [id, handle] of handles) if (handle.expiresAt <= Date.now()) await closeHandle(id);
    if (handles.size >= 4) throw new Error("Browser context limit reached");
    const context = await (await browserInstance()).newContext();
    await context.route(/^https?:\/\//, async (route) => {
      try {
        await assertPublicUrl(route.request().url());
        await route.continue();
      } catch {
        await route.abort("blockedbyclient");
      }
    });
    const page = await context.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    const handle = randomUUID();
    handles.set(handle, { context, page, expiresAt: Date.now() + 15 * 60_000 });
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ handle, url: page.url(), title: await page.title() }),
        },
      ],
    };
  },
);
mcp.registerTool(
  "extract",
  {
    description: "Extract visible text from a page or selector.",
    inputSchema: { handle: z.string(), selector: z.string().optional() },
  },
  async ({ handle, selector }) => {
    const page = getHandle(handle).page;
    const text = selector
      ? await page.locator(selector).innerText({ timeout: 10_000 })
      : await page.locator("body").innerText({ timeout: 10_000 });
    return { content: [{ type: "text", text: text.slice(0, 100_000) }] };
  },
);
mcp.registerTool(
  "click",
  { description: "Click an element.", inputSchema: { handle: z.string(), selector: z.string() } },
  async ({ handle, selector }) => {
    await getHandle(handle).page.locator(selector).click({ timeout: 10_000 });
    return { content: [{ type: "text", text: "Clicked" }] };
  },
);
mcp.registerTool(
  "fill",
  {
    description: "Fill an input element.",
    inputSchema: { handle: z.string(), selector: z.string(), value: z.string() },
  },
  async ({ handle, selector, value }) => {
    await getHandle(handle).page.locator(selector).fill(value, { timeout: 10_000 });
    return { content: [{ type: "text", text: "Filled" }] };
  },
);
mcp.registerTool(
  "screenshot",
  { description: "Capture a PNG screenshot.", inputSchema: { handle: z.string() } },
  async ({ handle }) => {
    const data = await getHandle(handle).page.screenshot({ type: "png", fullPage: false });
    return { content: [{ type: "image", data: data.toString("base64"), mimeType: "image/png" }] };
  },
);
mcp.registerTool(
  "close",
  { description: "Close a browser handle.", inputSchema: { handle: z.string() } },
  async ({ handle }) => {
    await closeHandle(handle);
    return { content: [{ type: "text", text: "Closed" }] };
  },
);

const transport = new StreamableHTTPServerTransport({
  sessionIdGenerator: undefined,
} as unknown as ConstructorParameters<typeof StreamableHTTPServerTransport>[0]);
await mcp.connect(transport as Parameters<McpServer["connect"]>[0]);
const port = Number(process.env.BROWSER_WORKER_PORT ?? 3230);
const host = process.env.BROWSER_WORKER_HOST?.trim() || "127.0.0.1";
const authToken = process.env.BROWSER_WORKER_AUTH_TOKEN?.trim();
const loopback = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]).has(host);
if (!loopback && !authToken) throw new Error("BROWSER_WORKER_AUTH_TOKEN is required for non-loopback hosts");
const authenticated = (authorization: string | undefined): boolean => {
  if (!authToken) return true;
  const actual = Buffer.from(authorization ?? "");
  const expected = Buffer.from(`Bearer ${authToken}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
};
const readJsonBody = (request: IncomingMessage): Promise<unknown> =>
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
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ status: "ok", service: "browser-worker" }));
    return;
  }
  if (request.url === "/mcp") {
    if (!authenticated(request.headers.authorization)) {
      response.writeHead(401, { "content-type": "application/json", "www-authenticate": "Bearer" });
      response.end(JSON.stringify({ error: "authentication required" }));
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
  response.writeHead(404).end();
});
server.listen(port, host);

const expiry = setInterval(() => {
  for (const [id, handle] of handles) if (handle.expiresAt <= Date.now()) void closeHandle(id);
}, 60_000);
const stop = async () => {
  clearInterval(expiry);
  for (const id of [...handles.keys()]) await closeHandle(id);
  await browser?.close();
  await proxy.close();
  await transport.close();
  server.close();
};
process.once("SIGINT", () => void stop());
process.once("SIGTERM", () => void stop());
