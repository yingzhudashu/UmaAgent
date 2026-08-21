import { randomUUID } from "node:crypto";
import type {
  BackgroundTask,
  CreateScheduledTaskRequest,
  ScheduleDefinition,
  ScheduledTask,
  ScheduledTaskRun,
  UpdateScheduledTaskRequest,
} from "@uma-agent/protocol";
import { Cron } from "croner";
import type { UmaDatabase } from "./database.js";

export interface ScheduledTaskExecutor {
  prepareScheduledTask(
    prompt: string,
    sessionMode: "workspace" | "assistant",
    source: NonNullable<BackgroundTask["source"]>,
  ): BackgroundTask;
  startTask(id: string): void;
  getTask(id: string): BackgroundTask;
  cancelTask(id: string): BackgroundTask;
}

export function nextScheduleTime(schedule: ScheduleDefinition, after = Date.now()): number | undefined {
  if (schedule.kind === "once") return schedule.at;
  if (schedule.kind === "interval") return after + schedule.everyMs;
  const next = new Cron(schedule.expression, { timezone: schedule.timezone, paused: true }).nextRun(
    new Date(after),
  );
  return next?.getTime();
}

export class SchedulerService {
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly running = new Set<string>();

  constructor(
    private readonly database: UmaDatabase,
    private readonly executor: ScheduledTaskExecutor,
    private readonly changed: () => void = () => undefined,
  ) {}

  start(): void {
    if (this.timer) return;
    for (const run of this.database.recoverScheduledTaskRuns()) {
      if (run.status === "claimed") this.launch(run);
    }
    this.timer = setInterval(() => void this.tick(), 5_000);
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  list(): ScheduledTask[] {
    return this.database.listScheduledTasks();
  }

  create(input: CreateScheduledTaskRequest): ScheduledTask {
    const schedule = input.schedule;
    const enabled = input.enabled ?? true;
    const nextRunAt = enabled ? nextScheduleTime(schedule) : undefined;
    if (enabled && nextRunAt === undefined) throw new Error("Schedule has no future execution time");
    const result = this.database.createScheduledTask({
      name: input.name,
      prompt: input.prompt,
      sessionMode: input.sessionMode ?? "assistant",
      schedule,
      enabled,
      ...(nextRunAt !== undefined ? { nextRunAt } : {}),
    });
    this.changed();
    return result;
  }

  update(id: string, patch: UpdateScheduledTaskRequest): ScheduledTask {
    const current = this.database.getScheduledTask(id);
    const schedule = patch.schedule ?? current.schedule;
    const enabled = patch.enabled ?? current.enabled;
    const nextRunAt = enabled ? nextScheduleTime(schedule) : undefined;
    if (enabled && nextRunAt === undefined) throw new Error("Schedule has no future execution time");
    const result = this.database.updateScheduledTask(id, {
      ...patch,
      enabled,
      schedule,
      nextRunAt: nextRunAt ?? null,
    });
    this.changed();
    return result;
  }

  delete(id: string): void {
    if (this.database.hasActiveScheduledTaskRun(id))
      throw new Error("Cannot delete a scheduled task while it is running");
    this.database.deleteScheduledTask(id);
    this.changed();
  }

  runs(id: string): ScheduledTaskRun[] {
    this.database.getScheduledTask(id);
    return this.database.listScheduledTaskRuns(id);
  }

  getRun(id: string): ScheduledTaskRun {
    return this.database.getScheduledTaskRun(id);
  }

  runNow(id: string): ScheduledTaskRun {
    return this.trigger(this.database.getScheduledTask(id), Date.now(), "manual");
  }

  cancelRun(id: string): ScheduledTaskRun {
    const run = this.database.getScheduledTaskRun(id);
    if (["completed", "failed", "cancelled"].includes(run.status)) return run;
    if (run.backgroundTaskId) this.executor.cancelTask(run.backgroundTaskId);
    const updated = this.database.updateScheduledTaskRun(id, {
      status: "cancelled",
      completedAt: Date.now(),
      error: "Cancelled by user",
      resume: null,
    });
    this.changed();
    return updated;
  }

  onRunResumed(runId: string): void {
    const scheduled = this.database.findScheduledTaskRunByRunId(runId);
    if (!scheduled || scheduled.status !== "awaiting_resume") return;
    const updated = this.database.updateScheduledTaskRun(scheduled.id, {
      status: "running",
      resume: null,
      error: null,
    });
    void this.monitor(updated);
    this.changed();
  }

  async tick(now = Date.now()): Promise<void> {
    for (const task of this.database.listDueScheduledTasks(now)) {
      if (this.running.has(task.id) || this.database.hasActiveScheduledTaskRun(task.id)) continue;
      const scheduledFor = task.nextRunAt ?? now;
      const trigger = scheduledFor < now - 5_000 ? "catchup" : "scheduled";
      this.trigger(task, scheduledFor, trigger, now);
    }
  }

  private trigger(
    task: ScheduledTask,
    scheduledFor: number,
    trigger: ScheduledTaskRun["trigger"],
    now = Date.now(),
  ): ScheduledTaskRun {
    const run = this.database.withTransaction(() => {
      const occurrenceKey =
        trigger === "manual" ? `${task.id}:manual:${randomUUID()}` : `${task.id}:${scheduledFor}`;
      const created = this.database.createScheduledTaskRun({
        scheduledTaskId: task.id,
        scheduledFor,
        occurrenceKey,
        trigger,
      });
      const background = this.executor.prepareScheduledTask(task.prompt, task.sessionMode, {
        type: "schedule",
        scheduleId: task.id,
        scheduleRunId: created.id,
      });
      const linked = this.database.updateScheduledTaskRun(created.id, {
        backgroundTaskId: background.id,
        ...(background.runId ? { runId: background.runId } : {}),
        status: "running",
        startedAt: now,
        error: null,
      });
      if (trigger !== "manual") {
        const nextRunAt = task.schedule.kind === "once" ? undefined : nextScheduleTime(task.schedule, now);
        this.database.updateScheduledTask(task.id, {
          lastRunAt: scheduledFor,
          enabled: task.schedule.kind !== "once",
          nextRunAt: nextRunAt ?? null,
        });
      }
      return linked;
    });
    this.changed();
    this.launch(run);
    return run;
  }

  private launch(run: ScheduledTaskRun): void {
    this.running.add(run.scheduledTaskId);
    if (run.backgroundTaskId) this.executor.startTask(run.backgroundTaskId);
    void this.execute(run).finally(() => this.running.delete(run.scheduledTaskId));
  }

  private async execute(run: ScheduledTaskRun): Promise<void> {
    try {
      if (!run.backgroundTaskId) throw new Error("Claimed schedule occurrence has no background task");
      const background = this.executor.getTask(run.backgroundTaskId);
      if (this.database.getScheduledTaskRun(run.id).status === "cancelled") {
        this.executor.cancelTask(background.id);
        return;
      }
      await this.monitor(run);
    } catch (error) {
      this.database.updateScheduledTaskRun(run.id, {
        status: "failed",
        completedAt: Date.now(),
        error: error instanceof Error ? error.message : String(error),
      });
      this.changed();
    }
  }

  private async monitor(run: ScheduledTaskRun): Promise<void> {
    if (!run.backgroundTaskId) return;
    let current = this.executor.getTask(run.backgroundTaskId);
    while (["pending", "running"].includes(current.status)) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      current = this.executor.getTask(run.backgroundTaskId as string);
      if (current.runId && current.runId !== run.runId) {
        run = this.database.updateScheduledTaskRun(run.id, { runId: current.runId });
        this.changed();
      }
    }
    if (current.status === "interrupted" && current.runId) {
      const interrupted = this.database.getRun(current.runId);
      this.database.updateScheduledTaskRun(run.id, {
        runId: current.runId,
        status: "awaiting_resume",
        resume: interrupted.resume ?? null,
        error: current.error ?? "Background run requires explicit resume",
      });
    } else {
      this.database.updateScheduledTaskRun(run.id, {
        ...(current.runId ? { runId: current.runId } : {}),
        status:
          current.status === "completed"
            ? "completed"
            : current.status === "cancelled"
              ? "cancelled"
              : "failed",
        completedAt: Date.now(),
        error: current.error ?? null,
        resume: null,
      });
    }
    this.changed();
  }
}
