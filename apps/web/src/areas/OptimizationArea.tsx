import type { OptimizationProposal } from "@uma-agent/protocol";

export function OptimizationArea({
  proposals,
  disabled,
  generate,
  decide,
}: {
  proposals: OptimizationProposal[];
  disabled: boolean;
  generate: () => void;
  decide: (id: string, status: "accepted" | "rejected") => void;
}) {
  return (
    <div className="operation-list">
      <button type="button" disabled={disabled} onClick={generate}>
        生成只读提案
      </button>
      {proposals.map((item) => (
        <div key={item.id} className="action-card">
          <strong>{item.title}</strong>
          <small className="operation-meta">
            {item.status} · {item.risk}
          </small>
          <p>{item.recommendation}</p>
          {item.evidence.map((value) => (
            <p key={value}>{value}</p>
          ))}
          {item.status === "pending" && (
            <div className="approval-actions">
              <button type="button" disabled={disabled} onClick={() => decide(item.id, "rejected")}>
                拒绝
              </button>
              <button
                type="button"
                className="primary"
                disabled={disabled}
                onClick={() => decide(item.id, "accepted")}
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
