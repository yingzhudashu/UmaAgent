import { afterEach, describe, expect, it } from "vitest";
import {
  decisionFrom,
  extractJson,
  injectRuntimeFault,
  isSecretLike,
  isTransientProviderError,
  Semaphore,
  textFromMessage,
} from "../src/runtime-support.js";

afterEach(() => {
  delete process.env.UMA_TEST_FAULT_POINT;
  delete process.env.UMA_TEST_FAULT_MODE;
});

describe("runtime support", () => {
  it("serializes semaphore waiters", async () => {
    const semaphore = new Semaphore(1);
    const first = await semaphore.acquire();
    expect(semaphore.count()).toBe(1);
    let entered = false;
    const second = semaphore.acquire().then((release) => {
      entered = true;
      release();
    });
    await Promise.resolve();
    expect(entered).toBe(false);
    first();
    await second;
    expect(semaphore.count()).toBe(0);
  });

  it("normalizes public message text", () => {
    expect(textFromMessage({ role: "user", content: "hello", timestamp: 1 })).toBe("hello");
    expect(
      textFromMessage({
        role: "user",
        content: [
          { type: "text", text: "one" },
          { type: "image", data: "AA==", mimeType: "image/png" },
          { type: "text", text: "two" },
        ],
        timestamp: 1,
      }),
    ).toBe("one\ntwo");
    expect(
      textFromMessage({
        role: "toolResult",
        toolCallId: "call",
        toolName: "read",
        content: [{ type: "text", text: "result" }],
        isError: false,
        timestamp: 1,
      }),
    ).toBe("result");
    expect(textFromMessage({ role: "system", content: "hidden", timestamp: 1 })).toBe("");
  });

  it("parses fenced and plain structured output", () => {
    expect(extractJson('{"ok":true}')).toEqual({ ok: true });
    expect(extractJson('```json\n{"ok":true}\n```')).toEqual({ ok: true });
    expect(() => extractJson("not-json")).toThrow();
  });

  it("validates preflight decisions strictly", () => {
    const decision = {
      taskClass: "standard" as const,
      route: "clarify" as const,
      goal: "goal",
      reasoningSummary: "summary",
      successCriteria: ["done"],
      questions: ["which?"],
      steps: [],
    };
    expect(decisionFrom(decision)).toBe(decision);
    expect(() => decisionFrom({ ...decision, unexpected: true })).toThrow("invalid");
  });

  it("recognizes secrets and transient provider failures", () => {
    expect(isSecretLike("api_key=hidden")).toBe(true);
    expect(isSecretLike("ordinary preference")).toBe(false);
    expect(isTransientProviderError(new Error("429 rate limit"))).toBe(true);
    expect(isTransientProviderError("socket hang up")).toBe(true);
    expect(isTransientProviderError(new Error("invalid request"))).toBe(false);
  });

  it("only injects configured faults in tests", () => {
    process.env.UMA_TEST_FAULT_POINT = "preflight.completed";
    expect(() => injectRuntimeFault("model.started")).not.toThrow();
    expect(() => injectRuntimeFault("preflight.completed")).toThrow("Injected runtime fault");
  });
});
