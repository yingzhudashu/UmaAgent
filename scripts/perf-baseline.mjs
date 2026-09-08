import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { availableParallelism, platform, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";

const exec = promisify(execFile);
const baseline = JSON.parse(await readFile(resolve("scripts/perf-baseline.json"), "utf8"));
const port = Number(process.env.UMA_PERF_PORT ?? 33321);
const tokenSecret = process.env.UMA_PERF_TOKEN ?? "faux-perf-token-012345678901234567890123";
const token = `uma_pat_00000000-0000-4000-8000-000000000001_${tokenSecret}`;
const stateDir = process.env.UMA_PERF_STATE
  ? resolve(process.env.UMA_PERF_STATE)
  : await mkdtemp(join(tmpdir(), `uma-perf-${process.pid}-`));

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

const base = `http://127.0.0.1:${port}/api/v15`;
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
    body: JSON.stringify({ title: "Performance baseline" }),
  });
  for (let index = 0; index < messages; index++) {
    const requestStart = performance.now();
    const accepted = await api(`/sessions/${encodeURIComponent(session.id)}/messages`, {
      method: "POST",
      body: JSON.stringify({
        messageId: `perf-${index}-${process.pid}`,
        text: "Reply with FAUX_DIRECT.",
        mode: "agent",
      }),
    });
    apiSamples.push(performance.now() - requestStart);
    const run = await waitRun(accepted.runId);
    if (run.status !== "completed")
      throw new Error(`Performance run ended as ${run.status}: ${run.error ?? "unknown"}`);
    const trace = await api(`/traces?runId=${encodeURIComponent(accepted.runId)}`);
    if (!trace.traceId || trace.spans.length < 2)
      throw new Error(`Run ${accepted.runId} has incomplete Trace`);
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
    const sizes = await Promise.all(
      ["state.db-wal", "telemetry.db-wal"].map(async (name) => {
        try {
          return (await stat(resolve(stateDir, name))).size;
        } catch (error) {
          if (error.code === "ENOENT") return 0;
          throw error;
        }
      }),
    );
    maxWal = Math.max(
      maxWal,
      sizes.reduce((sum, size) => sum + size, 0),
    );
  }
  const resources = await api("/reports/resources?from=0&limit=500");
  // 启动的毫秒级样本受系统 CPU 时钟量化影响，不作为稳定负载的峰值。
  const steadyResources = resources.filter((sample) => sample.sampleDurationMs >= 1_000);
  const duration = steadyResources.reduce((sum, sample) => sum + sample.sampleDurationMs, 0);
  const cpuAveragePercent =
    duration > 0
      ? steadyResources.reduce((sum, sample) => sum + sample.cpuPercent * sample.sampleDurationMs, 0) /
        duration
      : 0;
  const cpuPeakPercent = Math.max(0, ...steadyResources.map((sample) => sample.cpuPercent));
  const cpuAverageCorePercent = cpuAveragePercent * availableParallelism();
  const cpuPeakCorePercent = cpuPeakPercent * availableParallelism();
  const eventLoopDelayP95Ms = percentile(
    steadyResources.map((sample) => sample.eventLoopDelayMs),
    95,
  );
  const result = {
    passed:
      steadyResources.length > 0 &&
      cpuAverageCorePercent <= budgets.cpuAverageCorePercent &&
      cpuPeakCorePercent <= budgets.cpuPeakCorePercent &&
      eventLoopDelayP95Ms <= budgets.eventLoopDelayP95Ms &&
      percentile(apiSamples, 95) <= budgets.apiP95Ms &&
      percentile(eventSamples, 95) <= budgets.eventP95Ms &&
      maxRss <= budgets.rssBytes &&
      maxWal <= budgets.walBytes,
    messages,
    durationMs: Date.now() - startedAt,
    cursor,
    apiP95Ms: Number(percentile(apiSamples, 95).toFixed(2)),
    apiP50Ms: Number(percentile(apiSamples, 50).toFixed(2)),
    apiP99Ms: Number(percentile(apiSamples, 99).toFixed(2)),
    eventP95Ms: Number(percentile(eventSamples, 95).toFixed(2)),
    eventP50Ms: Number(percentile(eventSamples, 50).toFixed(2)),
    eventP99Ms: Number(percentile(eventSamples, 99).toFixed(2)),
    maxRssBytes: maxRss,
    maxWalBytes: maxWal,
    cpuAveragePercent,
    cpuPeakPercent,
    cpuAverageCorePercent,
    cpuPeakCorePercent,
    eventLoopDelayP95Ms,
    environment: { node: process.version, platform: platform(), logicalCpus: availableParallelism() },
    resources,
    dataset: {
      sessions: 1,
      requests: messages,
      durableEvents: cursor,
    },
    budgets,
  };
  console.log(JSON.stringify(result));
  if (!result.passed) process.exitCode = 1;
} finally {
  server.kill("SIGTERM");
  if (server.exitCode === null) await new Promise((resolveExit) => server.once("exit", resolveExit));
  await rm(stateDir, { recursive: true, force: true });
}
