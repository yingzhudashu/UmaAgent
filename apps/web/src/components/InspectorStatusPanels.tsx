import type { EventConnectionState } from "@uma-agent/client";
import type { Approval, Health } from "@uma-agent/protocol";
import { ApprovalBar } from "../areas/RunArea.js";

export function ConnectionPanel({ health }: { health: Health | undefined }) {
  return (
    <div className="status-summary" aria-live="polite">
      <div className="status-row">
        <span>Core 状态</span>
        <strong className={health?.status === "ok" ? "status-ok" : "status-error"}>
          {health?.status === "ok" ? "已连接" : "不可用"}
        </strong>
      </div>
      <div className="status-row">
        <span>协议</span>
        <span>v{health?.protocolVersion ?? "-"}</span>
      </div>
      <div className="status-row">
        <span>服务版本</span>
        <span>{health?.version ?? "-"}</span>
      </div>
      <div className="status-row">
        <span>运行中</span>
        <span>{health?.activeRuns ?? 0}</span>
      </div>
      {!health || health.status !== "ok" ? <p className="error">Core 健康检查失败，请稍后重试。</p> : null}
    </div>
  );
}

export function SyncPanel({
  browserOnline,
  coreAvailable,
  selected,
  eventState = "disconnected",
  lastSyncAt,
  cursor,
  recoveryError,
  retry,
}: {
  browserOnline: boolean;
  coreAvailable: boolean;
  selected?: string | undefined;
  eventState?: EventConnectionState | undefined;
  lastSyncAt?: number | undefined;
  cursor?: number | undefined;
  recoveryError?: string | undefined;
  retry?: (() => void) | undefined;
}) {
  const browserStatus = browserOnline ? "在线" : "离线，只读缓存";
  const socketStatus = !coreAvailable
    ? "Core 不可用"
    : eventState === "connected"
      ? "实时连接正常"
      : eventState === "connecting"
        ? "正在恢复连接"
        : "未连接";
  return (
    <div className="status-summary sync-summary" aria-live="polite">
      <div className="status-row">
        <span>浏览器</span>
        <strong className={browserOnline ? "status-ok" : "status-warning"}>{browserStatus}</strong>
      </div>
      <div className="status-row">
        <span>WebSocket</span>
        <span>{socketStatus}</span>
      </div>
      <div className="status-row">
        <span>当前游标</span>
        <span>{selected ? (cursor ?? "同步中") : "暂无会话"}</span>
      </div>
      <div className="status-row">
        <span>最近同步</span>
        <span>{lastSyncAt ? new Date(lastSyncAt).toLocaleTimeString() : "尚未同步"}</span>
      </div>
      {recoveryError ? (
        <div className="panel-error" role="alert">
          <p>{recoveryError}</p>
          {retry && (
            <button type="button" className="text-action" onClick={retry}>
              重试同步
            </button>
          )}
        </div>
      ) : null}
    </div>
  );
}

export function ApprovalPanel({
  approvals,
  selected,
  disabled,
  resolve,
}: {
  approvals: Approval[];
  selected: string | undefined;
  disabled: boolean;
  resolve: (approval: Approval, approved: boolean) => void;
}) {
  const pending = approvals.filter((approval) => approval.sessionId === selected);
  if (!pending.length) return <p className="empty-panel">当前没有待审批操作。</p>;
  return (
    <div className="approval-list">
      {pending.map((approval) => (
        <ApprovalBar
          key={approval.id}
          approval={approval}
          disabled={disabled}
          resolve={(approved) => resolve(approval, approved)}
        />
      ))}
    </div>
  );
}
