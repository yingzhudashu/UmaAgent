import type { AgentProfile, Health, OperationsReport, PublicConfig, Session } from "@uma-agent/protocol";
import { type FormEvent, useEffect, useState } from "react";

export function SettingsArea({
  session,
  health,
  installAvailable,
  install,
  report,
  profile,
  saveProfile,
  reloadConfig,
  publicConfig,
  disabled,
}: {
  session: Session | undefined;
  health: Health | undefined;
  installAvailable: boolean;
  install: () => void;
  report: OperationsReport | undefined;
  profile: AgentProfile | undefined;
  saveProfile: (content: string) => void;
  reloadConfig: () => void;
  publicConfig: PublicConfig | undefined;
  disabled: boolean;
}) {
  const [content, setContent] = useState(profile?.content ?? "");
  useEffect(() => setContent(profile?.content ?? ""), [profile?.content]);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    saveProfile(content.trim());
  };
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
      <div>
        <strong>有效配置</strong>
        <p>
          {publicConfig
            ? `${publicConfig.defaultModel.provider}/${publicConfig.defaultModel.id} · ${publicConfig.models.length} models · ${publicConfig.skills.length} skills`
            : "-"}
        </p>
        {publicConfig && <small className="operation-meta">revision {publicConfig.revision}</small>}
      </div>
      <form className="resource-form" onSubmit={submit}>
        <label>
          Agent Profile
          <textarea value={content} onChange={(event) => setContent(event.target.value)} />
        </label>
        <button type="submit" disabled={disabled}>
          保存 Profile
        </button>
      </form>
      <button type="button" disabled={disabled} onClick={reloadConfig}>
        重新加载配置
      </button>
      {installAvailable && (
        <button type="button" className="run-action" onClick={install}>
          安装 UmaAgent PWA
        </button>
      )}
    </div>
  );
}
