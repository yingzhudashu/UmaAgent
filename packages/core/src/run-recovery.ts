import type { DatabaseSync } from "node:sqlite";
import type { Run } from "@uma-agent/protocol";
import { rows, text } from "./database-utils.js";

export const SERVER_RESTART_ERROR = "Server restarted during execution";

export function findRestartRecoverableRuns(db: DatabaseSync, getRun: (id: string) => Run): Run[] {
  return rows(
    db.prepare(
      `SELECT r.id
       FROM runs r
       WHERE r.status='interrupted'
         AND r.error=?
         AND (SELECT c.safe_to_resume
              FROM run_checkpoints c
              WHERE c.run_id=r.id
              ORDER BY c.checkpoint_no DESC
              LIMIT 1)=1
         AND NOT EXISTS (
           SELECT 1
           FROM run_actions a
           WHERE a.run_id=r.id
             AND a.status IN ('uncertain','prepared','running')
             AND a.tool_class NOT IN ('read','attachment_read')
         )
         AND NOT EXISTS (SELECT 1 FROM background_tasks b WHERE b.run_id=r.id)
       ORDER BY r.created_at, r.id`,
    ),
    SERVER_RESTART_ERROR,
  )
    .map((value) => getRun(text(value.id)))
    .filter((run) => run.resume?.state === "available");
}
