import type { Run } from "@uma-agent/protocol";
import type { UmaDatabase } from "./database.js";
import type { EventHub, EventListener } from "./events.js";

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

export async function recoverRestartedRuns(
  runs: Run[],
  resume: (runId: string) => Run,
  waitForTerminal: (runId: string) => Promise<void>,
  shouldContinue: () => boolean = () => true,
  recordAttempt: (runId: string) => void = () => undefined,
  delayMs = 2_000,
): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, delayMs));
  for (const run of runs) {
    if (!shouldContinue()) return;
    try {
      recordAttempt(run.id);
      resume(run.id);
      await waitForTerminal(run.id);
    } catch (error) {
      process.emitWarning(
        `Automatic run recovery failed for ${run.id}: ${error instanceof Error ? error.message : String(error)}`,
        { code: "UMA_RUN_RECOVERY" },
      );
    }
  }
}

export function waitForRunTerminal(
  getRun: (runId: string) => Run,
  subscribe: (listener: EventListener) => () => void,
  runId: string,
  timeoutMs = 5 * 60_000,
): Promise<void> {
  const terminal = new Set<Run["status"]>([
    "completed",
    "failed",
    "cancelled",
    "awaiting_input",
    "interrupted",
  ]);
  if (terminal.has(getRun(runId).status)) return Promise.resolve();
  return new Promise((resolve) => {
    let unsubscribe: () => void = () => undefined;
    const timer = setTimeout(() => {
      unsubscribe();
      resolve();
    }, timeoutMs);
    unsubscribe = subscribe((event) => {
      if (event.runId !== runId || event.type !== "run.updated") return;
      if (!terminal.has((event.payload as Run).status)) return;
      clearTimeout(timer);
      unsubscribe();
      resolve();
    });
  });
}
