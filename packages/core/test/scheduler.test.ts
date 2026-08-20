import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BackgroundTask } from "@uma-agent/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UmaDatabase } from "../src/database.js";
import { nextScheduleTime, SchedulerService } from "../src/scheduler.js";

const temporary: string[] = [];
afterEach(async () => {
  for (const path of temporary.splice(0)) await rm(path, { recursive: true, force: true });
});

describe("scheduler", () => {
  it("computes once, interval, and cron times", () => {
    expect(nextScheduleTime({ kind: "once", at: 123 }, 100)).toBe(123);
    expect(nextScheduleTime({ kind: "interval", everyMs: 60_000 }, 100)).toBe(60_100);
    expect(nextScheduleTime({ kind: "cron", expression: "0 * * * *", timezone: "UTC" }, 0)).toBe(3_600_000);
  });

  it("persists one execution and disables a once schedule", async () => {
    const root = await mkdtemp(join(tmpdir(), "uma-scheduler-"));
    temporary.push(root);
    const database = new UmaDatabase(root);
    const session = database.createSession({
      mode: "assistant",
      title: "scheduled",
      model: { provider: "test", id: "model" },
      thinkingLevel: "off",
    });
    const tasks = new Map<string, BackgroundTask>();
    const executor = {
      async createTask(prompt: string) {
        database.createBackgroundTask({
          id: "background-1",
          sessionId: session.id,
          prompt,
        });
        const task = database.updateBackgroundTask("background-1", {
          status: "completed",
          result: "done",
        });
        tasks.set(task.id, task);
        return task;
      },
      getTask(id: string) {
        const task = tasks.get(id);
        if (!task) throw new Error("missing task");
        return task;
      },
    };
    const scheduler = new SchedulerService(database, executor);
    const task = scheduler.create({
      name: "once",
      prompt: "do it",
      schedule: { kind: "once", at: 100 },
    });
    await scheduler.tick(200);
    for (let attempt = 0; attempt < 20; attempt++) {
      if (scheduler.runs(task.id)[0]?.status === "completed") break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(database.getScheduledTask(task.id)).toMatchObject({ enabled: false, lastRunAt: 100 });
    expect(scheduler.runs(task.id)).toEqual([
      expect.objectContaining({ status: "completed", backgroundTaskId: "background-1" }),
    ]);
    await scheduler.tick(300);
    expect(scheduler.runs(task.id)).toHaveLength(1);
    database.close();
  });

  it("rejects deletion while a scheduled execution is active", async () => {
    const root = await mkdtemp(join(tmpdir(), "uma-scheduler-active-"));
    temporary.push(root);
    const database = new UmaDatabase(root);
    const scheduler = new SchedulerService(database, {
      async createTask() {
        throw new Error("not used");
      },
      getTask() {
        throw new Error("not used");
      },
    });
    const task = scheduler.create({
      name: "interval",
      prompt: "wait",
      schedule: { kind: "interval", everyMs: 60_000 },
    });
    const run = database.createScheduledTaskRun(task.id, Date.now());
    expect(() => scheduler.delete(task.id)).toThrow("running");
    database.updateScheduledTaskRun(run.id, {
      status: "cancelled",
      completedAt: Date.now(),
    });
    scheduler.delete(task.id);
    database.close();
  });

  it("supports disabled creation and recomputes schedules on update", async () => {
    const root = await mkdtemp(join(tmpdir(), "uma-scheduler-update-"));
    temporary.push(root);
    const database = new UmaDatabase(root);
    const scheduler = new SchedulerService(database, {
      async createTask() {
        throw new Error("not used");
      },
      getTask() {
        throw new Error("not used");
      },
    });
    const task = scheduler.create({
      name: "disabled",
      prompt: "later",
      enabled: false,
      schedule: { kind: "interval", everyMs: 60_000 },
      sessionMode: "workspace",
    });
    expect(task).toMatchObject({ enabled: false, sessionMode: "workspace" });
    expect(task.nextRunAt).toBeUndefined();
    expect(scheduler.list()).toHaveLength(1);

    const enabled = scheduler.update(task.id, { enabled: true, name: "enabled" });
    expect(enabled.enabled).toBe(true);
    expect(enabled.nextRunAt).toBeTypeOf("number");
    const renamed = scheduler.update(task.id, { name: "renamed" });
    expect(renamed).toMatchObject({ name: "renamed", enabled: true });
    const disabled = scheduler.update(task.id, {
      enabled: false,
      schedule: { kind: "once", at: Date.now() + 10_000 },
    });
    expect(disabled.enabled).toBe(false);
    expect(disabled.nextRunAt).toBeUndefined();
    database.close();
  });

  it("runs a task manually without changing its recurring schedule", async () => {
    const root = await mkdtemp(join(tmpdir(), "uma-scheduler-manual-"));
    temporary.push(root);
    const database = new UmaDatabase(root);
    const session = database.createSession({
      mode: "assistant",
      title: "manual",
      model: { provider: "test", id: "model" },
      thinkingLevel: "off",
    });
    const background = database.createBackgroundTask({
      id: "manual-background",
      sessionId: session.id,
      prompt: "manual",
    });
    const scheduler = new SchedulerService(database, {
      async createTask() {
        return database.getBackgroundTask(background.id);
      },
      getTask(id) {
        return database.updateBackgroundTask(id, { status: "completed", result: "done" });
      },
    });
    const task = scheduler.create({
      name: "recurring",
      prompt: "manual",
      schedule: { kind: "interval", everyMs: 60_000 },
    });
    const nextRunAt = task.nextRunAt;
    const run = scheduler.runNow(task.id);
    for (let attempt = 0; attempt < 20; attempt++) {
      if (scheduler.runs(task.id)[0]?.status === "completed") break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(scheduler.runs(task.id)[0]).toMatchObject({ id: run.id, status: "completed" });
    expect(database.getScheduledTask(task.id)).toMatchObject({ enabled: true, nextRunAt });
    database.close();
  });

  it("records executor failures and avoids overlapping persisted runs", async () => {
    const root = await mkdtemp(join(tmpdir(), "uma-scheduler-failure-"));
    temporary.push(root);
    const database = new UmaDatabase(root);
    const executor = {
      createTask: vi.fn().mockRejectedValue("provider unavailable"),
      getTask: vi.fn(() => {
        throw new Error("not reached");
      }),
    };
    const scheduler = new SchedulerService(database, executor);
    const task = scheduler.create({
      name: "failure",
      prompt: "fail",
      schedule: { kind: "once", at: 100 },
    });
    const active = database.createScheduledTaskRun(task.id, 50);
    await scheduler.tick(200);
    expect(executor.createTask).not.toHaveBeenCalled();
    database.updateScheduledTaskRun(active.id, { status: "cancelled", completedAt: Date.now() });
    await scheduler.tick(200);
    for (let attempt = 0; attempt < 20; attempt++) {
      if (scheduler.runs(task.id).some((run) => run.status === "failed")) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(scheduler.runs(task.id)).toEqual(
      expect.arrayContaining([expect.objectContaining({ status: "failed", error: "provider unavailable" })]),
    );

    executor.createTask.mockRejectedValueOnce(new Error("model failed"));
    const second = scheduler.create({
      name: "error-object",
      prompt: "fail again",
      schedule: { kind: "once", at: 300 },
    });
    await scheduler.tick(400);
    for (let attempt = 0; attempt < 20; attempt++) {
      if (scheduler.runs(second.id)[0]?.status === "failed") break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(scheduler.runs(second.id)[0]).toMatchObject({ status: "failed", error: "model failed" });
    database.close();
  });

  it("starts and stops idempotently while recovering interrupted schedule runs", async () => {
    vi.useFakeTimers();
    const root = await mkdtemp(join(tmpdir(), "uma-scheduler-lifecycle-"));
    temporary.push(root);
    const database = new UmaDatabase(root);
    const scheduler = new SchedulerService(database, {
      async createTask() {
        throw new Error("not used");
      },
      getTask() {
        throw new Error("not used");
      },
    });
    scheduler.start();
    scheduler.start();
    scheduler.stop();
    scheduler.stop();
    database.close();
    vi.useRealTimers();
  });
});
