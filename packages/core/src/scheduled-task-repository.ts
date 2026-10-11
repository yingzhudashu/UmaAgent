import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { ScheduleDefinition, ScheduledTask, ScheduledTaskRun } from "@uma-agent/protocol";
import { row, rows, text, toScheduledTask, toScheduledTaskRun } from "./database-utils.js";
import { prepareStatement } from "./sql-statements.js";

/**
 * 持久化定时任务及其运行记录。
 *
 * 这组查询有独立的生命周期和恢复语义，单独放在仓储中可以让
 * UmaDatabase 继续只负责连接、事务和领域门面，同时保持所有 SQL
 * 使用同一条 SQLite 连接，避免引入第二个事务边界。
 */
export class ScheduledTaskRepository {
  constructor(private readonly db: DatabaseSync) {}

  createTask(input: {
    ownerId?: string;
    name: string;
    prompt: string;
    messageMode: "agent";
    schedule: ScheduleDefinition;
    enabled: boolean;
    nextRunAt?: number;
  }): ScheduledTask {
    const id = randomUUID();
    const now = Date.now();
    prepareStatement(
      this.db,
      "INSERT INTO scheduled_tasks(id,owner_id,name,prompt,message_mode,schedule_json,enabled,next_run_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
    ).run(
      id,
      input.ownerId ?? "system",
      input.name,
      input.prompt,
      input.messageMode,
      JSON.stringify(input.schedule),
      input.enabled ? 1 : 0,
      input.nextRunAt ?? null,
      now,
      now,
    );
    return this.getTask(id);
  }

  getTask(id: string): ScheduledTask {
    const value = row(prepareStatement(this.db, "SELECT * FROM scheduled_tasks WHERE id=?"), id);
    if (!value) throw new Error(`Scheduled task not found: ${id}`);
    return toScheduledTask(value);
  }

  listTasks(ownerId?: string): ScheduledTask[] {
    return rows(
      ownerId
        ? prepareStatement(this.db, "SELECT * FROM scheduled_tasks WHERE owner_id=? ORDER BY created_at DESC")
        : prepareStatement(this.db, "SELECT * FROM scheduled_tasks ORDER BY created_at DESC"),
      ...(ownerId ? [ownerId] : []),
    ).map(toScheduledTask);
  }

  owner(id: string): string | undefined {
    const value = row(prepareStatement(this.db, "SELECT owner_id FROM scheduled_tasks WHERE id=?"), id);
    return value ? text(value.owner_id) : undefined;
  }

  listDue(now: number): ScheduledTask[] {
    return rows(
      prepareStatement(
        this.db,
        "SELECT * FROM scheduled_tasks WHERE enabled=1 AND next_run_at IS NOT NULL AND next_run_at<=? ORDER BY next_run_at",
      ),
      now,
    ).map(toScheduledTask);
  }

  updateTask(
    id: string,
    patch: Partial<{
      name: string;
      prompt: string;
      messageMode: "agent";
      schedule: ScheduleDefinition;
      enabled: boolean;
      nextRunAt: number | null;
      lastRunAt: number | null;
    }>,
  ): ScheduledTask {
    const current = this.getTask(id);
    const next = {
      name: patch.name ?? current.name,
      prompt: patch.prompt ?? current.prompt,
      messageMode: "agent" as const,
      schedule: patch.schedule ?? current.schedule,
      enabled: patch.enabled ?? current.enabled,
      nextRunAt: patch.nextRunAt === undefined ? current.nextRunAt : (patch.nextRunAt ?? undefined),
      lastRunAt: patch.lastRunAt === undefined ? current.lastRunAt : (patch.lastRunAt ?? undefined),
    };
    prepareStatement(
      this.db,
      "UPDATE scheduled_tasks SET name=?,prompt=?,message_mode=?,schedule_json=?,enabled=?,next_run_at=?,last_run_at=?,updated_at=? WHERE id=?",
    ).run(
      next.name,
      next.prompt,
      next.messageMode,
      JSON.stringify(next.schedule),
      next.enabled ? 1 : 0,
      next.nextRunAt ?? null,
      next.lastRunAt ?? null,
      Date.now(),
      id,
    );
    return this.getTask(id);
  }

  deleteTask(id: string): void {
    const result = prepareStatement(this.db, "DELETE FROM scheduled_tasks WHERE id=?").run(id);
    if (result.changes === 0) throw new Error(`Scheduled task not found: ${id}`);
  }

  createRun(input: {
    scheduledTaskId: string;
    scheduledFor: number;
    occurrenceKey: string;
    trigger: ScheduledTaskRun["trigger"];
  }): ScheduledTaskRun {
    if (this.hasActiveRun(input.scheduledTaskId)) throw new Error("Scheduled task already has an active run");
    const id = randomUUID();
    prepareStatement(
      this.db,
      "INSERT INTO scheduled_task_runs(id,scheduled_task_id,occurrence_key,trigger,status,scheduled_for) VALUES(?,?,?,?,?,?)",
    ).run(id, input.scheduledTaskId, input.occurrenceKey, input.trigger, "claimed", input.scheduledFor);
    return this.getRun(id);
  }

  getRun(id: string): ScheduledTaskRun {
    const value = row(prepareStatement(this.db, "SELECT * FROM scheduled_task_runs WHERE id=?"), id);
    if (!value) throw new Error(`Scheduled task run not found: ${id}`);
    return toScheduledTaskRun(value);
  }

  findRunByRunId(runId: string): ScheduledTaskRun | undefined {
    const value = row(prepareStatement(this.db, "SELECT * FROM scheduled_task_runs WHERE run_id=?"), runId);
    return value ? toScheduledTaskRun(value) : undefined;
  }

  listRuns(scheduledTaskId: string): ScheduledTaskRun[] {
    return rows(
      prepareStatement(
        this.db,
        "SELECT * FROM scheduled_task_runs WHERE scheduled_task_id=? ORDER BY scheduled_for DESC",
      ),
      scheduledTaskId,
    ).map(toScheduledTaskRun);
  }

  hasActiveRun(scheduledTaskId: string): boolean {
    return Boolean(
      row(
        prepareStatement(
          this.db,
          "SELECT 1 AS ok FROM scheduled_task_runs WHERE scheduled_task_id=? AND status IN ('claimed','running','awaiting_resume') LIMIT 1",
        ),
        scheduledTaskId,
      ),
    );
  }

  updateRun(
    id: string,
    patch: Partial<{
      backgroundTaskId: string;
      runId: string;
      status: ScheduledTaskRun["status"];
      resume: ScheduledTaskRun["resume"] | null;
      startedAt: number;
      completedAt: number;
      error: string | null;
    }>,
  ): ScheduledTaskRun {
    const current = this.getRun(id);
    prepareStatement(
      this.db,
      "UPDATE scheduled_task_runs SET background_task_id=?,run_id=?,status=?,resume_json=?,started_at=?,completed_at=?,error=? WHERE id=?",
    ).run(
      patch.backgroundTaskId ?? current.backgroundTaskId ?? null,
      patch.runId ?? current.runId ?? null,
      patch.status ?? current.status,
      patch.resume === undefined
        ? current.resume
          ? JSON.stringify(current.resume)
          : null
        : patch.resume
          ? JSON.stringify(patch.resume)
          : null,
      patch.startedAt ?? current.startedAt ?? null,
      patch.completedAt ?? current.completedAt ?? null,
      patch.error === undefined ? (current.error ?? null) : patch.error,
      id,
    );
    return this.getRun(id);
  }

  recoverRuns(): ScheduledTaskRun[] {
    prepareStatement(
      this.db,
      "UPDATE background_tasks SET status='pending',error=NULL,updated_at=? WHERE status='interrupted' AND run_id IS NULL AND id IN (SELECT background_task_id FROM scheduled_task_runs WHERE status='running' AND run_id IS NULL)",
    ).run(Date.now());
    prepareStatement(
      this.db,
      "UPDATE scheduled_task_runs SET status='claimed',error=NULL WHERE status='running' AND run_id IS NULL",
    ).run();
    prepareStatement(
      this.db,
      "UPDATE scheduled_task_runs SET status='awaiting_resume',error='Background run requires explicit resume' WHERE status='running' AND run_id IS NOT NULL",
    ).run();
    return rows(
      prepareStatement(
        this.db,
        "SELECT * FROM scheduled_task_runs WHERE status IN ('claimed','awaiting_resume') ORDER BY scheduled_for",
      ),
    ).map(toScheduledTaskRun);
  }

  markActiveBackgroundTasksInterrupted(): void {
    prepareStatement(
      this.db,
      "UPDATE background_tasks SET status='interrupted',error='Server restarted during execution',updated_at=? WHERE status IN ('pending','running')",
    ).run(Date.now());
  }
}
