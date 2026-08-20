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
  createTask(prompt: string, sessionMode?: "workspace" | "assistant"): Promise<BackgroundTask>;
  getTask(id: string): BackgroundTask;
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
  ) {}

  start(): void {
    if (this.timer) return;
    this.database.markActiveScheduledTaskRunsInterrupted();
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
    return this.database.createScheduledTask({
      name: input.name,
      prompt: input.prompt,
      sessionMode: input.sessionMode ?? "assistant",
      schedule,
      enabled,
      ...(nextRunAt !== undefined ? { nextRunAt } : {}),
    });
  }

  update(id: string, patch: UpdateScheduledTaskRequest): ScheduledTask {
    const current = this.database.getScheduledTask(id);
    const schedule = patch.schedule ?? current.schedule;
    const enabled = patch.enabled ?? current.enabled;
    const nextRunAt = enabled ? nextScheduleTime(schedule) : undefined;
    if (enabled && nextRunAt === undefined) throw new Error("Schedule has no future execution time");
    return this.database.updateScheduledTask(id, {
      ...patch,
      enabled,
      schedule,
      nextRunAt: nextRunAt ?? null,
    });
  }

  delete(id: string): void {
    if (this.database.hasActiveScheduledTaskRun(id))
      throw new Error("Cannot delete a scheduled task while it is running");
    this.database.deleteScheduledTask(id);
  }

  runs(id: string): ScheduledTaskRun[] {
    this.database.getScheduledTask(id);
    return this.database.listScheduledTaskRuns(id);
  }

  runNow(id: string): ScheduledTaskRun {
    return this.trigger(this.database.getScheduledTask(id), Date.now(), true);
  }

  async tick(now = Date.now()): Promise<void> {
    for (const task of this.database.listDueScheduledTasks(now)) {
      if (this.running.has(task.id) || this.database.hasActiveScheduledTaskRun(task.id)) continue;
      this.trigger(task, task.nextRunAt ?? now, false, now);
    }
  }

  private trigger(
    task: ScheduledTask,
    scheduledFor: number,
    manual: boolean,
    now = Date.now(),
  ): ScheduledTaskRun {
    const run = this.database.withTransaction(() => {
      const created = this.database.createScheduledTaskRun(task.id, scheduledFor);
      if (!manual) {
        const nextRunAt = task.schedule.kind === "once" ? undefined : nextScheduleTime(task.schedule, now);
        this.database.updateScheduledTask(task.id, {
          lastRunAt: scheduledFor,
          enabled: task.schedule.kind !== "once",
          nextRunAt: nextRunAt ?? null,
        });
      }
      return created;
    });
    this.running.add(task.id);
    void this.execute(task, run).finally(() => this.running.delete(task.id));
    return run;
  }

  private async execute(task: ScheduledTask, run: ScheduledTaskRun): Promise<void> {
    try {
      const background = await this.executor.createTask(task.prompt, task.sessionMode);
      this.database.updateScheduledTaskRun(run.id, {
        backgroundTaskId: background.id,
        status: "running",
        startedAt: Date.now(),
      });
      let current = background;
      while (["pending", "running"].includes(current.status)) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        current = this.executor.getTask(background.id);
      }
      this.database.updateScheduledTaskRun(run.id, {
        status: current.status,
        completedAt: Date.now(),
        error: current.error ?? null,
      });
    } catch (error) {
      this.database.updateScheduledTaskRun(run.id, {
        status: "failed",
        completedAt: Date.now(),
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
