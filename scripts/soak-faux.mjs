import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const { budgets } = JSON.parse(await readFile(resolve("scripts/perf-baseline.json"), "utf8"));
const hours = Number(process.env.UMA_SOAK_HOURS ?? 4);
const messageIntervalMs = Number(process.env.UMA_SOAK_MESSAGE_INTERVAL_MS ?? 5_000);
if (!Number.isFinite(hours) || hours <= 0 || hours > 8) throw new Error("UMA_SOAK_HOURS must be in (0, 8]");
if (!Number.isFinite(messageIntervalMs) || messageIntervalMs < 500)
  throw new Error("UMA_SOAK_MESSAGE_INTERVAL_MS must be at least 500");

const port = Number(process.env.UMA_SOAK_PORT ?? 33212);
// 一条消息可能经过分类、契约、主模型和记忆提取等多个模型阶段，预算按阶段上限预留。
const responseBudget = Math.ceil((hours * 60 * 60_000) / messageIntervalMs) * 12 + 100;
const tokenSecret = "faux-soak-token-012345678901234567890123";
const token = `uma_pat_00000000-0000-4000-8000-000000000001_${tokenSecret}`;
const stateDir = process.env.UMA_SOAK_STATE
  ? resolve(process.env.UMA_SOAK_STATE)
  : await mkdtemp(join(tmpdir(), `uma-soak-${process.pid}-`));
await mkdir(stateDir, { recursive: true });
const server = spawn(process.execPath, ["scripts/faux-server.mjs"], {
  cwd: resolve("."),
  env: {
    ...process.env,
    UMA_FAUX_PORT: String(port),
    UMA_FAUX_TOKEN: tokenSecret,
    UMA_FAUX_STATE: stateDir,
    UMA_FAUX_RESET_STATE: "1",
    UMA_FAUX_RESPONSES: String(responseBudget),
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let serverOutput = "";
server.stdout.on("data", (chunk) => {
  serverOutput = `${serverOutput}${chunk}`.slice(-20_000);
});
server.stderr.on("data", (chunk) => {
  serverOutput = `${serverOutput}${chunk}`.slice(-20_000);
});

const baseUrl = `http://127.0.0.1:${port}/api/v15`;
async function api(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      authorization: `Bearer ${token}`,
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...options.headers,
    },
  });
  if (!response.ok)
    throw new Error(`${options.method ?? "GET"} ${path}: HTTP ${response.status} ${await response.text()}`);
  if (response.status === 204) return undefined;
  return response.json();
}

async function waitReady() {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (server.exitCode !== null) throw new Error(`Faux Core exited early:\n${serverOutput}`);
    try {
      const response = await fetch(`${baseUrl}/health/ready`);
      if (response.ok) return;
    } catch {
      // Startup is still in progress.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error(`Faux Core did not become ready:\n${serverOutput}`);
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
    const { readFile } = await import("node:fs/promises");
    const status = await readFile(`/proc/${pid}/status`, "utf8");
    return Number(status.match(/^VmRSS:\s+(\d+)/m)?.[1] ?? 0) * 1024;
  }
  const { stdout } = await exec("ps", ["-o", "rss=", "-p", String(pid)]);
  return Number(stdout.trim()) * 1024;
}

async function waitRun(runId) {
  for (let attempt = 0; attempt < 600; attempt++) {
    const run = await api(`/runs/${encodeURIComponent(runId)}`);
    if (["completed", "failed", "cancelled", "interrupted", "awaiting_input"].includes(run.status))
      return run;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error(`Run ${runId} did not reach a terminal state`);
}

async function completeMessage(sessionId) {
  const accepted = await api(`/sessions/${encodeURIComponent(sessionId)}/messages`, {
    method: "POST",
    body: JSON.stringify({ messageId: randomUUID(), text: "Reply with FAUX_DIRECT.", mode: "agent" }),
  });
  const run = await waitRun(accepted.runId);
  if (run.status !== "completed")
    throw new Error(`Soak Run ended as ${run.status}: ${run.error ?? "unknown"}`);
}

let schedule;
try {
  await waitReady();
  const session = await api("/sessions", {
    method: "POST",
    body: JSON.stringify({ title: "Faux soak" }),
  });
  schedule = await api("/schedules", {
    method: "POST",
    body: JSON.stringify({
      name: "Faux soak interval",
      prompt: "Reply with FAUX_DIRECT.",
      messageMode: "agent",
      schedule: { kind: "interval", everyMs: 60_000 },
      enabled: true,
    }),
  });
  // 预热模型、SQLite 页面与 Trace 写入路径后再建立 RSS 基线，
  // 避免把一次性初始化成本误判为长期常驻内存泄漏。
  for (let index = 0; index < 3; index++) await completeMessage(session.id);
  const startedAt = Date.now();
  const deadline = startedAt + hours * 60 * 60_000;
  const baselineRss = await residentBytes(server.pid);
  if (baselineRss > budgets.rssBytes) throw new Error(`Idle Core RSS exceeded budget (${baselineRss})`);
  let maxRss = baselineRss;
  let maxWalBytes = 0;
  let cursor = 0;
  let messages = 0;
  let lastResourceSample = 0;
  while (Date.now() < deadline) {
    await completeMessage(session.id);
    for (;;) {
      const page = await api(`/sessions/${encodeURIComponent(session.id)}/events?after=${cursor}&limit=1000`);
      for (const event of page.events) {
        if (event.sequence !== cursor + 1)
          throw new Error(`Session cursor gap: expected ${cursor + 1}, received ${event.sequence}`);
        cursor = event.sequence;
      }
      if (!page.hasMore) break;
    }
    messages++;
    if (Date.now() - lastResourceSample >= 60_000 || lastResourceSample === 0) {
      lastResourceSample = Date.now();
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
      maxWalBytes = Math.max(
        maxWalBytes,
        sizes.reduce((sum, size) => sum + size, 0),
      );
      const runs = await api(`/schedules/${encodeURIComponent(schedule.id)}/runs`);
      const occurrences = runs.map((item) => item.scheduledFor);
      if (new Set(occurrences).size !== occurrences.length)
        throw new Error("Duplicate schedule occurrence detected");
      if (maxRss > budgets.rssBytes) throw new Error(`Core RSS exceeded budget (${maxRss})`);
      if (maxRss > baselineRss * 1.6)
        throw new Error(`Resident memory grew by more than 60% (${baselineRss} -> ${maxRss})`);
      if (maxWalBytes > budgets.walBytes)
        throw new Error(`Combined SQLite WAL exceeded budget (${maxWalBytes})`);
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, messageIntervalMs));
  }
  console.log(
    JSON.stringify({
      passed: true,
      durationMs: Date.now() - startedAt,
      messages,
      sessions: 1,
      lastSequence: cursor,
      baselineRss,
      maxRss,
      maxWalBytes,
    }),
  );
} finally {
  if (schedule) {
    try {
      await api(`/schedules/${encodeURIComponent(schedule.id)}`, { method: "DELETE" });
    } catch {
      // The child may already have failed; shutdown still must continue.
    }
  }
  server.kill("SIGTERM");
  await new Promise((resolveExit) => {
    if (server.exitCode !== null) resolveExit();
    else server.once("exit", resolveExit);
  });
  await rm(stateDir, { recursive: true, force: true });
}
