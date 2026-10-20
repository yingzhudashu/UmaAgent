import { createAssistantMessageEventStream, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_MODEL_TIMEOUT_MS,
  missingFinishReasonRetry,
  modelRetryDelayMs,
  recoverMissingFinishReason,
  retryMissingFinishReasonStream,
  traceProviderRetries,
  transientStreamRetry,
  waitForModelRetry,
} from "../src/model-retry.js";

describe("model stream recovery", () => {
  it("converts a non-tool response missing only the finish marker into a normal stop", async () => {
    const source = createAssistantMessageEventStream();
    const message = {
      ...fauxAssistantMessage("complete"),
      stopReason: "error" as const,
      errorMessage: "Stream ended without finish_reason",
    };
    source.push({ type: "start", partial: message });
    source.push({ type: "error", reason: "error", error: message });

    const recovered = retryMissingFinishReasonStream(() => source, new AbortController().signal);
    const events = [];
    for await (const event of recovered) events.push(event);
    const result = await recovered.result();

    expect(events.at(-1)?.type).toBe("done");
    expect(result.stopReason).toBe("stop");
    expect(result.errorMessage).toBeUndefined();
  });

  it("does not recover a tool call with a missing finish marker", () => {
    const message = {
      ...fauxAssistantMessage(""),
      content: [{ type: "toolCall" as const, id: "call-1", name: "tool", arguments: {} }],
      stopReason: "error" as const,
      errorMessage: "Stream ended without finish_reason",
    };
    expect(recoverMissingFinishReason(message)).toBeUndefined();
  });

  it("reports bounded retries without changing the final error", async () => {
    vi.useFakeTimers();
    const random = vi.spyOn(Math, "random").mockReturnValue(0.5);
    try {
      const attempts: number[] = [];
      const create = () => {
        const source = createAssistantMessageEventStream();
        const message = {
          ...fauxAssistantMessage(""),
          content: [],
          stopReason: "error" as const,
          errorMessage: "Stream ended without finish_reason",
        };
        source.push({ type: "start", partial: message });
        source.push({ type: "error", reason: "error", error: message });
        source.end();
        return source;
      };
      const recovered = retryMissingFinishReasonStream(create, new AbortController().signal, (attempt) => {
        attempts.push(attempt);
      });
      const eventsPromise = (async () => {
        const events = [];
        for await (const event of recovered) events.push(event);
        return events;
      })();
      await vi.runAllTimersAsync();
      const events = await eventsPromise;
      const finalEvent = events.findLast((event) => event.type === "error");
      expect(attempts).toEqual([1, 2, 3, 4, 5]);
      expect(finalEvent?.type).toBe("error");
      if (finalEvent?.type === "error")
        expect(finalEvent.error.errorMessage).toBe("Stream ended without finish_reason");
    } finally {
      random.mockRestore();
      vi.useRealTimers();
    }
  });

  it("retries a terminated provider stream before forwarding any response", async () => {
    let attempts = 0;
    const retryEvents: Array<{ attempt: number; reason: string }> = [];
    const create = () => {
      attempts++;
      const source = createAssistantMessageEventStream();
      if (attempts === 1) {
        const message = {
          ...fauxAssistantMessage(""),
          content: [],
          stopReason: "error" as const,
          errorMessage: "terminated",
        };
        source.push({ type: "start", partial: message });
        source.push({ type: "error", reason: "error", error: message });
      } else {
        const message = fauxAssistantMessage("recovered");
        source.push({ type: "start", partial: message });
        source.push({ type: "text_delta", contentIndex: 0, delta: "recovered", partial: message });
        source.push({ type: "done", reason: "stop", message });
      }
      source.end();
      return source;
    };
    const recovered = retryMissingFinishReasonStream(
      create,
      new AbortController().signal,
      (attempt, reason) => retryEvents.push({ attempt, reason }),
    );
    const events = [];
    for await (const event of recovered) events.push(event);

    expect(attempts).toBe(2);
    expect(retryEvents).toEqual([{ attempt: 1, reason: "transient_provider_error" }]);
    expect(
      events
        .filter((event) => event.type === "text_delta")
        .map((event) => (event.type === "text_delta" ? event.delta : "")),
    ).toEqual(["recovered"]);
    expect(events.at(-1)?.type).toBe("done");
  });

  it("does not retry a transient error after response content has been exposed", async () => {
    let attempts = 0;
    const create = () => {
      attempts++;
      const source = createAssistantMessageEventStream();
      const message = {
        ...fauxAssistantMessage("partial"),
        stopReason: "error" as const,
        errorMessage: "terminated",
      };
      source.push({ type: "start", partial: message });
      source.push({ type: "text_delta", contentIndex: 0, delta: "partial", partial: message });
      source.push({ type: "error", reason: "error", error: message });
      source.end();
      return source;
    };
    const recovered = retryMissingFinishReasonStream(create, new AbortController().signal);
    const events = [];
    for await (const event of recovered) events.push(event);

    expect(attempts).toBe(1);
    expect(events.filter((event) => event.type === "text_delta")).toHaveLength(1);
    expect(events.at(-1)?.type).toBe("error");
  });

  it("retries a transient error thrown before the stream is created", async () => {
    let attempts = 0;
    const create = () => {
      attempts++;
      if (attempts === 1) throw new Error("fetch failed: ECONNRESET");
      const source = createAssistantMessageEventStream();
      const message = fauxAssistantMessage("recovered");
      source.push({ type: "start", partial: message });
      source.push({ type: "text_delta", contentIndex: 0, delta: "recovered", partial: message });
      source.push({ type: "done", reason: "stop", message });
      source.end();
      return source;
    };
    const recovered = retryMissingFinishReasonStream(
      create,
      new AbortController().signal,
      undefined,
      (error) => ({
        ...fauxAssistantMessage(""),
        stopReason: "error",
        errorMessage: error instanceof Error ? error.message : String(error),
      }),
    );
    const events = [];
    for await (const event of recovered) events.push(event);

    expect(attempts).toBe(2);
    expect(events.at(-1)?.type).toBe("done");
  });

  it("reconnects when the stream iterator throws before exposing output", async () => {
    vi.useFakeTimers();
    const random = vi.spyOn(Math, "random").mockReturnValue(0);
    try {
      let attempts = 0;
      const create = () => {
        attempts++;
        if (attempts === 1) {
          const partial = fauxAssistantMessage("");
          return (async function* () {
            yield { type: "start" as const, partial };
            throw new Error("fetch failed: ECONNRESET");
          })() as never;
        }
        const source = createAssistantMessageEventStream();
        const message = fauxAssistantMessage("reconnected");
        source.push({ type: "start", partial: message });
        source.push({ type: "text_delta", contentIndex: 0, delta: "reconnected", partial: message });
        source.push({ type: "done", reason: "stop", message });
        source.end();
        return source;
      };
      const recovered = retryMissingFinishReasonStream(
        create,
        new AbortController().signal,
        undefined,
        (error) => ({
          ...fauxAssistantMessage(""),
          content: [],
          stopReason: "error",
          errorMessage: error instanceof Error ? error.message : String(error),
        }),
      );
      const eventsPromise = (async () => {
        const events = [];
        for await (const event of recovered) events.push(event);
        return events;
      })();
      await vi.advanceTimersByTimeAsync(1_000);
      const events = await eventsPromise;

      expect(attempts).toBe(2);
      expect(events.at(-1)?.type).toBe("done");
      expect(
        events
          .filter((event) => event.type === "text_delta")
          .map((event) => (event.type === "text_delta" ? event.delta : "")),
      ).toEqual(["reconnected"]);
    } finally {
      random.mockRestore();
      vi.useRealTimers();
    }
  });

  it("records a retry only when the provider starts another fetch", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    const retries: number[] = [];
    const request = traceProviderRetries(fetcher, (attempt) => retries.push(attempt));
    await request("https://provider.example/v1/chat", {});
    expect(retries).toEqual([]);
    await request("https://provider.example/v1/chat", {});
    expect(retries).toEqual([1]);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("uses the configured bounded budget for repeated transient interruptions", async () => {
    vi.useFakeTimers();
    const random = vi.spyOn(Math, "random").mockReturnValue(0.5);
    try {
      let attempts = 0;
      const retryAttempts: number[] = [];
      const create = () => {
        attempts++;
        const source = createAssistantMessageEventStream();
        const message = {
          ...fauxAssistantMessage(""),
          content: [],
          stopReason: "error" as const,
          errorMessage: "terminated",
        };
        source.push({ type: "start", partial: message });
        source.push({ type: "error", reason: "error", error: message });
        source.end();
        return source;
      };
      const recovered = retryMissingFinishReasonStream(create, new AbortController().signal, (attempt) =>
        retryAttempts.push(attempt),
      );
      const eventsPromise = (async () => {
        const events = [];
        for await (const event of recovered) events.push(event);
        return events;
      })();
      await vi.runAllTimersAsync();
      const events = await eventsPromise;

      expect(attempts).toBe(transientStreamRetry.maxRetries + 1);
      expect(retryAttempts).toEqual(
        Array.from({ length: transientStreamRetry.maxRetries }, (_value, index) => index + 1),
      );
      expect(events.at(-1)?.type).toBe("error");
      console.info(JSON.stringify({ attempts, retries: retryAttempts.length }));
    } finally {
      random.mockRestore();
      vi.useRealTimers();
    }
  });

  it("uses an aggressive but bounded retry policy with a longer request deadline", () => {
    expect(transientStreamRetry).toEqual({ maxRetries: 7, baseDelayMs: 1_000, maxDelayMs: 30_000 });
    expect(missingFinishReasonRetry).toEqual({ maxRetries: 5, baseDelayMs: 500 });
    expect(DEFAULT_MODEL_TIMEOUT_MS).toBe(600_000);
  });

  it("keeps exponential retry delays jittered and capped", () => {
    const random = vi.spyOn(Math, "random");
    try {
      random.mockReturnValue(0);
      expect(modelRetryDelayMs(1)).toBe(500);
      expect(modelRetryDelayMs(8)).toBe(15_000);
      random.mockReturnValue(0.99999);
      expect(modelRetryDelayMs(8)).toBeLessThanOrEqual(30_000);
      expect(modelRetryDelayMs(8)).toBeGreaterThanOrEqual(15_000);
    } finally {
      random.mockRestore();
    }
  });

  it("interrupts a long retry wait immediately when the caller cancels", async () => {
    const controller = new AbortController();
    const pending = waitForModelRetry(controller.signal, 30_000);
    controller.abort();
    await expect(pending).rejects.toThrow("Request was aborted");
  });
});
