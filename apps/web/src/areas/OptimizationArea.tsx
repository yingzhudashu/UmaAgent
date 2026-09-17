import type { OptimizationProposal } from "@uma-agent/protocol";
import { useOperation } from "../components/OperationFeedback.js";
import { displayStatus } from "../statusLabels.js";

export function OptimizationArea({
  proposals,
  disabled,
  generate,
  decide,
}: {
  proposals: OptimizationProposal[];
  disabled: boolean;
  generate: () => unknown;
  decide: (id: string, status: "accepted" | "rejected") => unknown;
}) {
  const operation = useOperation();
  return (
    <div className="operation-list">
      {operation.feedback}
      <p>接受提案只加入人工待办，不会自动修改配置或代码。</p>
      <button
        type="button"
        disabled={disabled || operation.busy}
        onClick={() => void operation.execute(generate)}
      >
        生成只读提案
      </button>
      {proposals.map((item) => (
        <div key={item.id} className="action-card">
          <strong>{item.title}</strong>
          <small className="operation-meta">
            {displayStatus(item.status)} · 风险：
            {item.risk === "high" ? "高" : item.risk === "medium" ? "中" : "低"}
          </small>
          <p>{item.recommendation}</p>
          {item.evidence.map((value) => (
            <p key={value}>{value}</p>
          ))}
          {item.status === "pending" && (
            <div className="approval-actions">
              <button
                type="button"
                disabled={disabled || operation.busy}
                onClick={() =>
                  operation.confirm("拒绝此提案？", item.title, () => decide(item.id, "rejected"))
                }
              >
                拒绝
              </button>
              <button
                type="button"
                className="primary"
                disabled={disabled || operation.busy}
                onClick={() => void operation.execute(() => decide(item.id, "accepted"))}
              >
                接受为人工待办
              </button>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
