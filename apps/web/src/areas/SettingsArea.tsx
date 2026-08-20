import type { Health, OperationsReport, Session } from "@uma-agent/protocol";

export function SettingsArea({
  session,
  health,
  installAvailable,
  install,
  report,
}: {
  session: Session | undefined;
  health: Health | undefined;
  installAvailable: boolean;
  install: () => void;
  report: OperationsReport | undefined;
}) {
  return (
    <div className="operation-list">
      <div>
        <strong>Core</strong>
        <p>
          {health?.status ?? "offline"} · v{health?.version ?? "-"} · protocol{" "}
          {health?.protocolVersion ?? "-"}
        </p>
      </div>
      <div>
        <strong>近 7 天运行</strong>
        <p>
          {report
            ? `${report.runs.completed}/${report.runs.total} completed · ${report.model.totalTokens} tokens · ${report.tools.failed} tool failures`
            : "-"}
        </p>
      </div>
      <div>
        <strong>Session</strong>
        <p>{session ? `${session.mode} · ${session.model.provider}/${session.model.id}` : "-"}</p>
      </div>
      {installAvailable && (
        <button type="button" className="run-action" onClick={install}>
          安装 UmaAgent PWA
        </button>
      )}
    </div>
  );
}
