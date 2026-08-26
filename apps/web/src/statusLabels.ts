import type { RunStatus } from "@uma-agent/protocol";

export const runStatusLabels: Record<RunStatus, string> = {
  queued: "等待处理",
  preflight: "正在分析",
  awaiting_input: "等待用户回复",
  awaiting_confirmation: "等待确认执行计划",
  running: "正在执行",
  verifying: "正在验证",
  completed: "已完成",
  failed: "执行失败",
  cancelled: "已取消",
  interrupted: "已暂停，可继续",
};

export const responseStatusLabels: Record<string, string> = {
  queued: "等待处理",
  thinking: "正在分析",
  clarifying: "等待用户回复",
  planning: "正在分析",
  awaiting_confirmation: "等待确认执行计划",
  executing: "正在执行",
  awaiting_approval: "等待审批",
  verifying: "正在验证",
  completed: "已完成",
  failed: "执行失败",
  cancelled: "已取消",
};

export const taskStatusLabels: Record<string, string> = {
  pending: "等待执行",
  queued: "等待处理",
  running: "执行中",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
};

export const scheduleKindLabels: Record<string, string> = {
  once: "一次性",
  interval: "按间隔",
  cron: "Cron",
};

export const scheduleRunStatusLabels: Record<string, string> = {
  claimed: "已领取",
  running: "执行中",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
  awaiting_resume: "等待恢复",
};

export const resourceStatusLabels: Record<string, string> = {
  online: "已连接",
  offline: "未连接",
  enabled: "已启用",
  disabled: "已停用",
  pending: "等待处理",
  installed: "已安装",
  rejected: "已拒绝",
  active: "正常",
  indexing: "索引中",
  ready: "可用",
  error: "异常",
};

export function displayStatus(
  value: string | undefined,
  labels: Record<string, string> = resourceStatusLabels,
) {
  if (!value) return "-";
  return labels[value] ?? value;
}
