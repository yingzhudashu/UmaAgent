import { describe, expect, it } from "vitest";
import { ModelRegistry } from "../src/models.js";
import type { UmaConfig } from "../src/types.js";

const config = (): UmaConfig => ({
  server: {
    host: "127.0.0.1",
    port: 3210,
    stateDir: ".state",
    workspaceRoots: ["."],
    webOrigins: [],
    maxUploadBytes: 1024,
  },
  auth: { tokenEnv: "UMA_TOKEN", webSessionHours: 1 },
  models: [
    {
      provider: "openai",
      id: "model",
      name: "Original",
      api: "openai-responses",
      baseUrl: "https://example.invalid/v1",
      apiKeyEnv: "OPENAI_API_KEY",
      reasoning: true,
      tools: true,
      vision: false,
      structuredOutput: true,
      contextWindow: 100_000,
      maxTokens: 4_096,
    },
  ],
  defaultModel: { provider: "openai", id: "model" },
  defaultThinkingLevel: "medium",
  roles: {
    default: { provider: "openai", id: "model" },
    reasoning: { provider: "openai", id: "model" },
    fast: { provider: "openai", id: "model" },
    vision: { provider: "openai", id: "model" },
  },
  skillsDirs: [],
  mcpServers: [],
  runtime: { maxParallelSessions: 1, approvalTimeoutMs: 1_000, toolTimeoutMs: 1_000 },
});

describe("ModelRegistry snapshots", () => {
  it("reconstructs execution limits and capabilities from the persisted Run snapshot", () => {
    const registry = new ModelRegistry(config());
    const snapshot = registry.snapshot({ provider: "openai", id: "model" });
    const current = registry.get(snapshot.ref);
    current.name = "Changed";
    current.contextWindow = 1;
    current.maxTokens = 1;
    current.reasoning = false;
    current.input = ["text", "image"];

    const frozen = registry.fromSnapshot(snapshot);
    expect(frozen).toMatchObject({
      name: "Original",
      api: "openai-responses",
      contextWindow: 100_000,
      maxTokens: 4_096,
      reasoning: true,
      input: ["text"],
    });
  });
});
