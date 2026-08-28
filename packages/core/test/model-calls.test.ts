import { createModels, fauxAssistantMessage, fauxProvider, type Model } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { ContextOverflowError } from "../src/context-manager.js";
import { ModelCallService } from "../src/model-calls.js";
import { modelCacheKey } from "../src/model-retry.js";

const model = {
  provider: "faux",
  id: "model",
  contextWindow: 100_000,
  maxTokens: 4_096,
} as Model<"openai-responses">;

function fixture() {
  const database = {
    startModelCall: vi.fn(() => "call-1"),
    finishModelCall: vi.fn(),
  };
  const completeSimple = vi.fn(async () => fauxAssistantMessage("ok"));
  const models = { forRole: vi.fn(() => model), models: { completeSimple } };
  return {
    service: new ModelCallService(database as never, models as never),
    database,
    completeSimple,
  };
}

describe("ModelCallService", () => {
  it("uses a stable anonymous session cache key and the SDK retry budget", async () => {
    const { service, completeSimple } = fixture();
    const signal = new AbortController().signal;
    await service.complete({
      runId: "run",
      sessionId: "session-a",
      role: "fast",
      purpose: "classify",
      systemPrompt: "stable system",
      messages: [{ role: "user", content: "request", timestamp: 1 }],
      signal,
    });
    const options = completeSimple.mock.calls[0]?.[2];
    expect(options).toMatchObject({
      sessionId: modelCacheKey("session-a", "fast:classify:faux:model"),
      cacheRetention: "short",
      maxRetries: 5,
      maxRetryDelayMs: 120_000,
      signal,
    });
    expect(modelCacheKey("session-a")).toBe(modelCacheKey("session-a"));
    expect(modelCacheKey("session-a")).not.toBe(modelCacheKey("session-b"));
    expect(modelCacheKey("session-a", "fast:classify:faux:model")).not.toBe(
      modelCacheKey("session-a", "reasoning:preflight:faux:model"),
    );
    expect(modelCacheKey("session-a")).not.toContain("session-a");
  });

  it("uses the shared SDK retry budget for contract repair calls", async () => {
    const { service, completeSimple } = fixture();
    await service.complete({
      runId: "run",
      sessionId: "session-a",
      role: "reasoning",
      purpose: "verify.repair",
      systemPrompt: "stable system",
      messages: [{ role: "user", content: "repair", timestamp: 1 }],
      signal: new AbortController().signal,
    });
    expect(completeSimple.mock.calls[0]?.[2]).toMatchObject({
      maxRetries: 5,
      maxRetryDelayMs: 120_000,
    });
  });

  it("fails before provider I/O when the request cannot preserve output capacity", async () => {
    const { service, completeSimple } = fixture();
    await expect(
      service.complete({
        runId: "run",
        sessionId: "session-a",
        role: "fast",
        purpose: "classify",
        systemPrompt: "x".repeat(400_000),
        messages: [],
        signal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(ContextOverflowError);
    expect(completeSimple).not.toHaveBeenCalled();
  });

  it("produces cache read usage for a stable prefix in the same session only", async () => {
    const provider = fauxProvider({
      provider: "cache-faux",
      models: [{ id: "model", contextWindow: 100_000, maxTokens: 4_096 }],
    });
    provider.setResponses([
      fauxAssistantMessage("first"),
      fauxAssistantMessage("second"),
      fauxAssistantMessage("other session"),
    ]);
    const models = createModels();
    models.setProvider(provider.provider);
    const database = { startModelCall: vi.fn(() => crypto.randomUUID()), finishModelCall: vi.fn() };
    const service = new ModelCallService(
      database as never,
      { forRole: vi.fn(() => provider.getModel()), models } as never,
    );
    const base = {
      runId: "run",
      role: "fast" as const,
      purpose: "classify",
      systemPrompt: "stable system",
      signal: new AbortController().signal,
    };
    await service.complete({
      ...base,
      sessionId: "session-a",
      messages: [{ role: "user", content: "first request", timestamp: 1 }],
    });
    const second = await service.complete({
      ...base,
      sessionId: "session-a",
      messages: [
        { role: "user", content: "first request", timestamp: 1 },
        { role: "user", content: "second request", timestamp: 2 },
      ],
    });
    const other = await service.complete({
      ...base,
      sessionId: "session-b",
      messages: [{ role: "user", content: "first request", timestamp: 1 }],
    });
    expect(second.usage.cacheRead).toBeGreaterThan(0);
    expect(other.usage.cacheRead).toBe(0);
  });
});
