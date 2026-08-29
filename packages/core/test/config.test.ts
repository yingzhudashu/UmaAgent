import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

const temporary: string[] = [];
afterEach(async () => {
  delete process.env.UMA_CONFIG_KEY;
  delete process.env.UMA_CONFIG_IMAGE_KEY;
  delete process.env.UMA_CONFIG_MCP_TOKEN;
  delete process.env.UMA_CONFIG_XIANYU_TOKEN;
  delete process.env.UMA_CONFIG_STATE;
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
      auth: { webSessionHours: 1 },
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
      imageGeneration: {
        baseUrl: "https://images.example/v1",
        apiKeyEnv: "UMA_CONFIG_IMAGE_KEY",
      },
      defaultThinkingLevel: "off",
      skillsDirs: [],
      mcpServers: [],
      runtime: { maxParallelSessions: 1, approvalTimeoutMs: 1000, toolTimeoutMs: 1000 },
    }),
  );
  return path;
}

async function mutateConfig(
  mutate: (value: Record<string, unknown>) => void,
  server = { host: "127.0.0.1", webOrigins: [] as string[] },
): Promise<string> {
  const path = await configFile(server);
  const value = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  mutate(value);
  await writeFile(path, JSON.stringify(value));
  return path;
}

describe("loadConfig", () => {
  it("rejects public listeners without an explicit web origin", async () => {
    process.env.UMA_CONFIG_KEY = "key";
    process.env.UMA_CONFIG_IMAGE_KEY = "image-key";
    process.env.UMA_CONFIG_MCP_TOKEN = "mcp-secret";
    await expect(loadConfig(await configFile({ host: "0.0.0.0", webOrigins: [] }))).rejects.toThrow(
      "Public server hosts require",
    );
  });

  it("requires model credentials and exact web origins", async () => {
    const missingKey = await configFile({ host: "127.0.0.1", webOrigins: [] });
    await expect(loadConfig(missingKey)).rejects.toThrow("Missing model API key");
    process.env.UMA_CONFIG_KEY = "key";
    process.env.UMA_CONFIG_IMAGE_KEY = "image-key";
    const originWithPath = await configFile({
      host: "0.0.0.0",
      webOrigins: ["https://web.example/path"],
    });
    await expect(loadConfig(originWithPath)).rejects.toThrow("exact origins");
  });

  it("requires a dedicated image generation credential", async () => {
    process.env.UMA_CONFIG_KEY = "key";
    await expect(loadConfig(await configFile({ host: "127.0.0.1", webOrigins: [] }))).rejects.toThrow(
      "Missing image generation API key",
    );
    process.env.UMA_CONFIG_IMAGE_KEY = "image-key";
    await expect(loadConfig(await configFile({ host: "127.0.0.1", webOrigins: [] }))).resolves.toMatchObject({
      imageGeneration: {
        baseUrl: "https://images.example/v1",
        apiKeyEnv: "UMA_CONFIG_IMAGE_KEY",
      },
    });
  });

  it("rejects whitespace-only secrets", async () => {
    process.env.UMA_CONFIG_KEY = "key";
    process.env.UMA_CONFIG_IMAGE_KEY = "image-key";
    process.env.UMA_CONFIG_KEY = "\t";
    await expect(loadConfig(await configFile({ host: "127.0.0.1", webOrigins: [] }))).rejects.toThrow(
      "Missing model API key",
    );
  });

  it("loads defaults, resolves relative paths, removes duplicate origins, and parses MCP transports", async () => {
    process.env.UMA_CONFIG_KEY = "key";
    process.env.UMA_CONFIG_IMAGE_KEY = "image-key";
    process.env.UMA_CONFIG_MCP_TOKEN = "mcp-secret";
    const path = await mutateConfig((value) => {
      const server = value.server as Record<string, unknown>;
      delete server.port;
      delete server.maxUploadBytes;
      server.webOrigins = ["https://web.example", "https://web.example"];
      delete value.defaultThinkingLevel;
      value.mcpServers = [
        { name: "stdio", transport: "stdio", command: "node", args: ["server.js"], env: { A: "B" } },
        {
          name: "http",
          transport: "http",
          url: "https://mcp.example",
          authTokenEnv: "UMA_CONFIG_MCP_TOKEN",
        },
      ];
    });
    const loaded = await loadConfig(path);
    expect(loaded.server).toMatchObject({ port: 3210, maxUploadBytes: 20 * 1024 * 1024 });
    expect(loaded.server.webOrigins).toEqual(["https://web.example"]);
    expect(loaded.defaultThinkingLevel).toBe("medium");
    expect(loaded.mcpServers).toHaveLength(2);
    expect(loaded.models[0]).toMatchObject({
      tools: true,
      vision: false,
      structuredOutput: false,
      baseUrl: "https://model.example/v1",
    });
  });

  it("rejects malformed primitive, URL, model, role, MCP, and unknown-field configuration", async () => {
    process.env.UMA_CONFIG_KEY = "key";
    const cases: Array<[(value: Record<string, unknown>) => void, RegExp]> = [
      [(value) => Object.assign(value, { extra: true }), /unknown fields/],
      [(value) => Object.assign(value, { server: [] }), /server must be an object/],
      [
        (value) => Object.assign(value.server as Record<string, unknown>, { port: 0 }),
        /server.port must be positive/,
      ],
      [
        (value) => Object.assign(value.server as Record<string, unknown>, { workspaceRoots: "workspace" }),
        /string array/,
      ],
      [
        (value) => Object.assign(value.server as Record<string, unknown>, { workspaceRoots: [] }),
        /must not be empty/,
      ],
      [
        (value) => Object.assign(value.server as Record<string, unknown>, { webOrigins: ["not a url"] }),
        /valid HTTP/,
      ],
      [
        (value) =>
          Object.assign(value.server as Record<string, unknown>, { webOrigins: ["ftp://example.com"] }),
        /valid HTTP/,
      ],
      [
        (value) =>
          Object.assign(value.server as Record<string, unknown>, {
            webOrigins: ["https://u:p@example.com"],
          }),
        /without credentials/,
      ],
      [(value) => Object.assign(value.models as Record<string, unknown>, { model: [] }), /must be an object/],
      [
        (value) =>
          Object.assign(
            (value.models as Record<string, Record<string, unknown>>).model as Record<string, unknown>,
            { extra: true },
          ),
        /unknown fields/,
      ],
      [
        (value) =>
          Object.assign(
            (value.models as Record<string, Record<string, unknown>>).model as Record<string, unknown>,
            { api: "unknown" },
          ),
        /Unsupported model API/,
      ],
      [(value) => Object.assign(value, { models: {} }), /At least one model/],
      [
        (value) => Object.assign(value, { defaultThinkingLevel: "impossible" }),
        /Invalid defaultThinkingLevel/,
      ],
      [
        (value) =>
          Object.assign((value.roles as Record<string, Record<string, string>>).fast, { id: "missing" }),
        /unknown model/,
      ],
      [
        (value) => Object.assign(value, { mcpServers: [{ name: "x", transport: "unknown" }] }),
        /Unsupported MCP/,
      ],
      [
        (value) => Object.assign(value, { mcpServers: [{ name: "x", transport: "stdio" }] }),
        /command is required/,
      ],
      [
        (value) => Object.assign(value, { mcpServers: [{ name: "x", transport: "http" }] }),
        /url is required/,
      ],
    ];
    for (const [mutate, expected] of cases)
      await expect(loadConfig(await mutateConfig(mutate))).rejects.toThrow(expected);
  });

  it("validates the optional Xianyu adapter configuration", async () => {
    process.env.UMA_CONFIG_KEY = "key";
    process.env.UMA_CONFIG_IMAGE_KEY = "image-key";
    process.env.UMA_CONFIG_XIANYU_TOKEN = "adapter-token";
    const path = await mutateConfig((value) => {
      value.xianyu = { adapterUrl: "http://127.0.0.1:3250/", controlTokenEnv: "UMA_CONFIG_XIANYU_TOKEN" };
    });
    await expect(loadConfig(path)).resolves.toMatchObject({
      xianyu: { adapterUrl: "http://127.0.0.1:3250", controlTokenEnv: "UMA_CONFIG_XIANYU_TOKEN" },
    });
    await expect(
      loadConfig(
        await mutateConfig((value) => {
          value.xianyu = { adapterUrl: "ftp://127.0.0.1:3250", controlTokenEnv: "UMA_CONFIG_XIANYU_TOKEN" };
        }),
      ),
    ).rejects.toThrow("valid HTTP(S)");
    delete process.env.UMA_CONFIG_XIANYU_TOKEN;
    await expect(
      loadConfig(
        await mutateConfig((value) => {
          value.xianyu = { adapterUrl: "http://127.0.0.1:3250", controlTokenEnv: "UMA_CONFIG_XIANYU_TOKEN" };
        }),
      ),
    ).rejects.toThrow("Missing Xianyu control token");
    process.env.UMA_CONFIG_XIANYU_TOKEN = "adapter-token";
    await expect(
      loadConfig(
        await mutateConfig((value) => {
          value.xianyu = {
            adapterUrl: "http://127.0.0.1:3250",
            controlTokenEnv: "UMA_CONFIG_XIANYU_TOKEN",
            extra: true,
          };
        }),
      ),
    ).rejects.toThrow("unknown fields");
  });

  it("expands configured data paths and rejects missing path variables", async () => {
    process.env.UMA_CONFIG_KEY = "key";
    process.env.UMA_CONFIG_IMAGE_KEY = "image-key";
    process.env.UMA_CONFIG_STATE = "external-state";
    const expanded = await loadConfig(
      await mutateConfig((value) => {
        (value.server as Record<string, unknown>).stateDir = "$UMA_CONFIG_STATE";
      }),
    );
    expect(expanded.server.stateDir).toMatch(/external-state$/);
    await expect(
      loadConfig(
        await mutateConfig((value) => {
          (value.server as Record<string, unknown>).workspaceRoots = ["%UMA_CONFIG_MISSING_PATH%"];
        }),
      ),
    ).rejects.toThrow("config path references missing environment variable UMA_CONFIG_MISSING_PATH");
  });
});
