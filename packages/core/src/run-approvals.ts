import type { Approval } from "@uma-agent/protocol";
import type { UmaDatabase } from "./database.js";
import type { EventHub } from "./events.js";
import type { PendingApproval } from "./runtime-support.js";

/** Owns approval persistence, idempotent decisions, timeout, cancellation and shutdown rejection. */
export class RunApprovals {
  private readonly pending = new Map<string, PendingApproval>();

  constructor(
    private readonly database: UmaDatabase,
    private readonly events: EventHub,
    private readonly timeoutMs: number,
  ) {}

  rejectAll(): void {
    for (const id of [...this.pending.keys()]) this.resolve(id, false);
  }

  resolve(id: string, approved: boolean): Approval {
    const current = this.database.getApproval(id);
    if (current.status !== "pending") return current;
    const approval = this.events.transaction(() => {
      const value = this.database.resolveApproval(id, approved);
      this.database.addAudit({
        runId: value.runId,
        kind: "approval",
        name: value.toolName,
        input: { toolCallId: value.toolCallId },
        status: approved ? "approved" : "denied",
      });
      this.events.emit(value.sessionId, value.runId, "approval.resolved", value);
      return value;
    });
    const waiting = this.pending.get(id);
    if (waiting) {
      clearTimeout(waiting.timer);
      this.pending.delete(id);
      waiting.resolve(approved);
    }
    return approval;
  }

  request(input: {
    sessionId: string;
    runId: string;
    toolCallId: string;
    toolName: string;
    args: unknown;
    signal: AbortSignal;
  }): Promise<boolean> {
    let waiting: Promise<boolean> | undefined;
    this.events.transaction(() => {
      const approval = this.database.createApproval(input);
      this.database.addAudit({
        runId: input.runId,
        kind: "approval",
        name: input.toolName,
        input: { toolCallId: input.toolCallId },
        status: "pending",
      });
      waiting = new Promise<boolean>((resolve) => {
        const finish = (approved: boolean) => {
          input.signal.removeEventListener("abort", abort);
          resolve(approved);
        };
        const abort = () => {
          const pending = this.pending.get(approval.id);
          if (!pending) return;
          clearTimeout(pending.timer);
          this.pending.delete(approval.id);
          this.events.transaction(() => {
            const expired = this.database.expireApproval(approval.id);
            this.database.addAudit({
              runId: input.runId,
              kind: "approval",
              name: input.toolName,
              input: { toolCallId: input.toolCallId },
              status: "expired",
            });
            this.events.emit(input.sessionId, input.runId, "approval.resolved", expired);
          });
          finish(false);
        };
        const timer = setTimeout(abort, this.timeoutMs);
        this.pending.set(approval.id, { resolve: finish, timer });
        input.signal.addEventListener("abort", abort, { once: true });
        if (input.signal.aborted) abort();
      });
      this.events.emit(input.sessionId, input.runId, "approval.requested", approval);
    });
    return waiting as Promise<boolean>;
  }
}
