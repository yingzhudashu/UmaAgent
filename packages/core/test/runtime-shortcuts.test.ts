import { describe, expect, it } from "vitest";
import { RuntimeShortcutService } from "../src/runtime-shortcuts.js";

describe("RuntimeShortcutService", () => {
  it("executes the supported diagnostic and resource shortcuts", async () => {
    const session = { id: "session-1", title: "Session", queueMode: "queue" };
    const task = { id: "task-1", status: "completed", result: "done" };
    const deps = {
      database: {
        listUserSessions: () => [session],
        getSession: () => session,
        sessionOwner: () => "user-1",
        operationsReport: () => ({ runs: 1 }),
      },
      health: () => ({ started: true, databaseReady: true, activeRuns: 0 }),
      listModels: () => [{ provider: "openai", id: "model" }],
      publicConfig: () => ({ models: [] }),
      getSnapshot: () => ({ recentRuns: [] }),
      listTasks: () => [task],
      listScheduledTasks: () => [{ id: "schedule-1", name: "Daily", enabled: true }],
      listMemoryFacts: () => [{ id: "memory-1" }],
      listEvaluationReports: () => [{ id: "eval-1", status: "completed" }],
      listOptimizationProposals: () => [{ id: "proposal-1", status: "pending", title: "Tune" }],
      listKnowledge: () => [{ name: "Docs", status: "ready", documentCount: 2 }],
      refreshSkills: async () => [{ name: "builtin" }],
      getTask: () => task,
      cancelTask: () => ({ ...task, status: "cancelled" }),
      deleteTask: () => undefined,
      listKnowledgeSearch: () => [{ id: "doc-1" }],
    };
    const service = new RuntimeShortcutService(deps as never);
    const commands = [
      "/help",
      "/reload-skills",
      "/status",
      "/doctor",
      "/model",
      "/config",
      "/session list",
      "/session status",
      "/queue status",
      "/btw status",
      "/btw result task-1",
      "/btw cancel task-1",
      "/btw clear task-1",
      "/schedule list",
      "/memory status",
      "/stats",
      "/test list",
      "/self-opt proposals",
      "/kb list",
      "/kb search docs",
    ];
    for (const command of commands)
      expect((await service.execute(session.id, command, "user-1")).command).toBe(command);
    await expect(
      service.execute(session.id, "/reload-config", "user-1", async () => ({
        applied: ["model"],
        restartRequired: [],
      })),
    ).resolves.toMatchObject({ command: "/reload-config" });
    await expect(service.execute(session.id, "/reload-config", "user-1")).rejects.toThrow(
      "Configuration reload is unavailable",
    );
    await expect(service.execute(session.id, "/missing", "user-1")).rejects.toThrow("Unsupported shortcut");
    await expect(service.execute(session.id, "/status", undefined)).rejects.toThrow(
      "Session owner is missing",
    );
    await expect(service.execute(session.id, "/status", "another-user")).rejects.toThrow(
      "does not belong to the authenticated user",
    );
    const sparse = new RuntimeShortcutService({
      ...deps,
      database: {
        ...deps.database,
        listUserSessions: () => [],
        getSession: () => ({ ...session, queueMode: "preemptive" }),
      },
      health: () => ({ started: false, databaseReady: false, activeRuns: 0 }),
      listModels: () => [],
      listTasks: () => [],
      listScheduledTasks: () => [{ id: "schedule-1", name: "Daily", enabled: false }],
      getTask: () => ({ ...task, result: undefined, error: "failed" }),
    } as never);
    await sparse.execute(session.id, "/model", "user-1");
    await sparse.execute(session.id, "/session list", "user-1");
    await sparse.execute(session.id, "/btw status", "user-1");
    await sparse.execute(session.id, "/btw result task-1", "user-1");
    await sparse.execute(session.id, "/schedule list", "user-1");
    await sparse.execute(session.id, "/status", "user-1");
    await sparse.execute(session.id, "/reload-config", "user-1", async () => ({
      applied: [],
      restartRequired: [],
    }));
  });
});
