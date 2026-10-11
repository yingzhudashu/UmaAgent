import type { UmaClient } from "@uma-agent/client";
import type { QualityAssessment, Run } from "@uma-agent/protocol";
import { requestErrorMessage } from "./request-error.js";

class QualityResultError extends Error {}

export interface QualityOperationResult {
  run: Run;
  assessments?: QualityAssessment[];
  result?: string;
}

export type QualityOperationState = {
  kind: "review" | "improve";
  status: "submitting" | "queued" | "running" | "completed" | "failed";
  runId?: string;
  error?: string;
  assessments?: readonly QualityAssessment[];
  result?: string;
};

/**
 * 等待质量 Run 进入终态，并从质量历史读取结果。
 * 改进答案保存在独立消息中，不属于会话当前分支，因此不能从活动 transcript 查找。
 */
export async function collectQualityOperation(
  client: Pick<UmaClient, "waitForRun" | "listRunQuality" | "listMessageQuality">,
  messageId: string,
  runId: string,
  kind: "review" | "improve",
): Promise<QualityOperationResult> {
  const run = await client.waitForRun(runId);
  if (run.status !== "completed") return { run };

  if (kind === "review") {
    const assessments = await client.listRunQuality(runId);
    if (assessments.length === 0) throw new QualityResultError("审查任务已完成，但没有返回审查结果。");
    return { run, assessments };
  }

  const history = await client.listMessageQuality(messageId);
  const completed = history.find((item) => item.runId === runId);
  if (!completed?.resultContent)
    throw new QualityResultError("改进任务已完成，但暂时无法读取生成结果，请稍后重试。");
  return { run, result: completed.resultContent };
}

/** 启动一次质量操作并把每个可见状态交给页面，避免按钮点击后只能等待最终结果。 */
export async function runQualityOperation(
  client: Pick<
    UmaClient,
    "reviewMessage" | "improveMessage" | "waitForRun" | "listRunQuality" | "listMessageQuality"
  >,
  messageId: string,
  kind: "review" | "improve",
  publish: (state: QualityOperationState) => void,
): Promise<QualityOperationResult | undefined> {
  publish({ kind, status: "submitting" });
  let runId: string | undefined;
  try {
    const started =
      kind === "review" ? await client.reviewMessage(messageId) : await client.improveMessage(messageId);
    runId = started.runId;
    publish({ kind, status: started.status === "queued" ? "queued" : "running", runId: started.runId });
    const result = await collectQualityOperation(client, messageId, started.runId, kind);
    if (result.run.status !== "completed") {
      publish({
        kind,
        status: "failed",
        runId: started.runId,
        error:
          result.run.error ??
          (result.run.status === "cancelled"
            ? "操作已取消。"
            : result.run.status === "interrupted"
              ? "服务在操作完成前中断，请重试。"
              : "操作未能完成，请重试。"),
      });
      return result;
    }
    publish({
      kind,
      status: "completed",
      runId: started.runId,
      ...(result.assessments ? { assessments: result.assessments } : {}),
      ...(result.result !== undefined ? { result: result.result } : {}),
    });
    return result;
  } catch (error) {
    publish({
      kind,
      status: "failed",
      ...(runId ? { runId } : {}),
      error: error instanceof QualityResultError ? error.message : requestErrorMessage(error),
    });
    return undefined;
  }
}
