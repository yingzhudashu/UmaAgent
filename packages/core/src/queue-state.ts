import type { DatabaseSync } from "node:sqlite";
import type { Run } from "@uma-agent/protocol";
import { integer, row } from "./database-utils.js";
import { prepareStatement } from "./sql-statements.js";

export class QueueStateRepository {
  constructor(private readonly db: DatabaseSync) {}

  getQueueRevision(sessionId: string): number {
    return integer(
      row(prepareStatement(this.db, "SELECT queue_revision FROM sessions WHERE id=?"), sessionId)
        ?.queue_revision || 1,
    );
  }

  bumpQueueRevision(sessionId: string): number {
    prepareStatement(
      this.db,
      "UPDATE sessions SET queue_revision=queue_revision+1,updated_at=? WHERE id=?",
    ).run(Date.now(), sessionId);
    return this.getQueueRevision(sessionId);
  }

  bumpBranchRevision(sessionId: string): number {
    prepareStatement(
      this.db,
      "UPDATE sessions SET branch_revision=branch_revision+1,updated_at=? WHERE id=?",
    ).run(Date.now(), sessionId);
    return integer(
      row(prepareStatement(this.db, "SELECT branch_revision FROM sessions WHERE id=?"), sessionId)
        ?.branch_revision || 1,
    );
  }

  reorderQueuedRuns(sessionId: string, runIds: string[], expectedRevision: number, list: () => Run[]): Run[] {
    if (this.getQueueRevision(sessionId) !== expectedRevision)
      throw new Error(
        `Queue revision conflict: expected ${expectedRevision}, current ${this.getQueueRevision(sessionId)}`,
      );
    const current = list();
    const expected = current.map((run) => run.id);
    if (expected.length !== runIds.length || expected.some((id) => !runIds.includes(id)))
      throw new Error("Queue changed; reload the session snapshot");
    const update = prepareStatement(
      this.db,
      "UPDATE runs SET queue_position=?,updated_at=? WHERE id=? AND session_id=? AND status='queued'",
    );
    runIds.forEach((id, index) => {
      update.run(index + 1, Date.now(), id, sessionId);
    });
    this.bumpQueueRevision(sessionId);
    return list();
  }

  prioritizeQueuedRun(run: Run, list: () => Run[], get: (id: string) => Run): Run {
    const queued = list().filter((item) => item.id !== run.id);
    const update = prepareStatement(this.db, "UPDATE runs SET queue_position=?,updated_at=? WHERE id=?");
    update.run(1, Date.now(), run.id);
    queued.forEach((item, index) => {
      update.run(index + 2, Date.now(), item.id);
    });
    this.bumpQueueRevision(run.sessionId);
    return get(run.id);
  }
}
