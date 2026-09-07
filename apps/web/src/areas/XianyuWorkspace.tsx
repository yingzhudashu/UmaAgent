import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { UmaClient } from "@uma-agent/client";
import type { SessionSnapshot, TranscriptItem, XianyuWorkspaceBootstrap } from "@uma-agent/protocol";
import { Check, ChevronLeft, Pause, Play, RefreshCw, Send, Square, Store } from "lucide-react";
import { type FormEvent, useEffect, useMemo, useState } from "react";
import { MessageBubble } from "../components/MessageBubble.js";
import { ResponseCard } from "../components/ResponseCard.js";
import { buildConversationEntries } from "../responseTurns.js";

type XianyuWorkspaceProps = { client: UmaClient; embedded?: boolean };
type LoginState = { status?: string; message?: string; qrDataUrl?: string; expiresAt?: number };

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "咸鱼工作台请求失败";
}

function loginState(value: unknown): LoginState | undefined {
  return value && typeof value === "object" ? (value as LoginState) : undefined;
}

export function XianyuWorkspace({ client, embedded = false }: XianyuWorkspaceProps) {
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<string>();
  const [prompt, setPrompt] = useState("");
  const [notice, setNotice] = useState<string>();
  const [error, setError] = useState<string>();
  const [login, setLogin] = useState<LoginState>();
  const [loading, setLoading] = useState(false);
  const [controlOpen, setControlOpen] = useState(false);

  const workspace = useQuery<XianyuWorkspaceBootstrap>({
    queryKey: ["xianyu-workspace"],
    queryFn: () => client.xianyuWorkspace(),
    refetchInterval: 10_000,
  });
  const sessions = workspace.data?.sessions ?? [];
  const control = sessions.find((item) => item.metadata.kind === "control");
  const activeId =
    selected && sessions.some((item) => item.session.id === selected)
      ? selected
      : (control?.session.id ?? sessions[0]?.session.id);
  const active = sessions.find((item) => item.session.id === activeId);
  const snapshot = useQuery<SessionSnapshot>({
    queryKey: ["xianyu-snapshot", activeId],
    queryFn: () => client.getSession(activeId as string),
    enabled: Boolean(activeId),
  });

  useEffect(() => {
    if (!activeId) return;
    void client.xianyuMarkRead(activeId).catch(() => undefined);
  }, [client, activeId]);
  useEffect(() => {
    if (!activeId) return;
    client.connectEvents();
    return client.subscribe(activeId, () => {
      void queryClient.invalidateQueries({ queryKey: ["xianyu-snapshot", activeId] });
      void queryClient.invalidateQueries({ queryKey: ["xianyu-workspace"] });
    });
  }, [client, queryClient, activeId]);

  const transcript = snapshot.data?.transcript ?? [];
  const entries = useMemo(
    () =>
      buildConversationEntries(transcript, snapshot.data?.responses ?? [], snapshot.data?.recentRuns ?? []),
    [transcript, snapshot.data?.responses, snapshot.data?.recentRuns],
  );
  const loginInfo = login ?? loginState(workspace.data?.login);
  const loginStatus = loginInfo?.status;
  const run = async (operation: () => Promise<void>, success?: string) => {
    try {
      setLoading(true);
      setError(undefined);
      await operation();
      if (success) setNotice(success);
    } catch (value) {
      setError(errorText(value));
    } finally {
      setLoading(false);
    }
  };
  const startLogin = () =>
    void run(async () => {
      const next = await client.xianyuLoginStart<LoginState>();
      setLogin(next);
      setNotice("二维码已生成，请使用闲鱼 App 扫码确认");
    });
  useEffect(() => {
    if (!["waiting_scan", "scanned", "confirmed"].includes(loginStatus ?? "")) return;
    const timer = window.setInterval(() => {
      void client
        .xianyuLoginStatus<LoginState>()
        .then((next) => {
          setLogin(next);
          if (next.status === "authenticated") void workspace.refetch();
        })
        .catch((value) => setError(errorText(value)));
    }, 3000);
    return () => window.clearInterval(timer);
  }, [client, loginStatus, workspace.refetch]);

  const sendPrompt = (event: FormEvent) => {
    event.preventDefault();
    if (!activeId || !prompt.trim() || loading) return;
    void run(async () => {
      await client.sendMessage(activeId, prompt.trim(), { mode: "agent" });
      setPrompt("");
      await queryClient.invalidateQueries({ queryKey: ["xianyu-snapshot", activeId] });
    });
  };
  const action = (name: "start" | "pause" | "resume" | "stop") =>
    void run(async () => {
      if (name === "start") await client.xianyuStart();
      if (name === "pause") await client.xianyuPause();
      if (name === "resume") await client.xianyuResume();
      if (name === "stop") await client.xianyuStop();
      await workspace.refetch();
    }, "服务状态已更新");
  const sendDraft = (messageId: string) =>
    void run(async () => {
      if (!activeId) return;
      await client.xianyuSendDraft(activeId, messageId);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["xianyu-snapshot", activeId] }),
        workspace.refetch(),
      ]);
    }, "草稿已发送");

  return (
    <div className={`xianyu-workspace ${embedded ? "xianyu-workspace--embedded" : ""}`}>
      <aside className="xianyu-workspace__sidebar">
        <div className="xianyu-workspace__brand">
          <Store size={18} /> <strong>咸鱼</strong>
          <small>管理员工作台</small>
        </div>
        <button
          type="button"
          className={`xianyu-session ${activeId === control?.session.id ? "active" : ""}`}
          onClick={() => setSelected(control?.session.id)}
        >
          <span>咸鱼总控</span>
          <small>服务与运营</small>
        </button>
        <div className="xianyu-workspace__section-title">
          买家会话 <span>{Math.max(0, sessions.length - (control ? 1 : 0))}</span>
        </div>
        <nav className="xianyu-workspace__sessions">
          {sessions
            .filter((item) => item.metadata.kind === "buyer")
            .map((item) => (
              <button
                type="button"
                key={item.session.id}
                className={`xianyu-session ${activeId === item.session.id ? "active" : ""}`}
                onClick={() => setSelected(item.session.id)}
              >
                <span>{item.metadata.displayName ?? item.session.title}</span>
                <small>
                  {item.metadata.unreadCount
                    ? `${item.metadata.unreadCount} 条未读`
                    : (item.metadata.externalUserId ?? "已同步")}
                </small>
              </button>
            ))}
          {sessions.filter((item) => item.metadata.kind === "buyer").length === 0 && (
            <p className="xianyu-empty">收到买家消息后会自动创建会话。</p>
          )}
        </nav>
      </aside>
      <main className="xianyu-workspace__main">
        <header className="xianyu-workspace__header">
          <div>
            <h1>{active?.session.title ?? "咸鱼工作台"}</h1>
            <p>
              {active?.metadata.kind === "buyer"
                ? `买家 ${active.metadata.externalUserId ?? ""}`
                : "总控会话"}
            </p>
          </div>
          <div className="xianyu-workspace__header-actions">
            <span
              className={`health-dot ${workspace.data?.service && (workspace.data.service as { connected?: boolean }).connected ? "online" : "offline"}`}
            />
            {(workspace.data?.service as { connected?: boolean } | undefined)?.connected
              ? "已连接"
              : "待连接"}
            <button type="button" className="icon" title="刷新" onClick={() => void workspace.refetch()}>
              <RefreshCw size={16} />
            </button>
          </div>
        </header>
        {active?.metadata.kind === "control" && (
          <section className="xianyu-controlbar">
            <div>
              <strong>自动回复</strong>
              <small>
                {workspace.data?.autoReplyEnabled
                  ? "开启后，咸鱼入站消息触发的 AI 回复会直接发送"
                  : "关闭时只生成草稿，需管理员确认后发送"}
              </small>
            </div>
            <label htmlFor="xianyu-auto-reply" className="toggle">
              <input
                id="xianyu-auto-reply"
                type="checkbox"
                checked={workspace.data?.autoReplyEnabled ?? false}
                onChange={(event) =>
                  void run(async () => {
                    await client.xianyuSetAutoReply(event.target.checked);
                    await workspace.refetch();
                  }, "自动回复设置已保存")
                }
              />
              <span />
            </label>
            <button
              type="button"
              className="icon"
              title="展开服务控制"
              onClick={() => setControlOpen((value) => !value)}
            >
              {controlOpen ? <ChevronLeft size={16} /> : <Play size={16} />}
            </button>
            {controlOpen && (
              <div className="xianyu-controlbar__actions">
                <button type="button" className="icon" title="启动" onClick={() => action("start")}>
                  <Play size={15} />
                </button>
                <button type="button" className="icon" title="暂停" onClick={() => action("pause")}>
                  <Pause size={15} />
                </button>
                <button type="button" className="icon" title="恢复" onClick={() => action("resume")}>
                  <Play size={15} />
                </button>
                <button type="button" className="icon" title="停止" onClick={() => action("stop")}>
                  <Square size={15} />
                </button>
              </div>
            )}
          </section>
        )}
        {active?.metadata.kind === "control" && loginInfo?.status !== "authenticated" && (
          <section className="xianyu-login-card">
            <div>
              <strong>需要扫码登录闲鱼</strong>
              <p>{loginInfo?.message ?? "首次部署或登录过期后，请使用闲鱼 App 扫码。"}</p>
              <button type="button" className="run-action" onClick={startLogin} disabled={loading}>
                <RefreshCw size={15} />
                {loginInfo?.qrDataUrl ? "重新生成二维码" : "生成二维码"}
              </button>
            </div>
            {loginInfo?.qrDataUrl && <img src={loginInfo.qrDataUrl} alt="闲鱼登录二维码" />}
          </section>
        )}
        <section className="xianyu-transcript" aria-live="polite">
          {!activeId && <div className="xianyu-empty">选择一个会话开始处理。</div>}
          {entries.map((entry) =>
            entry.kind === "message" ? (
              <MessageBubble
                key={entry.item.id}
                item={entry.item}
                session={snapshot.data?.session}
                onRetry={undefined}
                onAttachment={undefined}
                onReview={undefined}
                onImprove={undefined}
                onEdit={undefined}
              />
            ) : (
              <div key={entry.id}>
                <ResponseCard
                  response={entry.response}
                  session={snapshot.data?.session}
                  run={entry.run}
                  items={entry.items}
                  onDownload={() => undefined}
                  isCurrentSegment={entry.isCurrentSegment}
                />
                <DraftAction
                  responseItems={entry.items}
                  draftIds={active?.draftMessageIds ?? []}
                  onSend={sendDraft}
                />
              </div>
            ),
          )}
        </section>
        {activeId && (
          <form className="xianyu-composer" onSubmit={sendPrompt}>
            <textarea
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              placeholder="向咸鱼 UmaAgent 询问状态、会话或运营操作"
              rows={2}
              disabled={loading}
            />
            <button type="submit" className="primary" disabled={!prompt.trim() || loading}>
              <Send size={16} />
              发送
            </button>
          </form>
        )}
        {notice && <p className="action-status">{notice}</p>}
        {error && <p className="error-text">{error}</p>}
      </main>
    </div>
  );
}

function DraftAction({
  responseItems,
  draftIds,
  onSend,
}: {
  responseItems: TranscriptItem[];
  draftIds: string[];
  onSend: (messageId: string) => void;
}) {
  const message = [...responseItems]
    .reverse()
    .find((item) => item.role === "assistant" && item.status === "complete");
  if (!message || !draftIds.includes(message.id)) return null;
  return (
    <div className="xianyu-draft-action">
      <span>草稿待发送</span>
      <button type="button" className="run-action" onClick={() => onSend(message.id)}>
        <Check size={15} />
        发送给买家
      </button>
    </div>
  );
}
