import type { QualityAssessment } from "@uma-agent/protocol";

export type QualityOperationView = {
  kind: "review" | "improve";
  status: "running" | "completed" | "failed";
  error?: string;
  assessments?: readonly QualityAssessment[];
  result?: string;
};

export function QualityPanel({
  operation,
  onRetry,
}: {
  operation: QualityOperationView | undefined;
  onRetry: () => void;
}) {
  if (!operation) return null;
  const latest = operation.assessments?.at(-1);
  return (
    <section className="quality-panel" aria-live="polite">
      <strong>{operation.kind === "review" ? "审查结果" : "改进结果"}</strong>
      {operation.status === "running" && <p>正在处理…</p>}
      {operation.status === "failed" && (
        <>
          <p className="error-text">{operation.error ?? "操作失败"}</p>
          <button type="button" className="text-action" onClick={onRetry}>
            重试
          </button>
        </>
      )}
      {operation.status === "completed" && operation.kind === "review" && (
        <>
          <p>{latest?.passed ? "未发现明显问题。" : "发现需要关注的问题。"}</p>
          {latest?.issues.map((issue) => (
            <p className="quality-panel__item" key={`${issue.type}:${issue.description}`}>
              {issue.description}
            </p>
          ))}
          {latest?.suggestions.map((suggestion) => (
            <p className="quality-panel__item" key={suggestion}>
              建议：{suggestion}
            </p>
          ))}
        </>
      )}
      {operation.status === "completed" && operation.kind === "improve" && operation.result && (
        <p className="quality-panel__result">{operation.result}</p>
      )}
    </section>
  );
}
