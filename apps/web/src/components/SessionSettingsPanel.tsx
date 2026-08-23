import type { AgentProfile, Health, OperationsReport, PublicConfig, Session } from "@uma-agent/protocol";
import { type FormEvent, useEffect, useState } from "react";

export function SessionSettingsPanel({
  session,
  health,
  report,
  profile,
  saveProfile,
  logout,
  reloadConfig,
  publicConfig,
  disabled,
  installAvailable,
  install,
}: {
  session: Session | undefined;
  health: Health | undefined;
  report: OperationsReport | undefined;
  profile: AgentProfile | undefined;
  saveProfile: (content: string) => void;
  logout: () => void;
  reloadConfig: () => void;
  publicConfig: PublicConfig | undefined;
  disabled: boolean;
  installAvailable: boolean;
  install: () => void;
}) {
  const [content, setContent] = useState(profile?.content ?? "");
  useEffect(() => setContent(profile?.content ?? ""), [profile?.content]);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    saveProfile(content.trim());
  };
  return (
    <div className="settings-panel">
      <section className="settings-section">
        <div className="settings-section-heading">
          <div>
            <h3>当前会话</h3>
            <p>本会话的运行上下文和服务状态。</p>
          </div>
          <span className={`settings-status-dot ${health?.status === "ok" ? "ok" : "error"}`} />
        </div>
        <div className="settings-list">
          <div className="settings-row">
            <span>会话</span>
            <strong>{session?.title ?? "未选择"}</strong>
          </div>
          <div className="settings-row">
            <span>模型</span>
            <span>{session ? `${session.model.provider}/${session.model.id}` : "-"}</span>
          </div>
          <div className="settings-row">
            <span>Core</span>
            <span>{health?.status === "ok" ? `在线 · v${health.version}` : "不可用"}</span>
          </div>
        </div>
      </section>

      <section className="settings-section">
        <div className="settings-section-heading">
          <div>
            <h3>Agent Profile</h3>
            <p>描述 UmaAgent 在对话中的长期工作偏好。</p>
          </div>
        </div>
        <form className="settings-form" onSubmit={submit}>
          <label htmlFor="agent-profile">Profile 内容</label>
          <textarea
            id="agent-profile"
            value={content}
            onChange={(event) => setContent(event.target.value)}
            placeholder="例如：回答保持简洁，执行前说明风险。"
            rows={5}
          />
          <div className="settings-form-actions">
            <span className="settings-help">内容会保存到当前账号。</span>
            <button type="submit" className="primary" disabled={disabled}>
              保存 Profile
            </button>
          </div>
        </form>
      </section>

      <section className="settings-section">
        <div className="settings-section-heading">
          <div>
            <h3>应用与诊断</h3>
            <p>仅显示当前账号可以使用的应用操作。</p>
          </div>
        </div>
        <div className="settings-actions">
          <button type="button" onClick={reloadConfig} disabled={disabled}>
            重新加载配置
          </button>
          {installAvailable && (
            <button type="button" onClick={install} disabled={disabled}>
              安装 UmaAgent
            </button>
          )}
        </div>
        {publicConfig && (
          <div className="settings-note">
            当前默认模型 {publicConfig.defaultModel.provider}/{publicConfig.defaultModel.id} ·{" "}
            {publicConfig.models.length} 个可用模型
          </div>
        )}
        {report && (
          <div className="settings-note">
            近 7 天完成 {report.runs.completed}/{report.runs.total} 次运行，工具失败 {report.tools.failed}{" "}
            次。
          </div>
        )}
      </section>

      <section className="settings-section settings-danger">
        <div className="settings-section-heading">
          <div>
            <h3>账号操作</h3>
            <p>退出后，本设备上的敏感缓存会被清理。</p>
          </div>
        </div>
        <button type="button" className="danger" onClick={logout}>
          退出登录
        </button>
      </section>
    </div>
  );
}
