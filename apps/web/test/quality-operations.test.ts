import type { UmaClient } from "@uma-agent/client";
import type { Run, SendMessageResponse } from "@uma-agent/protocol";
import { describe, expect, it, vi } from "vitest";
import { collectQualityOperation, runQualityOperation } from "../src/quality-operations.js";

function run(status: Run["status"], error?: string): Run {
  return { status, ...(error ? { error } : {}) } as Run;
}

describe("collectQualityOperation", () => {
  it("reads the improved answer from quality history, outside the active transcript", async () => {
    const client = {
      waitForRun: vi.fn().mockResolvedValue(run("completed")),
      listRunQuality: vi.fn(),
      listMessageQuality: vi.fn().mockResolvedValue([{ runId: "run-1", resultContent: "改进后的答案" }]),
    } as unknown as UmaClient;

    await expect(collectQualityOperation(client, "message-1", "run-1", "improve")).resolves.toMatchObject({
      run: { status: "completed" },
      result: "改进后的答案",
    });
    expect(client.listRunQuality).not.toHaveBeenCalled();
  });

  it("returns a failed terminal Run without reporting a false success", async () => {
    const client = {
      waitForRun: vi.fn().mockResolvedValue(run("failed", "Provider request failed")),
      listRunQuality: vi.fn(),
      listMessageQuality: vi.fn(),
    } as unknown as UmaClient;

    await expect(collectQualityOperation(client, "message-1", "run-1", "review")).resolves.toMatchObject({
      run: { status: "failed", error: "Provider request failed" },
    });
    expect(client.listRunQuality).not.toHaveBeenCalled();
    expect(client.listMessageQuality).not.toHaveBeenCalled();
  });

  it("loads review assessments for the exact completed Run", async () => {
    const assessments = [
      {
        id: "assessment-1",
        runId: "run-1",
        targetMessageId: "message-1",
        passed: true,
        issues: [],
        suggestions: [],
        iteration: 1,
        createdAt: 1,
      },
    ];
    const client = {
      waitForRun: vi.fn().mockResolvedValue(run("completed")),
      listRunQuality: vi.fn().mockResolvedValue(assessments),
      listMessageQuality: vi.fn(),
    } as unknown as UmaClient;

    await expect(collectQualityOperation(client, "message-1", "run-1", "review")).resolves.toMatchObject({
      assessments,
    });
  });

  it("publishes submission and queue feedback, then exposes a failed Run immediately", async () => {
    const publish = vi.fn();
    const client = {
      reviewMessage: vi.fn().mockResolvedValue({ runId: "run-1", status: "queued" } as SendMessageResponse),
      improveMessage: vi.fn(),
      waitForRun: vi.fn().mockResolvedValue(run("failed", "模型服务暂时不可用")),
      listRunQuality: vi.fn(),
      listMessageQuality: vi.fn(),
    } as unknown as UmaClient;

    const pending = runQualityOperation(client, "message-1", "review", publish);
    expect(publish).toHaveBeenNthCalledWith(1, { kind: "review", status: "submitting" });
    await expect(pending).resolves.toMatchObject({ run: { status: "failed" } });
    expect(publish).toHaveBeenNthCalledWith(2, {
      kind: "review",
      status: "queued",
      runId: "run-1",
    });
    expect(publish).toHaveBeenLastCalledWith({
      kind: "review",
      status: "failed",
      runId: "run-1",
      error: "模型服务暂时不可用",
    });
  });
});
