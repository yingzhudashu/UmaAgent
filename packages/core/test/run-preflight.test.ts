import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import type { Session } from "@uma-agent/protocol";
import { describe, expect, it, vi } from "vitest";
import type { UmaDatabase } from "../src/database.js";
import type { ModelRegistry } from "../src/models.js";
import { RunPreflight } from "../src/run-preflight.js";

const session: Session = {
  id: "session",
  mode: "workspace",
  title: "Test",
  workspace: "C:/workspace",
  model: { provider: "faux", id: "model" },
  thinkingLevel: "off",
  queueMode: "queue",
  createdAt: 1,
  updatedAt: 1,
};

function fixture(memory: string[] = []) {
  const database = {
    searchMemory: vi.fn(() => memory),
    addAudit: vi.fn(),
  };
  const models = { forRole: vi.fn(() => ({ provider: "faux", id: "model" })) };
  const preflight = new RunPreflight(database as unknown as UmaDatabase, models as unknown as ModelRegistry);
  return { preflight, database, models };
}

function errorResponse(message = "provider failed") {
  const response = fauxAssistantMessage("");
  response.stopReason = "error";
  response.errorMessage = message;
  return response;
}

describe("RunPreflight.decide", () => {
  it("routes explicit direct work without a control model call", async () => {
    const { preflight } = fixture();
    const complete = vi.spyOn(preflight, "complete");
    await expect(
      preflight.decide(session, "answer it", "direct", new AbortController().signal, "run"),
    ).resolves.toMatchObject({ taskClass: "simple", route: "direct", goal: "answer it" });
    expect(complete).not.toHaveBeenCalled();
  });

  it("repairs classification and preflight JSON, injects memory, and supplies a fallback plan step", async () => {
    const { preflight, database } = fixture(["Prefers TypeScript"]);
    const complete = vi
      .spyOn(preflight, "complete")
      .mockResolvedValueOnce(fauxAssistantMessage("invalid"))
      .mockResolvedValueOnce(fauxAssistantMessage('{"taskClass":"complex"}'))
      .mockResolvedValueOnce(fauxAssistantMessage("still invalid"))
      .mockResolvedValueOnce(
        fauxAssistantMessage(
          JSON.stringify({
            taskClass: "complex",
            route: "plan",
            goal: "ship it",
            reasoningSummary: "Needs steps",
            successCriteria: ["done"],
            questions: [],
            steps: [],
          }),
        ),
      );
    const result = await preflight.decide(
      session,
      "build feature",
      "auto",
      new AbortController().signal,
      "run",
    );
    expect(result).toMatchObject({ taskClass: "complex", route: "plan", steps: ["ship it"] });
    expect(database.searchMemory).toHaveBeenCalledWith("session", "build feature", 5);
    expect(complete.mock.calls.some((call) => String(call[3]).includes("Prefers TypeScript"))).toBe(true);
    expect(database.addAudit).toHaveBeenCalledOnce();
  });

  it("rejects failed or repeatedly invalid classification responses", async () => {
    const failed = fixture().preflight;
    vi.spyOn(failed, "complete").mockResolvedValue(errorResponse("classification unavailable"));
    await expect(failed.decide(session, "work", "auto", new AbortController().signal, "run")).rejects.toThrow(
      "classification unavailable",
    );

    const repairFailed = fixture().preflight;
    vi.spyOn(repairFailed, "complete")
      .mockResolvedValueOnce(fauxAssistantMessage("invalid"))
      .mockResolvedValueOnce(errorResponse("repair unavailable"));
    await expect(
      repairFailed.decide(session, "work", "auto", new AbortController().signal, "run"),
    ).rejects.toThrow("repair unavailable");

    const invalid = fixture().preflight;
    vi.spyOn(invalid, "complete")
      .mockResolvedValueOnce(fauxAssistantMessage("invalid"))
      .mockResolvedValueOnce(fauxAssistantMessage("also invalid"));
    await expect(
      invalid.decide(session, "work", "auto", new AbortController().signal, "run"),
    ).rejects.toThrow("Provider contract error: invalid task classification");
  });

  it("enforces safe standard and complex routing contracts", async () => {
    const cases = [
      {
        mode: "plan" as const,
        response: {
          taskClass: "complex",
          route: "direct",
          goal: "goal",
          reasoningSummary: "bad",
          successCriteria: ["done"],
          questions: [],
          steps: [],
        },
        error: "complex tasks require",
      },
      {
        mode: "auto" as const,
        classification: '{"taskClass":"standard"}',
        response: {
          taskClass: "standard",
          route: "clarify",
          goal: "goal",
          reasoningSummary: "ask",
          successCriteria: ["done"],
          questions: [],
          steps: [],
        },
        error: "requires questions",
      },
    ];
    for (const value of cases) {
      const { preflight } = fixture();
      const responses = [
        ...(value.classification ? [fauxAssistantMessage(value.classification)] : []),
        fauxAssistantMessage(JSON.stringify(value.response)),
      ];
      vi.spyOn(preflight, "complete").mockImplementation(async () => {
        const response = responses.shift();
        if (!response) throw new Error("test response queue exhausted");
        return response;
      });
      await expect(
        preflight.decide(session, "work", value.mode, new AbortController().signal, "run"),
      ).rejects.toThrow(value.error);
    }
  });

  it("reports failed and invalid preflight repair responses", async () => {
    const failed = fixture().preflight;
    vi.spyOn(failed, "complete").mockResolvedValue(errorResponse("preflight unavailable"));
    await expect(failed.decide(session, "work", "plan", new AbortController().signal, "run")).rejects.toThrow(
      "preflight unavailable",
    );

    const invalid = fixture().preflight;
    vi.spyOn(invalid, "complete")
      .mockResolvedValueOnce(fauxAssistantMessage("invalid"))
      .mockResolvedValueOnce(fauxAssistantMessage("still invalid"));
    await expect(
      invalid.decide(session, "work", "plan", new AbortController().signal, "run"),
    ).rejects.toThrow("Provider contract error: invalid preflight response");
  });
});

describe("RunPreflight.complete", () => {
  function completionFixture(completeSimple: ReturnType<typeof vi.fn>) {
    const database = {
      startModelCall: vi.fn(() => `call-${Math.random()}`),
      finishModelCall: vi.fn(),
    };
    const models = {
      forRole: vi.fn(() => ({ provider: "faux", id: "model" })),
      models: { completeSimple },
    };
    return {
      preflight: new RunPreflight(database as unknown as UmaDatabase, models as unknown as ModelRegistry),
      database,
    };
  }

  it("retries transient public-free responses and records every model lifecycle", async () => {
    const transient = errorResponse("HTTP 429 rate limit");
    const completeSimple = vi
      .fn()
      .mockResolvedValueOnce(transient)
      .mockResolvedValueOnce(fauxAssistantMessage("ok"));
    const { preflight, database } = completionFixture(completeSimple);
    await expect(
      preflight.complete("run", "fast", "system", "prompt", new AbortController().signal),
    ).resolves.toMatchObject({ stopReason: "stop" });
    expect(completeSimple).toHaveBeenCalledTimes(2);
    expect(database.startModelCall).toHaveBeenCalledTimes(2);
    expect(database.finishModelCall).toHaveBeenCalledTimes(2);
  });

  it("does not retry when retries are disabled or an error is not transient", async () => {
    const response = errorResponse("HTTP 503 unavailable");
    const disabled = completionFixture(vi.fn(async () => response));
    await expect(
      disabled.preflight.complete(
        "run",
        "reasoning",
        "system",
        "prompt",
        new AbortController().signal,
        false,
      ),
    ).resolves.toBe(response);

    const thrown = completionFixture(vi.fn(async () => Promise.reject(new Error("invalid schema"))));
    await expect(
      thrown.preflight.complete("run", "fast", "system", "prompt", new AbortController().signal),
    ).rejects.toThrow("invalid schema");
    expect(thrown.database.finishModelCall).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ status: "failed", error: "invalid schema" }),
    );
  });

  it("stops retrying thrown transient errors when aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const completeSimple = vi.fn(async () => Promise.reject("network timeout"));
    const { preflight, database } = completionFixture(completeSimple);
    await expect(preflight.complete("run", "fast", "system", "prompt", controller.signal)).rejects.toBe(
      "network timeout",
    );
    expect(completeSimple).toHaveBeenCalledOnce();
    expect(database.finishModelCall).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ status: "aborted", error: "network timeout" }),
    );
  });
});
