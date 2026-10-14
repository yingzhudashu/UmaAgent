import { createAssistantMessageEventStream, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import {
  recoverMissingFinishReason,
  retryMissingFinishReasonStream,
  traceProviderRetries,
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
      return source;
    };
    const recovered = retryMissingFinishReasonStream(create, new AbortController().signal, (attempt) => {
      attempts.push(attempt);
    });
    let finalMessage: ReturnType<typeof fauxAssistantMessage> | undefined;
    for await (const event of recovered) if (event.type === "error") finalMessage = event.error;
    expect(attempts).toEqual([1, 2]);
    expect(finalMessage?.errorMessage).toBe("Stream ended without finish_reason");
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
});
