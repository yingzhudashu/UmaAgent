import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import type { RunPreflight } from "../src/run-preflight.js";
import { RunQualityService } from "../src/run-quality.js";

function serviceWith(...texts: string[]) {
  const complete = vi.fn(async () => fauxAssistantMessage(texts.shift() ?? "{}"));
  const service = new RunQualityService({ complete } as unknown as RunPreflight);
  return { service, complete };
}

describe("RunQualityService", () => {
  it("repairs one malformed response and performs at most three tool-free review iterations", async () => {
    const { service, complete } = serviceWith(
      "not-json",
      JSON.stringify({
        passed: false,
        issues: [{ type: "clarity", description: "unclear" }],
        suggestions: ["be direct"],
        improvedAnswer: "second",
      }),
      JSON.stringify({
        passed: false,
        issues: [{ type: "omission", description: "missing detail" }],
        suggestions: ["add detail"],
        improvedAnswer: "third",
      }),
      JSON.stringify({ passed: true, issues: [], suggestions: [] }),
    );
    const result = await service.review(
      "run",
      "question",
      "first",
      "user feedback",
      new AbortController().signal,
    );
    expect(result).toHaveLength(3);
    expect(result.at(-1)?.passed).toBe(true);
    expect(complete).toHaveBeenCalledTimes(4);
    expect(complete.mock.calls.every((call) => call[5] === true)).toBe(true);
  });

  it("stops review when no actionable revision is available", async () => {
    for (const payload of [
      { passed: false, issues: [], suggestions: ["none"] },
      {
        passed: false,
        issues: [{ type: "logic_error", description: "issue" }],
        suggestions: ["fix"],
      },
    ]) {
      const { service, complete } = serviceWith(JSON.stringify(payload));
      await expect(service.review("run", "q", "a", "", new AbortController().signal)).resolves.toHaveLength(
        1,
      );
      expect(complete).toHaveBeenCalledOnce();
    }
  });

  it("improves an answer and rejects repeated contract violations", async () => {
    const valid = serviceWith(JSON.stringify({ improvedAnswer: "better" }));
    await expect(
      valid.service.improve("run", "q", "a", ["clear", "complete"], new AbortController().signal),
    ).resolves.toEqual({ improvedAnswer: "better" });

    const invalid = serviceWith("{}", "still invalid");
    await expect(invalid.service.improve("run", "q", "a", [], new AbortController().signal)).rejects.toThrow(
      "Provider contract error",
    );
  });

  it("surfaces provider errors and aborts without attempting format repair", async () => {
    for (const stopReason of ["error", "aborted"] as const) {
      const response = fauxAssistantMessage("");
      response.stopReason = stopReason;
      response.errorMessage = `${stopReason} by provider`;
      const complete = vi.fn(async () => response);
      const service = new RunQualityService({ complete } as unknown as RunPreflight);
      await expect(service.review("run", "q", "a", "", new AbortController().signal)).rejects.toThrow(
        `${stopReason} by provider`,
      );
      expect(complete).toHaveBeenCalledOnce();
    }
  });
});
