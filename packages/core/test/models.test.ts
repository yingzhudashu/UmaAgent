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

  it("lists models, resolves roles, and rejects unknown references", () => {
    const registry = new ModelRegistry(config());
    expect(registry.list()).toEqual([{ provider: "openai", id: "model" }]);
    expect(registry.forRole("fast").id).toBe("model");
    expect(() => registry.get({ provider: "openai", id: "missing" })).toThrow("Unknown model");
    expect(() => registry.snapshot({ provider: "openai", id: "missing" })).toThrow("Unknown model");
  });

  it("requires provider entries to share connection configuration", () => {
    const input = config();
    const [model] = input.models;
    if (!model) throw new Error("fixture model is missing");
    input.models.push({ ...model, id: "other", baseUrl: "https://other.invalid/v1" });
    expect(() => new ModelRegistry(input)).toThrow("must share baseUrl");
  });

  it("restores vision input from a persisted snapshot", () => {
    const input = config();
    const [model] = input.models;
    if (!model) throw new Error("fixture model is missing");
    model.vision = true;
    const registry = new ModelRegistry(input);
    const snapshot = registry.snapshot({ provider: "openai", id: "model" });
    expect(snapshot.capabilities.vision).toBe(true);
    expect(registry.fromSnapshot(snapshot).input).toEqual(["text", "image"]);
  });
});
