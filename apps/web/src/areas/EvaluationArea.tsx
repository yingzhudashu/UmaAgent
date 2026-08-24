import type { EvaluationReport, EvaluationTrend } from "@uma-agent/protocol";

export function EvaluationArea({
  reports,
  trends,
}: {
  reports: EvaluationReport[];
  trends: EvaluationTrend[];
}) {
  return (
    <div className="operation-list">
      {trends.length > 0 && (
        <div className="action-card">
          <strong>最近 30 天趋势</strong>
          {trends.map((trend) => (
            <div key={trend.group} className="operation-meta">
              {trend.group} · 通过率 {(trend.passRate * 100).toFixed(1)}% · {trend.passedCases}/
              {trend.totalCases} · p95 {Math.round(trend.durationMs.p95)} ms
            </div>
          ))}
        </div>
      )}
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
