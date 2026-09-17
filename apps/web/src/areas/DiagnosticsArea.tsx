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
      <p className="operation-meta">
        统计范围：{new Date(report.from).toLocaleString()} 至 {new Date(report.to).toLocaleString()}
      </p>
      <div>
        <strong>运行</strong>
        <p>
          已完成 {report.summary.runs.completed}/{report.summary.runs.total} · 恢复频率{" "}
          {report.summary.runs.total ? `${(report.recoveryFrequency * 100).toFixed(1)}%` : "未提供"}
        </p>
      </div>
      <div>
        <strong>模型</strong>
        {report.slowModels.map((item) => (
          <p key={`${item.provider}/${item.model}`}>
            {item.provider}/{item.model}：平均 {item.averageDurationMs.toFixed(0)} ms · {item.calls} 次调用
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
            {item.tool}：拒绝 {item.denied}/{item.requested}
          </p>
        ))}
      </div>
      <div>
        <strong>Trace</strong>
        <p>
          {report.trace.spans} 个阶段 · {report.trace.incomplete} 个未完整结束 · {report.trace.active}{" "}
          个执行中 · 错误率 {report.trace.spans ? `${(report.trace.errorRate * 100).toFixed(1)}%` : "未提供"}
        </p>
        <p>
          写入失败 {report.trace.writeFailures} · OTLP 导出失败 {report.trace.otlpExportFailures}
        </p>
        <details>
          <summary>服务明细</summary>
          {report.trace.services.map((item) => (
            <p key={item.service}>
              {item.service}：{item.spans} 个阶段 · {item.errors} 个错误
            </p>
          ))}
        </details>
        {Object.entries(report.trace.stageLatencyMs).map(([stage, latency]) => (
          <p key={stage}>
            {stage}：p50 {latency.p50.toFixed(1)} ms · p95 {latency.p95.toFixed(1)} ms · p99{" "}
            {latency.p99.toFixed(1)} ms
          </p>
        ))}
      </div>
    </div>
  );
}
