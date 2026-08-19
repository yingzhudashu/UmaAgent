import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

const temporary: string[] = [];
afterEach(async () => {
  delete process.env.UMA_CONFIG_TOKEN;
  delete process.env.UMA_CONFIG_KEY;
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function configFile(server: { host: string; webOrigins: string[] }): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "uma-config-"));
  temporary.push(root);
  const path = join(root, "uma.config.json");
  await writeFile(
    path,
    JSON.stringify({
      server: {
        ...server,
        port: 3210,
        stateDir: "state",
        workspaceRoots: ["workspace"],
        maxUploadBytes: 1024,
      },
      auth: { tokenEnv: "UMA_CONFIG_TOKEN", webSessionHours: 1 },
      providers: {
        test: { driver: "test", baseUrl: "https://model.example/v1", apiKeyEnv: "UMA_CONFIG_KEY" },
      },
      models: {
        model: {
          provider: "test",
          name: "Model",
          api: "openai-responses",
          contextWindow: 1000,
          maxOutputTokens: 100,
          capabilities: { reasoning: false },
        },
      },
      roles: {
        default: { provider: "test", id: "model" },
        reasoning: { provider: "test", id: "model" },
        fast: { provider: "test", id: "model" },
        vision: { provider: "test", id: "model" },
      },
      defaultThinkingLevel: "off",
      skillsDirs: [],
      mcpServers: [],
      runtime: { maxParallelSessions: 1, approvalTimeoutMs: 1000, toolTimeoutMs: 1000 },
    }),
  );
  return path;
}

describe("loadConfig", () => {
  it("rejects public listeners without an explicit web origin", async () => {
    process.env.UMA_CONFIG_TOKEN = "secret";
    process.env.UMA_CONFIG_KEY = "key";
    await expect(loadConfig(await configFile({ host: "0.0.0.0", webOrigins: [] }))).rejects.toThrow(
      "Public server hosts require",
    );
  });

  it("requires model credentials and exact web origins", async () => {
    process.env.UMA_CONFIG_TOKEN = "secret";
    const missingKey = await configFile({ host: "127.0.0.1", webOrigins: [] });
    await expect(loadConfig(missingKey)).rejects.toThrow("Missing model API key");
    process.env.UMA_CONFIG_KEY = "key";
    const originWithPath = await configFile({
      host: "0.0.0.0",
      webOrigins: ["https://web.example/path"],
    });
    await expect(loadConfig(originWithPath)).rejects.toThrow("exact origins");
  });

  it("rejects whitespace-only secrets", async () => {
    process.env.UMA_CONFIG_TOKEN = "   ";
    process.env.UMA_CONFIG_KEY = "key";
    await expect(loadConfig(await configFile({ host: "127.0.0.1", webOrigins: [] }))).rejects.toThrow(
      "Missing server token",
    );

    process.env.UMA_CONFIG_TOKEN = "secret";
    process.env.UMA_CONFIG_KEY = "\t";
    await expect(loadConfig(await configFile({ host: "127.0.0.1", webOrigins: [] }))).rejects.toThrow(
      "Missing model API key",
    );
  });
});
