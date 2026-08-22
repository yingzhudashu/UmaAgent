import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const hours = Number(process.env.UMA_SOAK_HOURS ?? 4);
const messageIntervalMs = Number(process.env.UMA_SOAK_MESSAGE_INTERVAL_MS ?? 5_000);
if (!Number.isFinite(hours) || hours <= 0 || hours > 8) throw new Error("UMA_SOAK_HOURS must be in (0, 8]");
if (!Number.isFinite(messageIntervalMs) || messageIntervalMs < 500)
  throw new Error("UMA_SOAK_MESSAGE_INTERVAL_MS must be at least 500");

const port = Number(process.env.UMA_SOAK_PORT ?? 33212);
const token = "uma-soak-token";
const stateDir = resolve(process.env.UMA_SOAK_STATE ?? ".uma-faux-soak");
await mkdir(stateDir, { recursive: true });
const server = spawn(process.execPath, ["scripts/faux-server.mjs"], {
  cwd: resolve("."),
  env: {
    ...process.env,
    UMA_FAUX_PORT: String(port),
    UMA_FAUX_TOKEN: token,
    UMA_FAUX_STATE: stateDir,
    UMA_FAUX_RESET_STATE: "1",
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

const baseUrl = `http://127.0.0.1:${port}/api/v10`;
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

let schedule;
try {
  await waitReady();
  const session = await api("/sessions", {
    method: "POST",
    body: JSON.stringify({ mode: "assistant", title: "Faux soak" }),
  });
  schedule = await api("/schedules", {
    method: "POST",
    body: JSON.stringify({
      name: "Faux soak interval",
      prompt: "Reply with FAUX_DIRECT.",
      sessionMode: "assistant",
      schedule: { kind: "interval", everyMs: 60_000 },
      enabled: true,
    }),
  });
  const startedAt = Date.now();
  const deadline = startedAt + hours * 60 * 60_000;
  const baselineRss = await residentBytes(server.pid);
  if (baselineRss > 256 * 1024 * 1024) throw new Error(`Idle Core RSS exceeded 256 MiB (${baselineRss})`);
  let maxRss = baselineRss;
  let maxWalBytes = 0;
  let cursor = 0;
  let messages = 0;
  let lastResourceSample = 0;
  while (Date.now() < deadline) {
    const accepted = await api(`/sessions/${encodeURIComponent(session.id)}/messages`, {
      method: "POST",
      body: JSON.stringify({ messageId: randomUUID(), text: "Reply with FAUX_DIRECT.", mode: "direct" }),
    });
    const run = await waitRun(accepted.runId);
    if (run.status !== "completed")
      throw new Error(`Soak Run ended as ${run.status}: ${run.error ?? "unknown"}`);
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
      try {
        maxWalBytes = Math.max(maxWalBytes, (await stat(resolve(stateDir, "state.db-wal"))).size);
      } catch {
        // SQLite may checkpoint and remove an empty WAL between samples.
      }
      const runs = await api(`/schedules/${encodeURIComponent(schedule.id)}/runs`);
      const occurrences = runs.map((item) => item.scheduledFor);
      if (new Set(occurrences).size !== occurrences.length)
        throw new Error("Duplicate schedule occurrence detected");
      if (maxRss > baselineRss * 1.1)
        throw new Error(`Resident memory grew by more than 10% (${baselineRss} -> ${maxRss})`);
      if (maxWalBytes > 256 * 1024 * 1024) throw new Error(`SQLite WAL exceeded 256 MiB (${maxWalBytes})`);
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, messageIntervalMs));
  }
  console.log(
    JSON.stringify({
      passed: true,
      durationMs: Date.now() - startedAt,
      messages,
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
}
