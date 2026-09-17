import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// 扩展负载保持独立报告，不改变 20 条请求的固定预算或四小时 soak。
const output = resolve("artifacts/acceptance", `load-${Date.now()}`);
await mkdir(output, { recursive: true });
const stateDir = await mkdtemp(join(tmpdir(), "uma-load-"));
const port = Number(process.env.UMA_LOAD_PORT ?? 33224);
// 每次运行独立凭据；端口被别的验收占用时不得写入另一轮的状态。
const tokenSecret = randomUUID();
const token = `uma_pat_00000000-0000-4000-8000-000000000001_${tokenSecret}`;
const server = spawn(process.execPath, ["--max-semi-space-size=4", "scripts/faux-server.mjs"], {
  env: {
    ...process.env,
    UMA_FAUX_PORT: String(port),
    UMA_FAUX_TOKEN: tokenSecret,
    UMA_FAUX_STATE: stateDir,
    UMA_FAUX_RESPONSES: "10000",
  },
  stdio: ["ignore", "ignore", "pipe"],
});
let stderr = "";
server.stderr.on("data", (data) => {
  stderr = `${stderr}${data}`.slice(-4000);
});
const base = `http://127.0.0.1:${port}/api/v16`;
const pause = (ms) => new Promise((done) => setTimeout(done, ms));
async function api(path, body) {
  const response = await fetch(base + path, {
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(body ? { method: "POST", body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(15000),
  });
  assert(response.ok, `${path}: HTTP ${response.status}`);
  return response.json();
}
const phases = [];
async function run(sessionId, text) {
  const accepted = await api(`/sessions/${sessionId}/messages`, {
    messageId: randomUUID(),
    text,
    mode: "agent",
  });
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    const value = await api(`/runs/${accepted.runId}`);
    if (value.status === "completed") {
      const trace = await api(`/traces?runId=${value.id}`);
      assert(trace.traceId && trace.spans.length >= 2, "每个 Run 必须保留链路");
      return value;
    }
    assert(
      !["failed", "cancelled", "interrupted", "awaiting_input", "awaiting_confirmation"].includes(
        value.status,
      ),
      `Run ${value.id}: ${value.status}`,
    );
    await pause(40);
  }
  throw new Error(`Run ${accepted.runId} timed out`);
}
async function phase(name, operation) {
  const started = performance.now();
  const result = await operation();
  const resources = await api("/reports/resources?from=0&limit=1");
  const row = { name, durationMs: performance.now() - started, ...result, resource: resources[0] };
  phases.push(row);
  console.log(JSON.stringify(row));
}
let passed = false;
try {
  let ready = false;
  for (let i = 0; i < 200; i++) {
    assert(server.exitCode === null, `服务意外退出：${stderr}`);
    try {
      ready = (await fetch(`${base}/health/ready`)).ok;
    } catch {
      /* 启动尚未完成。 */
    }
    if (ready) break;
    await pause(100);
  }
  assert(ready, "隔离服务必须就绪");
  await api("/auth/me");
  const history = await api("/sessions", { title: "Long history acceptance" });
  await phase("long-history", async () => {
    for (let i = 0; i < 100; i++) await run(history.id, `History sample ${i}: FAUX_DIRECT`);
    let cursor = 0;
    let pages = 0;
    for (;;) {
      const page = await api(`/sessions/${history.id}/events?after=${cursor}&limit=37`);
      for (const event of page.events) assert.equal(event.sequence, ++cursor, "跨页事件必须连续");
      pages++;
      if (!page.hasMore) break;
    }
    const snapshot = await api(`/sessions/${history.id}/snapshot`);
    assert(JSON.stringify(snapshot).includes("History sample 99"), "末条消息必须可读取");
    return { requests: 100, events: cursor, pages };
  });
  await phase("concurrent-sessions", async () => {
    const sessions = await Promise.all(
      Array.from({ length: 4 }, (_, i) => api("/sessions", { title: `Concurrent ${i}` })),
    );
    await Promise.all(
      sessions.map(async (session) => {
        for (let i = 0; i < 8; i++) await run(session.id, `Parallel request ${i}`);
      }),
    );
    return { sessions: 4, requests: 32 };
  });
  await phase("large-reply", async () => {
    const session = await api("/sessions", { title: "Large reply" });
    await run(session.id, "FAUX_LARGE_REPLY");
    const snapshot = await api(`/sessions/${session.id}/snapshot`);
    const body = snapshot.transcript.find(
      (item) => item.role === "assistant" && item.content.includes("FAUX_LARGE_BEGIN"),
    )?.content;
    assert.equal(body, `FAUX_LARGE_BEGIN\n${"Readable stream content. ".repeat(400)}\nFAUX_LARGE_END`);
    return { characters: body.length };
  });
  await phase("tools", async () => {
    const session = await api("/sessions", { title: "Tool load" });
    const runValue = await run(
      session.id,
      "Use the configured deterministic read tool and return its result.",
    );
    const trace = await api(`/traces?runId=${runValue.id}`);
    assert(
      trace.spans.some((span) => span.kind === "tool"),
      "工具必须实际执行且可追踪",
    );
    return { requests: 1, traceId: trace.traceId };
  });
  passed = true;
} finally {
  await writeFile(
    join(output, "result.json"),
    JSON.stringify({ passed, phases, ...(!passed ? { stateDir } : {}) }, null, 2),
  );
  server.kill("SIGTERM");
  if (server.exitCode === null) await new Promise((done) => server.once("exit", done));
  if (passed) await rm(stateDir, { recursive: true, force: true });
  console.log(JSON.stringify({ passed, evidence: output }));
}
