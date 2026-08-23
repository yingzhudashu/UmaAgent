import { randomUUID, timingSafeEqual } from "node:crypto";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Request, Response } from "express";
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
transport.onerror = (error) => console.error("MCP transport error", error);
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
const app = createMcpExpressApp({ host });
app.get("/health", (_request: Request, response: Response) => {
  response.json({ status: "ok", service: "browser-worker" });
});
app.all("/mcp", async (request: Request, response: Response) => {
  if (!authenticated(request.headers.authorization)) {
    response.status(401).set("www-authenticate", "Bearer").json({ error: "authentication required" });
    return;
  }
  try {
    await transport.handleRequest(request, response, request.body);
  } catch (error) {
    console.error("MCP request failed", error);
    if (!response.headersSent) response.status(500).end();
  }
});
const server = app.listen(port, host);

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
