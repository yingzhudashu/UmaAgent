import { createModels, fauxAssistantMessage, fauxProvider, type Model } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { ContextOverflowError } from "../src/context-manager.js";
import { ModelCallService } from "../src/model-calls.js";
import { DEFAULT_MODEL_TIMEOUT_MS, modelCacheKey, transientStreamRetry } from "../src/model-retry.js";

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
    models,
  };
}

describe("ModelCallService", () => {
  it.each(["start", "finish", "provider-and-finish"])(
    "terminates trace when %s fails without repeating accounting writes",
    async (failure) => {
      const { service, database, completeSimple } = fixture();
      const span = { finish: vi.fn(), setAttributes: vi.fn(), addEvent: vi.fn() };
      const error = new Error("database unavailable");
      if (failure === "start")
        database.startModelCall.mockImplementation(() => {
          throw error;
        });
      else
        database.finishModelCall.mockImplementation(() => {
          throw error;
        });
      if (failure === "provider-and-finish")
        completeSimple.mockRejectedValue(new Error("provider unavailable"));
      const result = service.complete({
        runId: "run",
        sessionId: "session",
        role: "fast",
        purpose: "classify",
        systemPrompt: "system",
        messages: [],
        signal: new AbortController().signal,
        trace: { child: () => span } as never,
      });
      if (failure === "provider-and-finish") await expect(result).rejects.toBeInstanceOf(AggregateError);
      else await expect(result).rejects.toBe(error);
      expect(span.finish).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ status: "error" }));
      expect(database.finishModelCall).toHaveBeenCalledTimes(failure === "start" ? 0 : 1);
      expect(completeSimple).toHaveBeenCalledTimes(failure === "start" ? 0 : 1);
    },
  );

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

  it("passes a bounded timeout to the provider", async () => {
    const { service, completeSimple } = fixture();
    await service.complete({
      runId: "run",
      sessionId: "session-a",
      role: "fast",
      purpose: "classify",
      systemPrompt: "stable system",
      messages: [{ role: "user", content: "request", timestamp: 1 }],
      signal: new AbortController().signal,
    });
    expect(completeSimple.mock.calls[0]?.[2]).toMatchObject({ timeoutMs: DEFAULT_MODEL_TIMEOUT_MS });
  });

  it("turns a provider timeout into a terminal model error", async () => {
    const { database, models } = fixture();
    const completeSimple = vi.fn(
      async (_model: unknown, _context: unknown, options: { signal: AbortSignal }) =>
        new Promise<never>((_resolve, reject) => {
          options.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        }),
    );
    const service = new ModelCallService(
      database as never,
      { ...models, models: { completeSimple } } as never,
      5,
    );
    await expect(
      service.complete({
        runId: "run",
        sessionId: "session-a",
        role: "fast",
        purpose: "classify",
        systemPrompt: "system",
        messages: [],
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("Model request timed out after 5ms");
    expect(database.finishModelCall).toHaveBeenCalledWith(
      "call-1",
      expect.objectContaining({ status: "failed", error: "Model request timed out after 5ms" }),
    );
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

  it("retries transient provider responses and preserves the final successful result", async () => {
    const { service, completeSimple, database } = fixture();
    completeSimple
      .mockResolvedValueOnce({
        ...fauxAssistantMessage(""),
        content: [],
        stopReason: "error",
        errorMessage: "provider_error: terminated",
      })
      .mockResolvedValueOnce(fauxAssistantMessage("recovered"));

    const response = await service.complete({
      runId: "run",
      sessionId: "session-a",
      role: "fast",
      purpose: "classify",
      systemPrompt: "Return text",
      messages: [{ role: "user", content: "request", timestamp: 1 }],
      signal: new AbortController().signal,
    });

    expect(response.stopReason).toBe("stop");
    expect(response.content[0]).toMatchObject({ type: "text", text: "recovered" });
    expect(completeSimple).toHaveBeenCalledTimes(2);
    expect(database.finishModelCall).toHaveBeenCalledWith(
      "call-1",
      expect.objectContaining({ status: "completed" }),
    );
  });

  it("keeps retrying transient control-call failures through the expanded budget", async () => {
    vi.useFakeTimers();
    const random = vi.spyOn(Math, "random").mockReturnValue(0);
    try {
      const { service, completeSimple } = fixture();
      for (let index = 0; index < transientStreamRetry.maxRetries; index++) {
        completeSimple.mockResolvedValueOnce({
          ...fauxAssistantMessage(""),
          content: [],
          stopReason: "error",
          errorMessage: "provider_error: terminated",
        });
      }
      completeSimple.mockResolvedValueOnce(fauxAssistantMessage("recovered"));
      const span = { finish: vi.fn(), setAttributes: vi.fn(), addEvent: vi.fn() };
      const responsePromise = service.complete({
        runId: "run",
        sessionId: "session-a",
        role: "fast",
        purpose: "classify",
        systemPrompt: "Return text",
        messages: [{ role: "user", content: "request", timestamp: 1 }],
        signal: new AbortController().signal,
        trace: { child: () => span } as never,
      });
      await vi.advanceTimersByTimeAsync(60_000);
      const response = await responsePromise;

      expect(response.stopReason).toBe("stop");
      expect(response.content[0]).toMatchObject({ type: "text", text: "recovered" });
      expect(completeSimple).toHaveBeenCalledTimes(transientStreamRetry.maxRetries + 1);
      expect(span.addEvent.mock.calls.filter(([name]) => name === "model.retry")).toHaveLength(
        transientStreamRetry.maxRetries,
      );
    } finally {
      random.mockRestore();
      vi.useRealTimers();
    }
  });

  it("does not retry permanent provider responses", async () => {
    const { service, completeSimple } = fixture();
    completeSimple.mockResolvedValueOnce({
      ...fauxAssistantMessage(""),
      content: [],
      stopReason: "error",
      errorMessage: "insufficient_quota",
    });

    const response = await service.complete({
      runId: "run",
      sessionId: "session-a",
      role: "fast",
      purpose: "classify",
      systemPrompt: "Return text",
      messages: [],
      signal: new AbortController().signal,
    });

    expect(response.stopReason).toBe("error");
    expect(completeSimple).toHaveBeenCalledTimes(1);
  });

  it("recovers a complete response when the gateway omits the stream finish marker", async () => {
    const { service, completeSimple, database } = fixture();
    completeSimple.mockResolvedValueOnce({
      ...fauxAssistantMessage('{"taskClass":"simple"}'),
      stopReason: "error",
      errorMessage: "Stream ended without finish_reason",
    });

    const response = await service.complete({
      runId: "run",
      sessionId: "session-a",
      role: "fast",
      purpose: "classify",
      systemPrompt: "Return JSON",
      messages: [{ role: "user", content: "request", timestamp: 1 }],
      signal: new AbortController().signal,
    });

    expect(response.stopReason).toBe("stop");
    expect(response.errorMessage).toBeUndefined();
    expect(completeSimple).toHaveBeenCalledTimes(1);
    expect(database.finishModelCall).toHaveBeenCalledWith(
      "call-1",
      expect.objectContaining({ status: "completed" }),
    );
  });

  it("retries an empty stream finish failure and preserves a real failure", async () => {
    vi.useFakeTimers();
    const random = vi.spyOn(Math, "random").mockReturnValue(0);
    try {
      const { service, completeSimple, database } = fixture();
      for (let attempt = 0; attempt < 6; attempt++)
        completeSimple.mockResolvedValueOnce({
          ...fauxAssistantMessage(""),
          content: [],
          stopReason: "error",
          errorMessage: "Stream ended without finish_reason",
        });

      const responsePromise = service.complete({
        runId: "run",
        sessionId: "session-a",
        role: "fast",
        purpose: "classify",
        systemPrompt: "Return JSON",
        messages: [{ role: "user", content: "request", timestamp: 1 }],
        signal: new AbortController().signal,
      });
      await vi.advanceTimersByTimeAsync(20_000);
      const response = await responsePromise;

      expect(response.stopReason).toBe("error");
      expect(completeSimple).toHaveBeenCalledTimes(6);
      expect(database.finishModelCall).toHaveBeenCalledWith(
        "call-1",
        expect.objectContaining({ status: "failed", error: "Stream ended without finish_reason" }),
      );
    } finally {
      random.mockRestore();
      vi.useRealTimers();
    }
  });

  it("records a trace event for each missing finish marker retry", async () => {
    const { service, completeSimple } = fixture();
    const span = { finish: vi.fn(), setAttributes: vi.fn(), addEvent: vi.fn() };
    completeSimple
      .mockResolvedValueOnce({
        ...fauxAssistantMessage(""),
        content: [],
        stopReason: "error",
        errorMessage: "Stream ended without finish_reason",
      })
      .mockResolvedValueOnce({
        ...fauxAssistantMessage("recovered"),
        stopReason: "stop",
      });
    await service.complete({
      runId: "run",
      sessionId: "session-a",
      role: "fast",
      purpose: "classify",
      systemPrompt: "Return text",
      messages: [{ role: "user", content: "request", timestamp: 1 }],
      signal: new AbortController().signal,
      trace: { child: () => span } as never,
    });
    expect(span.addEvent).toHaveBeenCalledWith("model.retry", {
      attempt: 1,
      reason: "missing_finish_reason",
    });
  });

  it("forwards compact JSON control-call options to OpenAI-compatible providers", async () => {
    const { service, completeSimple, models } = fixture();
    models.forRole.mockReturnValueOnce({ ...model, api: "openai-completions" });
    await service.complete({
      runId: "run",
      sessionId: "session-a",
      role: "fast",
      purpose: "classify",
      systemPrompt: "Return JSON",
      messages: [{ role: "user", content: "request", timestamp: 1 }],
      signal: new AbortController().signal,
      jsonMode: true,
      maxTokens: 64,
    });
    expect(completeSimple.mock.calls[0]?.[2]).toMatchObject({
      maxTokens: 64,
      samplingParams: { response_format: { type: "json_object" } },
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
