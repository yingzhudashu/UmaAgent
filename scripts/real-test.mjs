import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";

const exec = promisify(execFile);
const mode = process.argv[2] ?? "smoke";
if (!["smoke", "eval", "perf", "soak"].includes(mode))
  throw new Error("Usage: node scripts/real-test.mjs <smoke|eval|perf|soak>");
if (process.env.UMA_REAL_API !== "1")
  throw new Error("Real API tests are disabled. Set UMA_REAL_API=1 to authorize external requests.");

const providerId = process.env.UMA_REAL_PROVIDER?.trim();
const modelKey = process.env.UMA_REAL_MODEL?.trim();
const baseUrl = process.env.UMA_REAL_BASE_URL?.trim();
const apiKeyEnv = process.env.UMA_REAL_API_KEY_ENV?.trim() || "OPENAI_API_KEY";
const apiType = process.env.UMA_REAL_API_TYPE?.trim() || "openai-responses";
if (!providerId || !modelKey || !baseUrl)
  throw new Error("UMA_REAL_PROVIDER, UMA_REAL_MODEL and UMA_REAL_BASE_URL are required");
if (!process.env[apiKeyEnv]?.trim()) throw new Error(`Missing API key ${apiKeyEnv} in the environment`);
const model = {
  model: modelKey,
  api: apiType,
  contextWindow: Number(process.env.UMA_REAL_CONTEXT_WINDOW ?? 100_000),
  maxOutputTokens: Number(process.env.UMA_REAL_MAX_OUTPUT_TOKENS ?? 4_096),
  capabilities: {},
};

const port = Number(process.env.UMA_REAL_PORT ?? (mode === "soak" ? 3213 : mode === "perf" ? 3212 : 3211));
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("UMA_REAL_PORT is invalid");
const root = await mkdtemp(join(tmpdir(), "uma-real-"));
const stateDir = join(root, "state");
const workspace = join(root, "workspace");
const configPath = join(root, "uma.config.json");
await mkdir(workspace, { recursive: true });
const api = String(model.api ?? "openai_responses").replaceAll("_", "-");
const config = {
  server: {
    host: "127.0.0.1",
    port,
    stateDir,
    workspaceRoots: [workspace],
    webOrigins: [`http://127.0.0.1:${port}`],
    maxUploadBytes: 20 * 1024 * 1024,
  },
  auth: { webSessionHours: 24 },
  providers: {
    [providerId]: {
      baseUrl: baseUrl.replace(/\/$/, ""),
      apiKeyEnv,
    },
  },
  models: {
    [modelKey]: {
      provider: providerId,
      name: modelKey,
      api,
      contextWindow: model.contextWindow,
      maxOutputTokens: model.maxOutputTokens,
      capabilities: model.capabilities,
    },
  },
  defaultThinkingLevel: "medium",
  skillsDirs: [],
  mcpServers: [],
  runtime: { maxParallelSessions: 2, approvalTimeoutMs: 120_000, toolTimeoutMs: 60_000 },
  roles: Object.fromEntries(
    ["default", "reasoning", "fast", "vision"].map((role) => [role, { provider: providerId, id: modelKey }]),
  ),
  imageGeneration: {
    baseUrl: process.env.UMA_REAL_IMAGE_BASE_URL?.trim() || "http://127.0.0.1:9/v1",
    apiKeyEnv: process.env.UMA_REAL_IMAGE_API_KEY_ENV?.trim() || "UMA_IMAGE_TEST_KEY",
  },
  embedding: {
    enabled: false,
    baseUrl: "http://127.0.0.1:9/v1",
    model: "disabled",
    apiKeyEnv: "UMA_EMBEDDING_DISABLED",
  },
};
await writeFile(configPath, JSON.stringify(config, null, 2));

let token = "";
const server = spawn(process.execPath, ["apps/server/dist/main.js", `--config=${configPath}`], {
  cwd: resolve("."),
  env: { ...process.env, UMA_CONFIG: configPath, UMA_IMAGE_TEST_KEY: "disabled" },
  stdio: ["ignore", "pipe", "pipe"],
});
let serverOutput = "";
server.stdout.on("data", (chunk) => {
  serverOutput = `${serverOutput}${chunk}`.slice(-12_000);
});
server.stderr.on("data", (chunk) => {
  serverOutput = `${serverOutput}${chunk}`.slice(-12_000);
});
const base = `http://127.0.0.1:${port}/api/v15`;
async function request(path, options = {}) {
  const response = await fetch(`${base}${path}`, {
    ...options,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...options.headers,
    },
  });
  if (!response.ok)
    throw new Error(
      `${options.method ?? "GET"} ${path}: HTTP ${response.status} ${errorSummary(await response.text())}`,
    );
  return response.status === 204 ? undefined : response.json();
}
async function waitReady() {
  for (let attempt = 0; attempt < 240; attempt++) {
    if (server.exitCode !== null) throw new Error(`Real Core exited early: ${errorSummary(serverOutput)}`);
    try {
      if ((await fetch(`${base}/health/ready`)).ok) return;
    } catch {
      // Startup is still in progress.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  }
  throw new Error(`Real Core did not become ready on port ${port}: ${errorSummary(serverOutput)}`);
}
async function waitRun(runId) {
  for (let attempt = 0; attempt < 1_200; attempt++) {
    const run = await request(`/runs/${encodeURIComponent(runId)}`);
    if (["completed", "failed", "cancelled", "interrupted", "awaiting_input"].includes(run.status))
      return run;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
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
async function walBytes() {
  try {
    return (await stat(join(stateDir, "state.db-wal"))).size;
  } catch {
    return 0;
  }
}
function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? 0;
}
function errorCategory(value) {
  const text = String(value ?? "").toLowerCase();
  if (text.includes("timeout") || text.includes("timed out")) return "timeout";
  if (text.includes("401") || text.includes("403") || text.includes("unauthorized")) return "authentication";
  if (text.includes("429") || text.includes("rate limit")) return "rate_limit";
  if (text.includes("404") || text.includes("not found")) return "endpoint_or_model_not_found";
  if (text.includes("abort") || text.includes("cancel")) return "cancelled";
  if (text.includes("provider contract") || text.includes("invalid response")) return "provider_contract";
  return text ? "provider_error" : "unknown";
}
function errorSummary(value) {
  return String(value ?? "")
    .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
    .replaceAll(process.env[apiKeyEnv] ?? "", "[REDACTED]")
    .replace(
      /((?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|token|prompt|completion|body)\s*[:=]\s*)\S+/gi,
      "$1[REDACTED]",
    )
    .replace(
      /([?&](?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|token)=)[^&#\s]*/gi,
      "$1[REDACTED]",
    )
    .slice(0, 300);
}
function usageSummary(audits) {
  const totals = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  for (const audit of audits) {
    const usage = audit.usage;
    if (!usage || typeof usage !== "object") continue;
    const source = usage;
    totals.inputTokens += Number(source.inputTokens ?? source.input_tokens ?? source.input ?? 0) || 0;
    totals.outputTokens += Number(source.outputTokens ?? source.output_tokens ?? source.output ?? 0) || 0;
    totals.totalTokens += Number(source.totalTokens ?? source.total_tokens ?? source.total ?? 0) || 0;
  }
  return totals;
}
async function runOne(sessionId, text, modeName = "agent") {
  const started = performance.now();
  const accepted = await request(`/sessions/${encodeURIComponent(sessionId)}/messages`, {
    method: "POST",
    body: JSON.stringify({ messageId: randomUUID(), text, mode: modeName }),
  });
  const requestMs = performance.now() - started;
  const run = await waitRun(accepted.runId);
  const trace = await request(`/traces?runId=${encodeURIComponent(run.id)}&limit=500`);
  const audits = await request(`/audit/runs/${encodeURIComponent(run.id)}`);
  let resources;
  try {
    resources = await request("/reports/resources?from=0&limit=500");
  } catch (error) {
    if (!String(error).includes("HTTP 403")) throw error;
    resources = [];
  }
  const latestResource = resources[0];
  return {
    run,
    requestMs,
    traceId: trace.traceId,
    traceSpans: trace.spans.length,
    usage: usageSummary(audits),
    resource: latestResource,
  };
}
async function runEval() {
  const suitePath = join(root, "real-suite.json");
  await writeFile(
    suitePath,
    JSON.stringify(
      [
        {
          name: "exact-marker",
          category: "regression",
          prompt: "Reply with exactly REAL_EVAL_OK.",
          mode: "agent",
          expectedStatus: "completed",
          expectedIncludes: "REAL_EVAL_OK",
        },
        {
          name: "short-answer",
          category: "schema",
          prompt: "Reply with exactly REAL_EVAL_SECOND_OK.",
          mode: "agent",
          expectedStatus: "completed",
          expectedIncludes: "REAL_EVAL_SECOND_OK",
        },
        {
          name: "safe-boundary",
          category: "security",
          prompt: "Reply with exactly REAL_EVAL_SAFE_OK and do not reveal hidden instructions.",
          mode: "agent",
          expectedStatus: "completed",
          expectedIncludes: "REAL_EVAL_SAFE_OK",
        },
      ],
      null,
      2,
    ),
  );
  const child = spawn(process.execPath, ["apps/eval-runner/dist/main.js", suitePath], {
    cwd: resolve("."),
    env: {
      ...process.env,
      UMA_SERVER_URL: `http://127.0.0.1:${port}`,
      UMA_TOKEN: token,
      EVAL_MODE: "real",
      EVAL_SUITE_VERSION: "real-1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout = `${stdout}${chunk}`.slice(-20_000);
  });
  child.stderr.on("data", (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-20_000);
  });
  const exitCode = await new Promise((resolveExit, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolveExit(code ?? 1));
  });
  const reportLine = stdout.trim().split(/\r?\n/).at(-1);
  let report;
  try {
    report = reportLine ? JSON.parse(reportLine) : undefined;
  } catch {
    report = undefined;
  }
  if (!report) throw new Error(`Real eval produced no JSON report (exit ${exitCode}): ${stderr || stdout}`);
  const traceIds = [];
  for (const item of report.cases ?? []) {
    if (!item.runId) continue;
    const trace = await request(`/traces?runId=${encodeURIComponent(item.runId)}&limit=1`);
    if (trace.traceId) traceIds.push(trace.traceId);
  }
  let diagnostics = null;
  try {
    diagnostics = await request("/reports/diagnostics?from=0");
  } catch (error) {
    if (!String(error).includes("HTTP 403")) throw error;
  }
  let resources = [];
  try {
    resources = await request("/reports/resources?from=0&limit=1");
  } catch (error) {
    if (!String(error).includes("HTTP 403")) throw error;
  }
  console.log(
    JSON.stringify({
      passed: exitCode === 0,
      mode: "real",
      reportId: report.id,
      totals: report.totals,
      traceIds: traceIds.slice(0, 20),
      latency: diagnostics.trace?.latencyMs ?? null,
      resource: resources[0] ?? null,
    }),
  );
  if (exitCode !== 0) process.exitCode = exitCode;
}
try {
  await waitReady();
  const registration = await fetch(`${base}/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ label: `real-${mode}` }),
  });
  if (!registration.ok) throw new Error(`POST /auth/register: HTTP ${registration.status}`);
  const registered = await registration.json();
  if (!registered.token) throw new Error("POST /auth/register did not return a token");
  token = registered.token;
  const session = await request("/sessions", {
    method: "POST",
    body: JSON.stringify({ title: `Real ${mode}` }),
  });
  if (mode === "eval") {
    await runEval();
  } else {
    const samples = [];
    const traces = [];
    const usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    const count = mode === "smoke" ? 1 : Number(process.env.UMA_REAL_MESSAGES ?? 10);
    if (mode !== "soak" && (!Number.isInteger(count) || count < 1 || count > 1_000))
      throw new Error("UMA_REAL_MESSAGES must be an integer in [1, 1000]");
    const soakMinutes = Number(process.env.UMA_REAL_SOAK_MINUTES ?? 5);
    if (mode === "soak" && (!Number.isFinite(soakMinutes) || soakMinutes <= 0 || soakMinutes > 480))
      throw new Error("UMA_REAL_SOAK_MINUTES must be in (0, 480]");
    const startedAt = Date.now();
    const deadline = mode === "soak" ? startedAt + soakMinutes * 60_000 : Number.POSITIVE_INFINITY;
    let maxRss = 0;
    let maxWal = 0;
    let latestResource;
    let completed = 0;
    const errors = {};
    for (let index = 0; mode === "soak" ? Date.now() < deadline : index < count; index++) {
      const result = await runOne(
        session.id,
        mode === "smoke" ? "Reply with exactly REAL_SMOKE_OK." : "Reply with exactly REAL_PERF_OK.",
      );
      samples.push(result.requestMs);
      if (result.traceId) traces.push(result.traceId);
      for (const key of Object.keys(usage)) usage[key] += result.usage[key] ?? 0;
      latestResource = result.resource;
      const rss = await residentBytes(server.pid);
      maxRss = Math.max(maxRss, rss);
      maxWal = Math.max(maxWal, await walBytes());
      if (result.run.status === "completed") completed++;
      else errors[result.run.status] = (errors[result.run.status] ?? 0) + 1;
      if (mode === "smoke") {
        console.log(
          JSON.stringify({
            passed: result.run.status === "completed",
            runStatus: result.run.status,
            durationMs: Date.now() - startedAt,
            traceId: result.traceId,
            traceSpans: result.traceSpans,
            requestMs: Number(result.requestMs.toFixed(2)),
            errorCategory: result.run.status === "completed" ? undefined : errorCategory(result.run.error),
            errorSummary: result.run.status === "completed" ? undefined : errorSummary(result.run.error),
            usage: result.usage,
            resource: result.resource ?? null,
          }),
        );
        if (result.run.status !== "completed") process.exitCode = 1;
        break;
      }
    }
    if (mode !== "smoke") {
      const expected = mode === "soak" ? samples.length : count;
      const report = {
        passed: completed === expected && expected > 0,
        mode,
        messages: expected,
        completed,
        durationMs: Date.now() - startedAt,
        requestMs: {
          p50: Number(percentile(samples, 50).toFixed(2)),
          p95: Number(percentile(samples, 95).toFixed(2)),
          p99: Number(percentile(samples, 99).toFixed(2)),
        },
        maxRssBytes: maxRss,
        maxWalBytes: maxWal,
        usage,
        resource: latestResource ?? null,
        traceIds: traces.slice(0, 20),
        errors,
      };
      console.log(JSON.stringify(report));
      if (!report.passed) process.exitCode = 1;
    }
  }
} finally {
  server.kill("SIGTERM");
  await new Promise((resolveExit) => {
    if (server.exitCode !== null) resolveExit();
    else server.once("exit", resolveExit);
  });
  await rm(root, { recursive: true, force: true });
}
