import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { type Browser, type BrowserContext, chromium, type Page } from "playwright";
import { z } from "zod";
import { assertPublicUrl } from "./network.js";

type Handle = { context: BrowserContext; page: Page; expiresAt: number };
const handles = new Map<string, Handle>();
let browser: Browser | undefined;

async function browserInstance(): Promise<Browser> {
  browser ??= await chromium.launch({ headless: true });
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

const mcp = new McpServer({ name: "uma-browser-worker", version: "0.7.0" });
mcp.registerTool(
  "open",
  { description: "Open a public HTTP(S) page.", inputSchema: { url: z.url() } },
  async ({ url }) => {
    await assertPublicUrl(url);
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
const server = createServer((request, response) => {
  if (request.url === "/health" && request.method === "GET") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ status: "ok", service: "browser-worker" }));
    return;
  }
  if (request.url === "/mcp") return void transport.handleRequest(request, response);
  response.writeHead(404).end();
});
server.listen(port, "127.0.0.1");

const expiry = setInterval(() => {
  for (const [id, handle] of handles) if (handle.expiresAt <= Date.now()) void closeHandle(id);
}, 60_000);
const stop = async () => {
  clearInterval(expiry);
  for (const id of [...handles.keys()]) await closeHandle(id);
  await browser?.close();
  await transport.close();
  server.close();
};
process.once("SIGINT", () => void stop());
process.once("SIGTERM", () => void stop());
