import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { type UmaConfig, UmaRuntime } from "@uma-agent/core";
import { afterEach, describe, expect, it } from "vitest";
import { createServer } from "../../server/src/app.js";

const execute = promisify(execFile);
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const action of cleanup.splice(0).reverse()) await action();
});

describe("Uma CLI JSON mode", () => {
  it("writes ordered protocol JSON to stdout and one terminal record", async () => {
    const root = await mkdtemp(join(tmpdir(), "uma-cli-"));
    process.env.UMA_CLI_TEST_TOKEN = "secret";
    const model = { provider: "faux", id: "model" };
    const config: UmaConfig = {
      server: {
        host: "127.0.0.1",
        port: 0,
        stateDir: join(root, "state"),
        workspaceRoots: [root],
        webOrigins: [],
        maxUploadBytes: 1_024,
      },
      auth: { tokenEnv: "UMA_CLI_TEST_TOKEN", webSessionHours: 1 },
      models: [
        {
          ...model,
          name: "Faux",
          api: "openai-responses",
          baseUrl: "http://127.0.0.1:9/v1",
          apiKeyEnv: "UMA_CLI_TEST_KEY",
          reasoning: false,
          tools: true,
          vision: false,
          structuredOutput: true,
          contextWindow: 100_000,
          maxTokens: 4_096,
        },
      ],
      defaultModel: model,
      defaultThinkingLevel: "off",
      roles: { default: model, reasoning: model, fast: model, vision: model },
      skillsDirs: [],
      mcpServers: [],
      runtime: { maxParallelSessions: 1, approvalTimeoutMs: 1_000, toolTimeoutMs: 1_000 },
    };
    const runtime = new UmaRuntime(config);
    const faux = fauxProvider({
      provider: "faux",
      models: [{ id: "model", contextWindow: 100_000, maxTokens: 4_096 }],
      tokensPerSecond: 100_000,
    });
    faux.setResponses([
      fauxAssistantMessage(JSON.stringify({ taskClass: "simple" })),
      fauxAssistantMessage("CLI result"),
      fauxAssistantMessage("[]"),
    ]);
    runtime.models.models.setProvider(faux.provider);
    await runtime.start();
    const app = await createServer(runtime, { webRoot: false });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("Test server did not bind a TCP port");
    cleanup.push(async () => {
      await app.close();
      await runtime.stop();
      await rm(root, { recursive: true, force: true });
      delete process.env.UMA_CLI_TEST_TOKEN;
    });

    const result = await execute(
      process.execPath,
      [
        "--import",
        "tsx",
        "apps/cli/src/main.ts",
        "run",
        "--json",
        "hello from script",
        `--server=http://127.0.0.1:${address.port}`,
        "--token=secret",
      ],
      { cwd: resolve("."), timeout: 15_000 },
    );
    expect(result.stderr).toBe("");
    const records = result.stdout
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line) as { type: string; payload?: { sequence?: number }; status?: string });
    expect(records[0]?.type).toBe("snapshot");
    expect(records[1]?.type).toBe("run.accepted");
    expect(records.at(-1)).toMatchObject({ type: "run.terminal", status: "completed" });
    const sequences = records
      .filter((record) => record.type === "durable.event")
      .map((record) => record.payload?.sequence as number);
    expect(sequences).toEqual([...new Set(sequences)].sort((a, b) => a - b));
  });
});
