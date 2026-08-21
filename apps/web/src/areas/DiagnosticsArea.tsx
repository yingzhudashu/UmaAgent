import type { DiagnosticsReport } from "@uma-agent/protocol";

export function DiagnosticsArea({ report }: { report: DiagnosticsReport | undefined }) {
  if (!report)
    return (
      <div className="operation-list">
        <p>诊断数据不可用。</p>
      </div>
    );
  return (
    <div className="operation-list">
      <div>
        <strong>运行</strong>
        <p>
          {report.summary.runs.completed}/{report.summary.runs.total} completed · recovery{" "}
          {(report.recoveryFrequency * 100).toFixed(1)}%
        </p>
      </div>
      <div>
        <strong>模型</strong>
        {report.slowModels.map((item) => (
          <p key={`${item.provider}/${item.model}`}>
            {item.provider}/{item.model}: {item.averageDurationMs.toFixed(0)} ms
          </p>
        ))}
      </div>
      <div>
        <strong>工具失败</strong>
        {report.toolFailures.map((item) => (
          <p key={item.tool}>
            {item.tool}: {item.failures}
            {item.latestError ? ` · ${item.latestError}` : ""}
          </p>
        ))}
      </div>
      <div>
        <strong>审批</strong>
        {report.approvalBottlenecks.map((item) => (
          <p key={item.tool}>
            {item.tool}: {item.denied}/{item.requested} denied
          </p>
        ))}
      </div>
    </div>
  );
}
