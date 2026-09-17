import type { DatabaseSync } from "node:sqlite";
import { prepareStatement } from "./sql-statements.js";

/** 账号执行策略存储；写事务由 UmaDatabase 统一持有。 */
export class ExecutionPolicyRepository {
  constructor(private readonly db: DatabaseSync) {}
  /** 只查询真正待许可的记录，切换策略不解析该账号的所有历史正文。 */
  pendingExecutionPermissions(userId: string): { approvalIds: string[]; planRunIds: string[] } {
    const approvalIds = prepareStatement(
      this.db,
      "SELECT a.id FROM approvals a JOIN sessions s ON s.id=a.session_id WHERE s.user_id=? AND a.status='pending'",
    )
      .all(userId)
      .map((row) => String(row.id));
    const planRunIds = prepareStatement(
      this.db,
      "SELECT r.id FROM runs r JOIN sessions s ON s.id=r.session_id WHERE s.user_id=? AND r.status='awaiting_confirmation'",
    )
      .all(userId)
      .map((row) => String(row.id));
    return { approvalIds, planRunIds };
  }

  getExecutionSettings(userId: string): { autoApprove: boolean } {
    const value = prepareStatement(this.db, "SELECT auto_approve FROM users WHERE id=?").get(userId);
    if (!value) throw new Error("User not found");
    return { autoApprove: Number(value.auto_approve) === 1 };
  }

  setExecutionSettings(userId: string, autoApprove: boolean): { autoApprove: boolean } {
    if (
      !prepareStatement(this.db, "UPDATE users SET auto_approve=?,updated_at=? WHERE id=?").run(
        Number(autoApprove),
        Date.now(),
        userId,
      ).changes
    )
      throw new Error("User not found");
    prepareStatement(
      this.db,
      "INSERT INTO account_execution_audit(user_id,auto_approve,created_at) VALUES(?,?,?)",
    ).run(userId, Number(autoApprove), Date.now());
    return { autoApprove };
  }
}
