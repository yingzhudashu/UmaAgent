import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const port = 33211;
const tokenSecret = "faux-eval-token-012345678901234567890123";
const token = `uma_pat_00000000-0000-4000-8000-000000000001_${tokenSecret}`;
const root = resolve(".");
const stateDir = await mkdtemp(join(tmpdir(), `uma-eval-${process.pid}-`));
const junitPath = join(stateDir, "eval-faux.xml");

const server = spawn(process.execPath, ["scripts/faux-server.mjs"], {
  cwd: root,
  env: {
    ...process.env,
    UMA_FAUX_PORT: String(port),
    UMA_FAUX_TOKEN: tokenSecret,
    UMA_FAUX_STATE: join(stateDir, "state"),
    UMA_FAUX_RESET_STATE: "1",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let serverOutput = "";
server.stdout.on("data", (chunk) => {
  serverOutput += chunk.toString();
});
server.stderr.on("data", (chunk) => {
  serverOutput += chunk.toString();
});

async function waitUntilReady() {
  for (let attempt = 0; attempt < 120; attempt++) {
    if (server.exitCode !== null) throw new Error(`Faux Core exited early:\n${serverOutput}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/v13/health/ready`);
      if (response.ok) return;
    } catch {
      // Startup is still in progress.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error(`Faux Core did not become ready:\n${serverOutput}`);
}

try {
  await waitUntilReady();
  const evaluator = spawn(
    process.execPath,
    ["apps/eval-runner/dist/main.js", "apps/eval-runner/fixtures/faux-suite.json"],
    {
      cwd: root,
      env: {
        ...process.env,
        UMA_SERVER_URL: `http://127.0.0.1:${port}`,
        UMA_TOKEN: token,
        EVAL_JUNIT_PATH: junitPath,
      },
      stdio: "inherit",
    },
  );
  const exitCode = await new Promise((resolveExit, reject) => {
    evaluator.once("error", reject);
    evaluator.once("exit", (code) => resolveExit(code ?? 1));
  });
  if (exitCode !== 0) process.exitCode = exitCode;
} finally {
  server.kill("SIGTERM");
  await new Promise((resolveExit) => {
    if (server.exitCode !== null) resolveExit();
    else server.once("exit", resolveExit);
  });
  await rm(stateDir, { recursive: true, force: true });
}
