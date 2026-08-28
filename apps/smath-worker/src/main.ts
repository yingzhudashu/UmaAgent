import { spawn } from "node:child_process";
import { mkdir, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, extname, relative, resolve } from "node:path";

const host = "127.0.0.1";
const port = Number(process.env.UMA_SMATH_WORKER_PORT ?? "3260");
const token = required("UMA_SMATH_WORKER_TOKEN");
const root = resolve(process.env.UMA_SMATH_WORKSPACE_ROOT ?? "/srv/uma-workspace/smath");
const binary = required("UMA_SMATH_BINARY");
const maxBytes = Number(process.env.UMA_SMATH_MAX_FILE_BYTES ?? 1_048_576);
const timeoutMs = Number(process.env.UMA_SMATH_TIMEOUT_MS ?? 60_000);

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function fail(status: number, error: string): never {
  const value = new Error(error) as Error & { status?: number };
  value.status = status;
  throw value;
}

function validOwner(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) fail(400, "Invalid owner");
  return value;
}

function validPath(value: unknown, required = true): string {
  if (value === undefined && !required) return ".";
  if (typeof value !== "string" || !value || value.includes("\0")) fail(400, "Invalid path");
  if (resolve("/", value).startsWith("/..") || value.split(/[\\/]/).includes(".."))
    fail(400, "Path traversal is not allowed");
  return value;
}

async function ownerRoot(ownerId: string): Promise<string> {
  const value = resolve(root, ownerId);
  if (relative(root, value).startsWith("..")) fail(400, "Invalid owner root");
  await mkdir(value, { recursive: true, mode: 0o700 });
  return realpath(value);
}

async function resolveFile(ownerId: string, path: string, create = false): Promise<string> {
  const base = await ownerRoot(ownerId);
  const target = resolve(base, path);
  if (relative(base, target).startsWith("..")) fail(400, "Path is outside user workspace");
  if (create) {
    const parent = await realpath(dirname(target)).catch(() => undefined);
    if (parent && relative(base, parent).startsWith("..")) fail(400, "Path escapes user workspace");
    return target;
  }
  const actual = await realpath(target).catch(() => fail(404, "SMath file not found"));
  if (relative(base, actual).startsWith("..")) fail(400, "Path escapes user workspace");
  return actual;
}

function worksheet(path: string): void {
  if (extname(path).toLowerCase() !== ".sm") fail(400, "Only .sm worksheets are allowed");
}

async function runSmath(input: string): Promise<string> {
  const args = ["-a", binary, "-s", input, "-t", "-w", String(timeoutMs), "-b"];
  return new Promise((resolveRun, reject) => {
    const child = spawn("xvfb-run", args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: { PATH: "/usr/bin:/bin" },
    });
    let captured = "";
    child.stdout.on("data", (value: Buffer) => {
      captured += value.toString();
    });
    child.stderr.on("data", (value: Buffer) => {
      captured += value.toString();
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.once("error", reject);
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`SMath exited with ${code}: ${captured.slice(-4000)}`));
      else resolveRun(captured.slice(-4000) || "SMath completed");
    });
  });
}

async function job(input: Record<string, unknown>) {
  const ownerId = validOwner(input.ownerId);
  const operation = input.operation;
  if (!["list", "read", "create", "update", "calculate", "delete"].includes(String(operation)))
    fail(400, "Unsupported SMath operation");
  const path = validPath(input.path, operation !== "list");
  if (operation === "list") {
    const base = await resolveFile(ownerId, path);
    const items = (await readdir(base, { recursive: true })).filter((item) => item.endsWith(".sm")).sort();
    return { operation, path, output: items.join("\n") || "No SMath worksheets" };
  }
  const file = await resolveFile(ownerId, path, operation === "create");
  worksheet(file);
  if (operation === "read") return { operation, path, output: await readFile(file, "utf8") };
  if (operation === "create" || operation === "update") {
    if (typeof input.content !== "string" || Buffer.byteLength(input.content) > maxBytes)
      fail(400, "Invalid worksheet content");
    if (operation === "create") await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    await writeFile(file, input.content, { encoding: "utf8", mode: 0o600 });
    return { operation, path, output: `${operation === "create" ? "Created" : "Updated"} ${path}` };
  }
  if (operation === "delete") {
    await rm(file);
    return { operation, path, output: `Deleted ${path}` };
  }
  if ((await stat(file)).size > maxBytes) fail(400, "Worksheet exceeds size limit");
  if (operation === "calculate") return { operation, path, output: await runSmath(file) };
  fail(400, "Unsupported SMath operation");
}

createServer(async (request, response) => {
  try {
    if (request.method !== "POST" || request.url !== "/jobs") fail(404, "Not found");
    if (request.headers.authorization !== `Bearer ${token}`) fail(401, "Unauthorized");
    let body = "";
    for await (const chunk of request) {
      body += String(chunk);
      if (Buffer.byteLength(body) > maxBytes * 2) fail(413, "Request is too large");
    }
    const result = await job(JSON.parse(body) as Record<string, unknown>);
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ result }));
  } catch (error) {
    const value = error as Error & { status?: number };
    response
      .writeHead(value.status ?? 500, { "content-type": "application/json" })
      .end(JSON.stringify({ error: value.message }));
  }
}).listen(port, host, () => process.stdout.write(`SMath worker listening on ${host}:${port}\n`));
