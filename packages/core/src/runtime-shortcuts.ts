import type {
  BackgroundTask,
  KnowledgeSource,
  ModelRef,
  OptimizationProposal,
  PublicConfig,
  ReloadResult,
  ScheduledTask,
  Session,
  SessionSnapshot,
  ShortcutResponse,
} from "@uma-agent/protocol";
import type { UmaDatabase } from "./database.js";
import type { RuntimeHealth } from "./types.js";

export interface RuntimeShortcutDependencies {
  database: UmaDatabase;
  health: () => RuntimeHealth;
  listModels: () => ModelRef[];
  publicConfig: () => PublicConfig;
  getSnapshot: (sessionId: string) => SessionSnapshot;
  listTasks: (ownerId: string) => BackgroundTask[];
  listScheduledTasks: (ownerId: string) => ScheduledTask[];
  listMemoryFacts: (status: "active" | "candidate" | "superseded" | "rejected", ownerId: string) => unknown[];
  listEvaluationReports: (limit?: number) => Array<{ id: string; status: string }>;
  listOptimizationProposals: () => OptimizationProposal[];
  listKnowledge: (ownerId: string) => KnowledgeSource[];
  refreshSkills: () => Promise<unknown[]>;
  getTask: (id: string) => BackgroundTask;
  cancelTask: (id: string) => BackgroundTask;
  deleteTask: (id: string) => void;
  listKnowledgeSearch: (query: string, ownerId: string) => unknown[];
}

/** Implements the structured shortcuts shared by HTTP, CLI, and adapters. */
export class RuntimeShortcutService {
  constructor(private readonly deps: RuntimeShortcutDependencies) {}

  async execute(
    sessionId: string,
    command: string,
    ownerId: string | undefined,
    reloadConfig?: () => Promise<ReloadResult>,
  ): Promise<ShortcutResponse> {
    if (!ownerId) throw new Error("Session owner is missing");
    const normalized = command.trim().toLowerCase();
    const sessions = this.deps.database.listUserSessions(ownerId);
    const session = this.deps.database.getSession(sessionId);
    if (this.deps.database.sessionOwner(sessionId) !== ownerId)
      throw new Error("Session does not belong to the authenticated user");
    const lines = (values: string[]) => values.join("\n") || "无记录";
    if (normalized === "/help")
      return {
        command,
        output:
          "可用命令：/status /doctor /config /model /reload-config /session list /session status /queue status /btw status /schedule list /kb list /memory status /stats /test list /self-opt proposals /reload-skills",
      };
    if (normalized === "/reload-config") {
      if (!reloadConfig) throw new Error("Configuration reload is unavailable");
      const result = await reloadConfig();
      return {
        command,
        output: `已应用：${result.applied.join(", ") || "无"}\n需要重启：${result.restartRequired.join(", ") || "无"}`,
      };
    }
    if (normalized === "/reload-skills") {
      const skills = await this.deps.refreshSkills();
      return { command, output: `技能已刷新：${skills.length} 项` };
    }
    if (normalized === "/status" || normalized === "/doctor") {
      const health = this.deps.health();
      return {
        command,
        output: `Core ${health.started ? "ok" : "degraded"} · database ${health.databaseReady ? "ready" : "not ready"} · active runs ${health.activeRuns}`,
      };
    }
    if (normalized === "/model")
      return { command, output: lines(this.deps.listModels().map((item) => `${item.provider}/${item.id}`)) };
    if (normalized === "/config")
      return { command, output: JSON.stringify(this.deps.publicConfig(), null, 2) };
    if (normalized === "/session list")
      return { command, output: lines(sessions.map((item: Session) => `${item.id} · ${item.title}`)) };
    if (normalized === "/session status")
      return {
        command,
        output: `${session.title} · ${session.queueMode} · ${this.deps.getSnapshot(sessionId).recentRuns.length} runs`,
      };
    if (normalized === "/queue status") return { command, output: `队列模式：${session.queueMode}` };
    if (normalized === "/btw status")
      return {
        command,
        output: lines(
          this.deps.listTasks(ownerId).map((item) => `${item.id} · ${item.status} · ${item.prompt}`),
        ),
      };
    if (normalized.startsWith("/btw result ")) {
      const task = this.deps.getTask(command.trim().slice("/btw result ".length));
      return { command, output: task.result ?? task.error ?? `${task.status}` };
    }
    if (normalized.startsWith("/btw cancel ")) {
      const task = this.deps.cancelTask(command.trim().slice("/btw cancel ".length));
      return { command, output: `${task.id} · ${task.status}` };
    }
    if (normalized.startsWith("/btw clear ")) {
      const id = command.trim().slice("/btw clear ".length);
      this.deps.deleteTask(id);
      return { command, output: `已清理 ${id}` };
    }
    if (normalized === "/schedule list")
      return {
        command,
        output: lines(
          this.deps
            .listScheduledTasks(ownerId)
            .map((item) => `${item.id} · ${item.name} · ${item.enabled ? "enabled" : "disabled"}`),
        ),
      };
    if (normalized === "/memory status")
      return { command, output: `候选记忆：${this.deps.listMemoryFacts("candidate", ownerId).length} 条` };
    if (normalized === "/stats")
      return {
        command,
        output: JSON.stringify(
          this.deps.database.operationsReport(Date.now() - 7 * 24 * 60 * 60_000, Date.now()),
          null,
          2,
        ),
      };
    if (normalized === "/test list")
      return {
        command,
        output: lines(this.deps.listEvaluationReports(20).map((item) => `${item.id} · ${item.status}`)),
      };
    if (normalized === "/self-opt proposals")
      return {
        command,
        output: lines(
          this.deps.listOptimizationProposals().map((item) => `${item.id} · ${item.status} · ${item.title}`),
        ),
      };
    if (normalized === "/kb list")
      return {
        command,
        output: lines(
          this.deps
            .listKnowledge(ownerId)
            .map((item) => `${item.name} · ${item.status} · ${item.documentCount} documents`),
        ),
      };
    if (normalized.startsWith("/kb search ")) {
      const query = command.trim().slice("/kb search ".length);
      return {
        command,
        output: lines(this.deps.listKnowledgeSearch(query, ownerId).map((item) => JSON.stringify(item))),
      };
    }
    throw new Error(`Unsupported shortcut command: ${command}`);
  }
}
