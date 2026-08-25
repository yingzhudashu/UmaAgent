import type { Approval, Run, RunAction, RunCheckpoint, RunStatus } from "@uma-agent/protocol";
import { Check, ChevronRight, RotateCcw, X } from "lucide-react";

const runStatusLabels: Record<RunStatus, string> = {
  queued: "正在回复",
  preflight: "正在分析",
  awaiting_input: "等待补充信息",
  awaiting_confirmation: "等待确认执行计划",
  running: "正在执行",
  verifying: "正在验证",
  completed: "已完成",
  failed: "执行失败",
  cancelled: "已取消",
  interrupted: "已中断",
};

export function RunPanel({
  run,
  checkpoints,
  actions,
  retry,
  resume,
  decide,
  disabled,
}: {
  run: Run | undefined;
  checkpoints: RunCheckpoint[];
  actions: RunAction[];
  retry: () => void;
  resume: () => void;
  decide: (action: RunAction, decision: "approve" | "reject" | "acknowledge") => void;
  disabled: boolean;
}) {
  if (!run) return <div className="empty-panel">暂无运行信息</div>;
  return (
    <div className="run-panel">
      <div className="panel-label">当前运行</div>
      <div className={`status status-${run.status}`}>{runStatusLabels[run.status]}</div>
      {run.reasoningSummary && (
        <>
          <div className="panel-label">判断</div>
          <p>{run.reasoningSummary}</p>
        </>
      )}
      {run.plan.length > 0 && (
        <>
          <div className="panel-label">计划</div>
          <ol className="plan">
            {run.plan.map((step) => (
              <li key={step.id} data-status={step.status}>
                {step.status === "completed" ? <Check size={14} /> : <span className="step-dot" />}
                {step.title}
              </li>
            ))}
          </ol>
        </>
      )}
      {run.error && <div className="error">{run.error}</div>}
      {checkpoints.at(-1) && (
        <p className="muted">
          检查点 #{checkpoints.at(-1)?.checkpointNo} · {checkpoints.at(-1)?.phase}
        </p>
      )}
      {actions
        .filter((action) => ["prepared", "uncertain"].includes(action.status))
        .map((action) => (
          <div className="action-card" key={action.id}>
            <details className="action-details">
              <summary>
                <ChevronRight size={14} aria-hidden="true" />
                <strong>{action.toolName}</strong>
                <small className="action-status">{action.status}</small>
              </summary>
              <pre className="action-input">{JSON.stringify(action.input, null, 2)}</pre>
            </details>
            <div className="approval-actions">
              <button type="button" disabled={disabled} onClick={() => decide(action, "reject")}>
                拒绝
              </button>
              {action.status === "prepared" ? (
                <button
                  type="button"
                  className="primary"
                  disabled={disabled}
                  onClick={() => decide(action, "approve")}
                >
                  执行一次
                </button>
              ) : (
                <button
                  type="button"
                  className="primary"
                  disabled={disabled}
                  onClick={() => decide(action, "acknowledge")}
                >
                  确认可能已执行
                </button>
              )}
            </div>
          </div>
        ))}
      {run.status === "interrupted" && run.resume?.state === "available" && (
        <button type="button" className="run-action" disabled={disabled} onClick={resume}>
          继续运行
        </button>
      )}
      {["failed", "cancelled"].includes(run.status) && (
        <button type="button" className="run-action" disabled={disabled} onClick={retry}>
          <RotateCcw size={15} />
          重试
        </button>
      )}
    </div>
  );
}

export function ApprovalBar({
  approval,
  resolve,
  disabled,
}: {
  approval: Approval;
  resolve: (approved: boolean) => void;
  disabled: boolean;
}) {
  return (
    <div className="approval">
      <div>
        <strong>{approval.toolName}</strong>
        <code>{JSON.stringify(approval.input)}</code>
      </div>
      <div className="approval-actions">
        <button type="button" disabled={disabled} onClick={() => resolve(false)}>
          <X size={16} />
          拒绝
        </button>
        <button type="button" className="primary" disabled={disabled} onClick={() => resolve(true)}>
          <Check size={16} />
          允许
        </button>
      </div>
    </div>
  );
}
