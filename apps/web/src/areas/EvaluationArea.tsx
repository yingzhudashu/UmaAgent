import type { EvaluationReport } from "@uma-agent/protocol";

export function EvaluationArea({ reports }: { reports: EvaluationReport[] }) {
  return (
    <div className="operation-list">
      {reports.length === 0 && <p>暂无评测报告。</p>}
      {reports.map((report) => (
        <details key={report.id} className="action-card">
          <summary>
            <strong>{report.status}</strong> · {report.mode} · {report.totals.passed}/{report.totals.total}
          </summary>
          <small className="operation-meta">
            {new Date(report.createdAt).toLocaleString()} · {report.durationMs} ms · suite{" "}
            {report.suiteVersion}
          </small>
          {report.cases.map((item) => (
            <div key={`${report.id}:${item.name}`}>
              <strong>
                {item.passed ? "✓" : "✗"} {item.name}
              </strong>
              <small className="operation-meta">
                {item.category} · {item.durationMs} ms
              </small>
              {item.error && <p className="error">{item.error}</p>}
            </div>
          ))}
        </details>
      ))}
    </div>
  );
}
