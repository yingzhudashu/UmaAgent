import { describe, expect, it, vi } from "vitest";
import { installRuntimeLogging } from "../src/runtimeLogging.js";

describe("runtime logging", () => {
  it("records redacted tool failures and run transitions without logging unrelated events", () => {
    let listener: ((event: unknown) => void) | undefined;
    const runtime = {
      subscribe: (next: (event: unknown) => void) => {
        listener = next;
        return () => {
          listener = undefined;
        };
      },
    };
    const app = {
      log: { warn: vi.fn(), info: vi.fn() },
    };
    const unsubscribe = installRuntimeLogging(runtime as never, app as never);

    listener?.({
      type: "tool.completed",
      sessionId: "session-1",
      runId: "run-1",
      payload: {
        toolName: "browser",
        isError: true,
        item: { content: "failed at https://example.test/private?token=secret", name: "browser" },
      },
    });
    listener?.({
      type: "tool.completed",
      sessionId: "session-1",
      runId: "run-1",
      payload: { isError: false },
    });
    listener?.({
      type: "run.updated",
      sessionId: "session-1",
      runId: "run-1",
      payload: {
        id: "run-1",
        model: { ref: { provider: "faux", id: "model" } },
        status: "failed",
        phase: "execute",
        createdAt: 100,
        updatedAt: 160,
        error: "authorization=secret-token",
      },
    });
    listener?.({
      type: "run.updated",
      sessionId: "session-1",
      runId: "run-1",
      payload: {
        id: "run-1",
        model: { ref: { provider: "faux", id: "model" } },
        status: "completed",
        phase: "execute",
        createdAt: 100,
        updatedAt: 200,
      },
    });
    listener?.({ type: "session.updated", sessionId: "session-1", runId: "run-1", payload: {} });

    expect(app.log.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "session-1",
        runId: "run-1",
        toolName: "browser",
        error: expect.not.stringContaining("token=secret"),
      }),
      "tool execution failed",
    );
    expect(app.log.info).toHaveBeenCalledTimes(2);
    expect(app.log.info).toHaveBeenCalledWith(
      expect.objectContaining({ status: "failed", phase: "execute", durationMs: 60 }),
      "run state changed",
    );
    expect(app.log.info).toHaveBeenCalledWith(
      expect.objectContaining({ status: "completed", phase: "execute", durationMs: 100 }),
      "run state changed",
    );

    unsubscribe();
    expect(listener).toBeUndefined();
  });
});
