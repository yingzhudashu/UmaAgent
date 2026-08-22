import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { type UmaConfig, UmaRuntime } from "@uma-agent/core";
import { spawn as spawnPty } from "node-pty";
import { afterEach, describe, expect, it } from "vitest";
import { createServer } from "../../server/src/app.js";
import { AuthService } from "../../server/src/auth.js";
import { createTuiAutocomplete } from "../src/tui-completion.js";

const execute = promisify(execFile);
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const action of cleanup.splice(0).reverse()) await action();
});

function testConfig(root: string): UmaConfig {
  const model = { provider: "faux", id: "model" };
  return {
    server: {
      host: "127.0.0.1",
      port: 0,
      stateDir: join(root, "state"),
      workspaceRoots: [root],
      webOrigins: [],
      maxUploadBytes: 1_024,
    },
    auth: { webSessionHours: 1 },
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
}

const wait = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

describe("Uma CLI JSON mode", () => {
  it("completes TUI slash commands through the Pi autocomplete provider", async () => {
    const provider = createTuiAutocomplete(resolve("."));
    const suggestions = await provider.getSuggestions(["/he"], 0, 3, {
      signal: new AbortController().signal,
    });
    expect(suggestions?.items.map((item) => item.value)).toContain("help");
    const completion = provider.applyCompletion(
      ["/he"],
      0,
      3,
      suggestions?.items.find((item) => item.value === "help") as NonNullable<
        typeof suggestions
      >["items"][number],
      suggestions?.prefix ?? "/he",
    );
    expect(completion.lines).toEqual(["/help "]);
  });

  it("writes ordered protocol JSON to stdout and one terminal record", async () => {
    const root = await mkdtemp(join(tmpdir(), "uma-cli-"));
    const config = testConfig(root);
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
    const testToken = new AuthService(runtime).issueToken(
      runtime.database.createUser("admin").id,
      "cli-test",
    ).token;
    const app = await createServer(runtime, { webRoot: false });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("Test server did not bind a TCP port");
    cleanup.push(async () => {
      await app.close();
      await runtime.stop();
      await rm(root, { recursive: true, force: true });
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
        `--token=${testToken}`,
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

  it("runs the Pi TUI in a real pseudoterminal with persistent history and completion", async () => {
    const root = await mkdtemp(join(tmpdir(), "uma-cli-pty-"));
    const cliState = join(root, "cli-state");
    const runtime = new UmaRuntime(testConfig(root));
    await runtime.start();
    const user = runtime.database.createUser("admin");
    const testToken = new AuthService(runtime).issueToken(user.id, "cli-pty").token;
    const session = await runtime.createSession({ title: "PTY session" }, user.id);
    const app = await createServer(runtime, { webRoot: false });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("Test server did not bind a TCP port");
    cleanup.push(async () => {
      await app.close();
      await runtime.stop();
      await rm(root, { recursive: true, force: true });
    });

    const environment = Object.fromEntries(
      Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
    );
    environment.UMA_CLI_STATE_DIR = cliState;
    const terminal = spawnPty(
      process.execPath,
      [
        "--import",
        "tsx",
        "apps/cli/src/main.ts",
        "chat",
        `--server=http://127.0.0.1:${address.port}`,
        `--token=${testToken}`,
        `--session=${session.id}`,
      ],
      { cwd: resolve("."), env: environment, cols: 100, rows: 30 },
    );
    let output = "";
    const ready = new Promise<void>((resolveReady, reject) => {
      const timeout = setTimeout(() => reject(new Error(`TUI did not render:\n${output}`)), 10_000);
      terminal.onData((value) => {
        output += value;
        if (output.includes("UmaAgent")) {
          clearTimeout(timeout);
          resolveReady();
        }
      });
    });
    await ready;
    terminal.write("/sessions\r");
    await wait(150);
    terminal.write("\u001b[A\r");
    await wait(150);
    terminal.write("/help\r");
    await wait(150);
    terminal.write("/new\r");
    await wait(250);
    terminal.write(`/use ${session.id}\r`);
    await wait(250);
    terminal.write("/cancel\r");
    await wait(150);
    terminal.write("/exit\r");
    await new Promise<void>((resolveExit, reject) => {
      const timeout = setTimeout(() => {
        terminal.kill();
        reject(new Error(`TUI did not exit:\n${output}`));
      }, 10_000);
      terminal.onExit(() => {
        clearTimeout(timeout);
        resolveExit();
      });
    });

    const history = (await readFile(join(cliState, "history.txt"), "utf8")).trim().split(/\r?\n/);
    expect(history.filter((item) => item === "/sessions")).toHaveLength(2);
    expect(history).toContain("/help");
    expect(history).toContain("/new");
    expect(history).toContain(`/use ${session.id}`);
    expect(history).toContain("/cancel");
    expect(history.at(-1)).toBe("/exit");
  });
});
