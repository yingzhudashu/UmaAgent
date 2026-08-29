import type { AgentProfile, Health, OperationsReport, PublicConfig, Session } from "@uma-agent/protocol";
import { ImagePlus, RotateCcw, Save } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import defaultAvatarUrl from "../assets/cat-avatar.png";

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
  saveSession,
  uploadAvatar,
}: {
  session: Session | undefined;
  health: Health | undefined;
  report: OperationsReport | undefined;
  profile: AgentProfile | undefined;
  saveProfile: (content: string) => Promise<void> | void;
  logout: () => void;
  reloadConfig: () => void;
  publicConfig: PublicConfig | undefined;
  disabled: boolean;
  installAvailable: boolean;
  install: () => void;
  saveSession: (patch: {
    assistantName?: string;
    assistantAvatarAttachmentId?: string | null;
  }) => Promise<void>;
  uploadAvatar: (file: File) => Promise<string>;
}) {
  const [content, setContent] = useState(profile?.content ?? "");
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [assistantName, setAssistantName] = useState(session?.assistantName ?? "UmaAgent");
  const [avatarState, setAvatarState] = useState<"idle" | "saving" | "error">("idle");
  useEffect(() => setContent(profile?.content ?? ""), [profile?.content]);
  useEffect(() => setAssistantName(session?.assistantName ?? "UmaAgent"), [session?.assistantName]);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSaveState("saving");
    try {
      await saveProfile(content.trim());
      setSaveState("saved");
    } catch {
      setSaveState("error");
    }
  };
  const saveLabel = saveState === "saving" ? "保存中…" : saveState === "saved" ? "已保存" : "保存 Profile";
  const avatarUrl = session?.assistantAvatarAttachmentId
    ? `/api/v15/attachments/${encodeURIComponent(session.assistantAvatarAttachmentId)}/content`
    : defaultAvatarUrl;
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
            <span>消息策略</span>
            <span>{session?.queueMode === "preemptive" ? "抢占式" : "排队式"}</span>
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
            <h3>助手身份</h3>
            <p>仅影响当前会话中的助手显示。</p>
          </div>
        </div>
        <div className="assistant-identity-form">
          <img className="assistant-avatar-preview" src={avatarUrl} alt="助手头像预览" />
          <div className="assistant-identity-fields">
            <label htmlFor="assistant-name">助手名称</label>
            <input
              id="assistant-name"
              value={assistantName}
              maxLength={100}
              onChange={(event) => setAssistantName(event.target.value)}
              disabled={disabled}
            />
            <div className="settings-form-actions">
              <button
                type="button"
                className="primary settings-primary"
                disabled={disabled || !assistantName.trim()}
                onClick={() => void saveSession({ assistantName: assistantName.trim() })}
              >
                <Save size={14} aria-hidden="true" />
                保存身份
              </button>
              <label className="text-action" aria-label="上传助手头像">
                <ImagePlus size={14} aria-hidden="true" />
                上传头像
                <input
                  type="file"
                  accept="image/*"
                  hidden
                  disabled={disabled || avatarState === "saving"}
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (!file) return;
                    setAvatarState("saving");
                    void uploadAvatar(file)
                      .then((id) => saveSession({ assistantAvatarAttachmentId: id }))
                      .then(() => setAvatarState("idle"))
                      .catch(() => setAvatarState("error"));
                    event.currentTarget.value = "";
                  }}
                />
              </label>
              {session?.assistantAvatarAttachmentId && (
                <button
                  type="button"
                  className="text-action"
                  disabled={disabled}
                  onClick={() => void saveSession({ assistantAvatarAttachmentId: null })}
                >
                  <RotateCcw size={14} aria-hidden="true" />
                  恢复默认
                </button>
              )}
            </div>
            {avatarState === "error" && <p className="error-text">头像保存失败。</p>}
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
            <button
              type="submit"
              className="primary settings-primary"
              disabled={disabled || saveState === "saving"}
            >
              <Save size={14} aria-hidden="true" />
              {saveLabel}
            </button>
          </div>
          <output className={`settings-feedback ${saveState}`} aria-live="polite">
            {saveState === "error"
              ? "保存失败，请稍后重试。"
              : saveState === "saved"
                ? "Profile 已同步到当前账号。"
                : ""}
          </output>
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
        <button
          type="button"
          className="danger"
          onClick={() => {
            if (window.confirm("退出登录并清理本设备缓存？")) logout();
          }}
          disabled={disabled}
        >
          退出登录
        </button>
      </section>
    </div>
  );
}
