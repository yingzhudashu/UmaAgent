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
        <span>{health?.protocolVersion ?? "-"}</span>
      </div>
      <div className="status-row">
        <span>运行中</span>
        <span>{health?.activeRuns ?? 0}</span>
      </div>
      {!health || health.status !== "ok" ? <p className="error">Core 健康检查失败，请稍后重试。</p> : null}
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
