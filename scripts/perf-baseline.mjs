import { execFile, spawn } from "node:child_process";
import { mkdir, readFile, rm, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";

const exec = promisify(execFile);
const baseline = JSON.parse(await readFile(resolve("scripts/perf-baseline.json"), "utf8"));
const port = Number(process.env.UMA_PERF_PORT ?? 33321);
const tokenSecret = process.env.UMA_PERF_TOKEN ?? "faux-perf-token-012345678901234567890123";
const token = `uma_pat_00000000-0000-4000-8000-000000000001_${tokenSecret}`;
const stateDir = resolve(process.env.UMA_PERF_STATE ?? `.uma-perf-${process.pid}`);
const requireBudget = process.env.UMA_PERF_REQUIRE === "1";
const messages = Number(process.env.UMA_PERF_MESSAGES ?? baseline.smokeMessages);
const budgets = baseline.budgets;

if (!Number.isInteger(messages) || messages < 1 || messages > 100_000)
  throw new Error("UMA_PERF_MESSAGES must be an integer between 1 and 100000");

await rm(stateDir, { recursive: true, force: true });
await mkdir(stateDir, { recursive: true });
const server = spawn(process.execPath, ["scripts/faux-server.mjs"], {
  cwd: resolve("."),
  env: {
    ...process.env,
    UMA_FAUX_PORT: String(port),
    UMA_FAUX_TOKEN: tokenSecret,
    UMA_FAUX_STATE: stateDir,
    UMA_FAUX_RESET_STATE: "1",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let output = "";
server.stdout.on("data", (chunk) => {
  output = `${output}${chunk}`.slice(-10_000);
});
server.stderr.on("data", (chunk) => {
  output = `${output}${chunk}`.slice(-10_000);
});

const base = `http://127.0.0.1:${port}/api/v11`;
async function api(path, options = {}) {
  const response = await fetch(`${base}${path}`, {
    ...options,
    headers: {
      authorization: `Bearer ${token}`,
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...options.headers,
    },
  });
  if (!response.ok)
    throw new Error(`${options.method ?? "GET"} ${path}: ${response.status} ${await response.text()}`);
  return response.status === 204 ? undefined : response.json();
}

async function waitReady() {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (server.exitCode !== null) throw new Error(`Faux Core exited early:\n${output}`);
    try {
      if ((await fetch(`${base}/health/ready`)).ok) return;
    } catch {
      // Startup is still in progress.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error(`Faux Core did not become ready:\n${output}`);
}

async function waitRun(runId) {
  for (let attempt = 0; attempt < 600; attempt++) {
    const run = await api(`/runs/${encodeURIComponent(runId)}`);
    if (["completed", "failed", "cancelled", "interrupted", "awaiting_input"].includes(run.status))
      return run;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
  }
  throw new Error(`Run ${runId} did not reach a terminal state`);
}

async function residentBytes(pid) {
  if (process.platform === "win32") {
    const { stdout } = await exec("powershell", [
      "-NoProfile",
      "-Command",
      `(Get-Process -Id ${pid}).WorkingSet64`,
    ]);
    return Number(stdout.trim());
  }
  if (process.platform === "linux") {
    const status = await readFile(`/proc/${pid}/status`, "utf8");
    return Number(status.match(/^VmRSS:\s+(\d+)/m)?.[1] ?? 0) * 1024;
  }
  const { stdout } = await exec("ps", ["-o", "rss=", "-p", String(pid)]);
  return Number(stdout.trim()) * 1024;
}

function percentile(values, percentileValue) {
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.min(ordered.length - 1, Math.ceil((percentileValue / 100) * ordered.length) - 1)] ?? 0;
}

let session;
const apiSamples = [];
const eventSamples = [];
let cursor = 0;
let maxRss = 0;
let maxWal = 0;
const startedAt = Date.now();
try {
  await waitReady();
  session = await api("/sessions", {
    method: "POST",
    body: JSON.stringify({ mode: "assistant", title: "Performance baseline" }),
  });
  for (let index = 0; index < messages; index++) {
    const requestStart = performance.now();
    const accepted = await api(`/sessions/${encodeURIComponent(session.id)}/messages`, {
      method: "POST",
      body: JSON.stringify({
        messageId: `perf-${index}-${process.pid}`,
        text: "Reply with FAUX_DIRECT.",
        mode: "direct",
      }),
    });
    apiSamples.push(performance.now() - requestStart);
    const run = await waitRun(accepted.runId);
    if (run.status !== "completed")
      throw new Error(`Performance run ended as ${run.status}: ${run.error ?? "unknown"}`);
    for (;;) {
      const eventStart = performance.now();
      const page = await api(`/sessions/${encodeURIComponent(session.id)}/events?after=${cursor}&limit=1000`);
      eventSamples.push(performance.now() - eventStart);
      for (const event of page.events) {
        if (event.sequence !== cursor + 1)
          throw new Error(`Session cursor gap: expected ${cursor + 1}, got ${event.sequence}`);
        cursor = event.sequence;
      }
      if (!page.hasMore) break;
    }
    maxRss = Math.max(maxRss, await residentBytes(server.pid));
    try {
      maxWal = Math.max(maxWal, (await stat(resolve(stateDir, "state.db-wal"))).size);
    } catch {
      // SQLite may checkpoint an empty WAL between samples.
    }
  }
  const result = {
    passed:
      percentile(apiSamples, 95) <= budgets.apiP95Ms &&
      percentile(eventSamples, 95) <= budgets.eventP95Ms &&
      maxRss <= budgets.rssBytes &&
      maxWal <= budgets.walBytes,
    messages,
    durationMs: Date.now() - startedAt,
    cursor,
    apiP95Ms: Number(percentile(apiSamples, 95).toFixed(2)),
    eventP95Ms: Number(percentile(eventSamples, 95).toFixed(2)),
    maxRssBytes: maxRss,
    maxWalBytes: maxWal,
    dataset: baseline.dataset,
    budgets,
  };
  console.log(JSON.stringify(result));
  if (requireBudget && !result.passed) process.exitCode = 1;
} finally {
  server.kill("SIGTERM");
  await new Promise((resolveExit) => server.once("exit", resolveExit));
  await rm(stateDir, { recursive: true, force: true });
}
