import type { Run } from "@uma-agent/protocol";
import type { UmaDatabase } from "./database.js";
import type { EventHub } from "./events.js";

export function syncResumedResponse(
  database: UmaDatabase,
  events: EventHub,
  sessionId: string,
  runId: string,
): void {
  const response = database.responseForRun(runId);
  if (!response) return;
  const updated = database.updateResponse(response.id, {
    status: "queued",
    ...(response.content === "Server restarted during execution" ? { content: "" } : {}),
  });
  const activity = database.addResponseActivity({
    responseId: response.id,
    kind: "status",
    status: "queued",
    text: "已从服务器重启检查点恢复，等待继续执行",
  });
  events.emit(sessionId, runId, "response.updated", updated);
  events.emit(sessionId, runId, "response.activity", { responseId: response.id, activity });
}

export function recoverRestartedRuns(runs: Run[], resume: (runId: string) => Run): void {
  for (const run of runs) {
    try {
      resume(run.id);
    } catch (error) {
      process.emitWarning(
        `Automatic run recovery failed for ${run.id}: ${error instanceof Error ? error.message : String(error)}`,
        { code: "UMA_RUN_RECOVERY" },
      );
    }
  }
}
