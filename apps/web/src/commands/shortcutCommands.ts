import type { UmaClient } from "@uma-agent/client";
import {
  AGENT_SHORTCUT_COMMANDS,
  type BackgroundTask,
  type KnowledgeSource,
  type ScheduledTask,
  type Session,
} from "@uma-agent/protocol";

export async function executeShortcutCommand(
  command: string,
  input: {
    client: UmaClient;
    sessionId: string | undefined;
    models: Array<{ provider: string; id: string }> | undefined;
    sessions: Session[] | undefined;
    selectedSnapshot: { session: Session; recentRuns: Array<unknown> } | undefined;
    tasks: BackgroundTask[] | undefined;
    schedules: ScheduledTask[] | undefined;
    knowledge: KnowledgeSource[] | undefined;
    memoryCount: number;
    report: unknown | undefined;
    evaluations: Array<{ id: string; status: string }> | undefined;
    optimization: Array<{ id: string; status: string; title: string }> | undefined;
    refreshSkills: () => Promise<unknown>;
    reloadSkills: () => Promise<unknown>;
  },
): Promise<string> {
  const { client } = input;
  const remote = async (): Promise<string> => {
    if (!input.sessionId) throw new Error("Select a session before running a shortcut");
    return (await client.executeShortcut(input.sessionId, command)).output;
  };
  if (AGENT_SHORTCUT_COMMANDS.includes(command as (typeof AGENT_SHORTCUT_COMMANDS)[number])) return remote();
  if (command === "/reload-config") {
    const value = await client.reloadConfig();
    return `已应用：${value.applied.join(", ") || "无"}\n需要重启：${value.restartRequired.join(", ") || "无"}`;
  }
  if (command === "/session list")
    return input.sessions?.map((item) => `${item.id} · ${item.title}`).join("\n") || "暂无会话";
  if (command === "/session status")
    return input.selectedSnapshot
      ? `${input.selectedSnapshot.session.title} · ${input.selectedSnapshot.session.queueMode} · ${input.selectedSnapshot.recentRuns.length} runs`
      : "暂无会话";
  if (command === "/queue status")
    return input.selectedSnapshot ? `队列模式：${input.selectedSnapshot.session.queueMode}` : "暂无会话";
  if (command === "/btw status")
    return (
      input.tasks?.map((item) => `${item.id} · ${item.status} · ${item.prompt}`).join("\n") || "暂无后台任务"
    );
  if (command === "/schedule list")
    return (
      input.schedules
        ?.map((item) => `${item.id} · ${item.name} · ${item.enabled ? "enabled" : "disabled"}`)
        .join("\n") || "暂无调度"
    );
  if (command === "/kb list")
    return (
      input.knowledge
        ?.map((item) => `${item.name} · ${item.status} · ${item.documentCount} documents`)
        .join("\n") || "暂无知识库"
    );
  if (command === "/memory status") return `候选记忆：${input.memoryCount} 条`;
  if (command === "/stats")
    return input.report ? JSON.stringify(input.report, null, 2) : "仅管理员可查看统计";
  if (command === "/test list")
    return input.evaluations?.map((item) => `${item.id} · ${item.status}`).join("\n") || "暂无评测报告";
  if (command === "/self-opt proposals")
    return (
      input.optimization?.map((item) => `${item.id} · ${item.status} · ${item.title}`).join("\n") ||
      "暂无优化提案"
    );
  if (command === "/reload-skills") {
    const value = await input.reloadSkills();
    await input.refreshSkills();
    return `技能已刷新：${Array.isArray(value) ? value.length : 0} 项`;
  }
  return "未知命令";
}
