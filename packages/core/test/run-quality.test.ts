import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { RunQualityService } from "../src/run-quality.js";

function context() {
  return {
    runId: "run",
    sessionId: "session",
    messages: [{ role: "user", content: "question", timestamp: 1 }],
    signal: new AbortController().signal,
  } as const;
}

function serviceWith(...texts: string[]) {
  const complete = vi.fn(async () => fauxAssistantMessage(texts.shift() ?? "{}"));
  const service = new RunQualityService({ complete } as never);
  return { service, complete };
}

describe("RunQualityService", () => {
  it("repairs malformed responses and preserves the context prefix", async () => {
    const { service, complete } = serviceWith(
      "not-json",
      JSON.stringify({ passed: true, issues: [], suggestions: [] }),
    );
    await expect(service.review(context(), "question", "answer", "")).resolves.toHaveLength(1);
    expect(complete).toHaveBeenCalledTimes(2);
    expect(complete.mock.calls[1]?.[0].messages[0]).toEqual(complete.mock.calls[0]?.[0].messages[0]);
  });

  it("stops review when no revision is available", async () => {
    const { service, complete } = serviceWith(
      JSON.stringify({ passed: false, issues: [], suggestions: ["none"] }),
    );
    await expect(service.review(context(), "q", "a", "")).resolves.toHaveLength(1);
    expect(complete).toHaveBeenCalledOnce();
  });

  it("improves an answer and rejects invalid contracts", async () => {
    const valid = serviceWith(JSON.stringify({ improvedAnswer: "better" }));
    await expect(valid.service.improve(context(), "q", "a", ["clear"])).resolves.toEqual({
      improvedAnswer: "better",
    });
    const invalid = serviceWith("{}", "still invalid");
    await expect(invalid.service.improve(context(), "q", "a", [])).rejects.toThrow("Provider contract error");
  });

  it("surfaces provider errors without format repair", async () => {
    const response = fauxAssistantMessage("");
    response.stopReason = "error";
    response.errorMessage = "provider failed";
    const complete = vi.fn(async () => response);
    const service = new RunQualityService({ complete } as never);
    await expect(service.review(context(), "q", "a", "")).rejects.toThrow("provider failed");
    expect(complete).toHaveBeenCalledOnce();
  });
});
