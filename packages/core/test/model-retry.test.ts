import { createAssistantMessageEventStream, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { recoverMissingFinishReason, retryMissingFinishReasonStream } from "../src/model-retry.js";

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
});
