import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// 诊断专用：采样器会增加开销，此结果不能充当正常模式性能或四小时 soak 验收。
const output = resolve(process.env.UMA_PROFILE_OUTPUT ?? "artifacts/acceptance/profile");
await mkdir(output, { recursive: true });
const stateDir = await mkdtemp(join(tmpdir(), "uma-profile-"));
const port = 33214;
const child = spawn(
  process.execPath,
  ["--max-semi-space-size=4", "--inspect=127.0.0.1:0", "scripts/faux-server.mjs"],
  {
    env: {
      ...process.env,
      UMA_FAUX_STATE: stateDir,
      UMA_FAUX_PORT: String(port),
      UMA_FAUX_RESPONSES: "10000",
    },
    stdio: ["ignore", "ignore", "pipe"],
  },
);
let stderr = "";
child.stderr.on("data", (chunk) => {
  stderr = (stderr + chunk).slice(-5000);
});
const pause = (ms) => new Promise((done) => setTimeout(done, ms));
const base = `http://127.0.0.1:${port}/api/v16`;
const token = "uma_pat_00000000-0000-4000-8000-000000000001_faux-local-token-012345678901234567890123";
async function api(path, body) {
  const response = await fetch(base + path, {
    method: body ? "POST" : "GET",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) throw new Error(`Profiling request failed: ${response.status}`);
  return response.json();
}
let socket;
const heapChunks = [];
let serial = 0;
const pending = new Map();
function command(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++serial;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
}
try {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (child.exitCode !== null) throw new Error("Profiling server stopped during startup");
    try {
      if ((await fetch(base + "/health/ready")).ok) break;
    } catch {
      /* 等待隔离服务。 */
    }
    await pause(100);
  }
  const debuggerUrl = stderr.match(/Debugger listening on (ws:\/\/[^\s]+)/)?.[1];
  if (!debuggerUrl) throw new Error("Local inspector endpoint was not announced");
  socket = new WebSocket(debuggerUrl);
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = reject;
  });
  socket.onmessage = (message) => {
    const result = JSON.parse(message.data);
    if (result.method === "HeapProfiler.addHeapSnapshotChunk") {
      heapChunks.push(result.params.chunk);
      return;
    }
    const waiter = pending.get(result.id);
    if (!waiter) return;
    pending.delete(result.id);
    if (result.error) waiter.reject(new Error(result.error.message));
    else waiter.resolve(result.result);
  };
  await command("HeapProfiler.startSampling", { samplingInterval: 32768 });
  await command("Profiler.enable");
  await command("Profiler.start");
  const session = await api("/sessions", { title: "Allocation profile" });
  const samples = [];
  for (let index = 0; index < Number(process.env.UMA_PROFILE_MESSAGES ?? 300); index++) {
    const accepted = await api(`/sessions/${session.id}/messages`, {
      messageId: randomUUID(),
      text: "Reply with FAUX_DIRECT.",
      mode: "agent",
    });
    for (;;) {
      const run = await api(`/runs/${accepted.runId}`);
      if (run.status === "completed") break;
      if (["failed", "cancelled", "interrupted"].includes(run.status))
        throw new Error(`Profile Run ${run.status}`);
      await pause(30);
    }
    if (index % 10 === 0) {
      const rows = await api("/reports/resources?from=0&limit=1");
      samples.push({ messages: index + 1, ...rows[0] });
      await writeFile(join(output, "resources.json"), JSON.stringify({ stateDir, samples }, null, 2));
    }
  }
  await writeFile(join(output, "cpu.cpuprofile"), JSON.stringify((await command("Profiler.stop")).profile));
  await writeFile(
    join(output, "allocations.heapprofile"),
    JSON.stringify((await command("HeapProfiler.stopSampling")).profile),
  );
  // 完整快照会触发 GC，只用于保留链诊断，绝不能将快照之后的 RSS 当验收结果。
  if (process.env.UMA_PROFILE_HEAP === "1") {
    await command("HeapProfiler.takeHeapSnapshot");
    await writeFile(join(output, "retained.heapsnapshot"), heapChunks.join(""));
  }
  console.log(JSON.stringify({ completed: true, stateDir, output }));
} finally {
  socket?.close();
  child.kill("SIGTERM");
}
