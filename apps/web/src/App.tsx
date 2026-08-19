import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { UmaClient, UmaClientError } from "@uma-agent/client";
import type { Approval, Run, SessionSnapshot } from "@uma-agent/protocol";
import DOMPurify from "dompurify";
import {
  Bot,
  Check,
  ChevronLeft,
  CircleStop,
  FilePlus2,
  LogIn,
  Menu,
  MessageSquarePlus,
  PanelRight,
  Pencil,
  RefreshCw,
  RotateCcw,
  Send,
  Trash2,
  X,
} from "lucide-react";
import { marked } from "marked";
import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";

const client = new UmaClient({ baseUrl: window.location.origin });
client.connectEvents();

function Markdown({ content }: { content: string }) {
  const html = useMemo(
    () => DOMPurify.sanitize(marked.parse(content, { async: false }) as string),
    [content],
  );
  // biome-ignore lint/security/noDangerouslySetInnerHtml: DOMPurify sanitizes the generated Markdown HTML.
  return <div className="markdown" dangerouslySetInnerHTML={{ __html: html }} />;
}

function Login({ onDone }: { onDone: () => void }) {
  const [token, setToken] = useState("");
  const [error, setError] = useState("");
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    try {
      await client.login(token);
      onDone();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "登录失败");
    }
  };
  return (
    <main className="login-shell">
      <form className="login" onSubmit={submit}>
        <div className="brand-mark">
          <Bot size={24} />
        </div>
        <h1>UmaAgent</h1>
        <p>连接到你的 Agent Core</p>
        <label>
          访问令牌
          <input type="password" value={token} onChange={(event) => setToken(event.target.value)} />
        </label>
        {error && <div className="error">{error}</div>}
        <button className="primary" type="submit">
          <LogIn size={17} />
          登录
        </button>
      </form>
    </main>
  );
}

function RunPanel({ run, retry }: { run: Run | undefined; retry: () => void }) {
  if (!run) return <div className="empty-panel">暂无运行信息</div>;
  return (
    <div className="run-panel">
      <div className="panel-label">当前运行</div>
      <div className={`status status-${run.status}`}>{run.status.replace("_", " ")}</div>
      {run.reasoningSummary && (
        <>
          <div className="panel-label">判断</div>
          <p>{run.reasoningSummary}</p>
        </>
      )}
      {run.plan.length > 0 && (
        <>
          <div className="panel-label">计划</div>
          <ol className="plan">
            {run.plan.map((step) => (
              <li key={step.id} data-status={step.status}>
                {step.status === "completed" ? <Check size={14} /> : <span className="step-dot" />}
                {step.title}
              </li>
            ))}
          </ol>
        </>
      )}
      {run.error && <div className="error">{run.error}</div>}
      {["failed", "cancelled", "interrupted"].includes(run.status) && (
        <button type="button" className="run-action" onClick={retry}>
          <RotateCcw size={15} />
          重试
        </button>
      )}
    </div>
  );
}

function ApprovalBar({ approval, resolve }: { approval: Approval; resolve: (approved: boolean) => void }) {
  return (
    <div className="approval">
      <div>
        <strong>{approval.toolName}</strong>
        <code>{JSON.stringify(approval.input)}</code>
      </div>
      <div className="approval-actions">
        <button type="button" onClick={() => resolve(false)}>
          <X size={16} />
          拒绝
        </button>
        <button type="button" className="primary" onClick={() => resolve(true)}>
          <Check size={16} />
          允许
        </button>
      </div>
    </div>
  );
}

export function App() {
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<string>();
  const [prompt, setPrompt] = useState("");
  const [loginRequired, setLoginRequired] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [panelOpen, setPanelOpen] = useState(true);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [attachmentIds, setAttachmentIds] = useState<string[]>([]);
  const endRef = useRef<HTMLDivElement>(null);

  const sessions = useQuery({ queryKey: ["sessions"], queryFn: () => client.listSessions() });
  const models = useQuery({ queryKey: ["models"], queryFn: () => client.listModels() });
  const health = useQuery({ queryKey: ["health"], queryFn: () => client.health(), refetchInterval: 15_000 });
  const snapshot = useQuery({
    queryKey: ["snapshot", selected],
    queryFn: () => client.getSession(selected as string),
    enabled: Boolean(selected),
    refetchInterval: false,
  });
  useEffect(() => {
    if (sessions.error instanceof UmaClientError && sessions.error.status === 401) setLoginRequired(true);
    if (!selected && sessions.data?.[0]) setSelected(sessions.data[0].id);
  }, [sessions.error, sessions.data, selected]);
  useEffect(() => {
    if (!selected) return;
    return client.subscribe(selected, (event) => {
      if (event.type === "approval.requested")
        setApprovals((items) => [
          ...items.filter((item) => item.id !== (event.payload as Approval).id),
          event.payload as Approval,
        ]);
      if (event.type === "approval.resolved")
        setApprovals((items) => items.filter((item) => item.id !== (event.payload as Approval).id));
      if (event.type === "session.snapshot")
        queryClient.setQueryData(["snapshot", selected], event.payload as SessionSnapshot);
      else void queryClient.invalidateQueries({ queryKey: ["snapshot", selected] });
      void queryClient.invalidateQueries({ queryKey: ["sessions"] });
    });
  }, [selected, queryClient]);
  const transcriptLength = snapshot.data?.transcript.length;
  // biome-ignore lint/correctness/useExhaustiveDependencies: New transcript items must trigger scrolling.
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [transcriptLength]);

  const createSession = useMutation({
    mutationFn: () => client.createSession(),
    onSuccess: (session) => {
      setSelected(session.id);
      void queryClient.invalidateQueries({ queryKey: ["sessions"] });
    },
  });
  const sendMessage = useMutation({
    mutationFn: (text: string) =>
      client.sendMessage(selected as string, text, attachmentIds.length ? { attachmentIds } : {}),
    onSuccess: () => {
      setPrompt("");
      setAttachmentIds([]);
      void queryClient.invalidateQueries({ queryKey: ["snapshot", selected] });
    },
  });
  const updateSession = useMutation({
    mutationFn: (patch: Parameters<typeof client.updateSession>[1]) =>
      client.updateSession(selected as string, patch),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["sessions"] });
      void queryClient.invalidateQueries({ queryKey: ["snapshot", selected] });
    },
  });
  const deleteSession = useMutation({
    mutationFn: (id: string) => client.deleteSession(id),
    onSuccess: () => {
      setSelected(undefined);
      void queryClient.invalidateQueries({ queryKey: ["sessions"] });
    },
  });
  const currentRun =
    [...(snapshot.data?.runs ?? [])]
      .reverse()
      .find(
        (run) => !["completed", "failed", "cancelled", "interrupted", "awaiting_input"].includes(run.status),
      ) ?? snapshot.data?.runs.at(-1);
  const busy = currentRun && ["queued", "preflight", "running", "verifying"].includes(currentRun.status);

  const upload = async (file: File) => {
    const attachment = await client.upload(file, file.name, selected);
    setAttachmentIds((items) => [...items, attachment.id]);
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (prompt.trim() && selected) sendMessage.mutate(prompt.trim());
  };
  const resolveApproval = async (approval: Approval, approved: boolean) => {
    await client.resolveApproval(approval.id, approved);
    setApprovals((items) => items.filter((item) => item.id !== approval.id));
  };
  const renameSession = () => {
    const current = snapshot.data?.session;
    if (!current) return;
    const title = window.prompt("会话名称", current.title)?.trim();
    if (title && title !== current.title) updateSession.mutate({ title });
  };
  const removeSession = () => {
    if (selected && window.confirm("删除此会话及其全部记录？")) deleteSession.mutate(selected);
  };
  const retryLast = () => {
    const lastUser = [...(snapshot.data?.transcript ?? [])].reverse().find((item) => item.role === "user");
    if (!lastUser || !selected) return;
    const ids = lastUser.attachments.map((attachment) => attachment.id);
    void client
      .sendMessage(selected, lastUser.content, ids.length ? { attachmentIds: ids } : {})
      .then(() => queryClient.invalidateQueries({ queryKey: ["snapshot", selected] }));
  };

  if (loginRequired)
    return (
      <Login
        onDone={() => {
          setLoginRequired(false);
          void sessions.refetch();
        }}
      />
    );
  return (
    <div className="app-shell">
      <aside className={`sidebar ${sidebarOpen ? "open" : ""}`}>
        <div className="brand">
          <div className="brand-mark">
            <Bot size={20} />
          </div>
          <span>UmaAgent</span>
          <button
            type="button"
            className="icon mobile-only"
            onClick={() => setSidebarOpen(false)}
            title="关闭导航"
          >
            <ChevronLeft />
          </button>
        </div>
        <button type="button" className="new-session" onClick={() => createSession.mutate()}>
          <MessageSquarePlus size={17} />
          新会话
        </button>
        <nav>
          {sessions.data?.map((session) => (
            <button
              type="button"
              key={session.id}
              className={selected === session.id ? "active" : ""}
              onClick={() => {
                setSelected(session.id);
                setSidebarOpen(false);
              }}
            >
              <span>{session.title}</span>
              <small>{session.model.id}</small>
            </button>
          ))}
        </nav>
        <div className="sidebar-footer">
          <span className={`health-dot ${health.data?.status === "ok" ? "online" : "offline"}`} />
          Core {health.data?.status === "ok" ? "online" : "offline"}
        </div>
      </aside>
      <main className="workspace">
        <header>
          <button
            type="button"
            className="icon mobile-only"
            onClick={() => setSidebarOpen(true)}
            title="打开导航"
          >
            <Menu />
          </button>
          <div>
            <h1>{snapshot.data?.session.title ?? "选择会话"}</h1>
            <span className="header-subtitle">{snapshot.data?.session.workspace}</span>
          </div>
          <div className="header-actions">
            {snapshot.data && (
              <select
                className="model-select"
                value={`${snapshot.data.session.model.provider}/${snapshot.data.session.model.id}`}
                onChange={(event) => {
                  const [provider, ...id] = event.target.value.split("/");
                  if (provider && id.length) updateSession.mutate({ model: { provider, id: id.join("/") } });
                }}
                title="模型"
              >
                {models.data?.map((model) => (
                  <option key={`${model.provider}/${model.id}`} value={`${model.provider}/${model.id}`}>
                    {model.provider}/{model.id}
                  </option>
                ))}
              </select>
            )}
            <button
              type="button"
              className="icon"
              onClick={renameSession}
              title="重命名会话"
              disabled={!selected}
            >
              <Pencil />
            </button>
            <button
              type="button"
              className="icon"
              onClick={removeSession}
              title="删除会话"
              disabled={!selected}
            >
              <Trash2 />
            </button>
            <button type="button" className="icon" onClick={() => void snapshot.refetch()} title="刷新">
              <RefreshCw />
            </button>
            <button
              type="button"
              className={`icon ${panelOpen ? "active" : ""}`}
              onClick={() => setPanelOpen((value) => !value)}
              title="运行面板"
            >
              <PanelRight />
            </button>
          </div>
        </header>
        <section className="transcript">
          {!snapshot.data?.transcript.length && (
            <div className="empty">
              <div className="brand-mark large">
                <Bot size={30} />
              </div>
              <h2>开始一个任务</h2>
              <p>消息、工具和计划都会在服务器上持久化。</p>
            </div>
          )}
          {snapshot.data?.transcript.map((item) => (
            <article key={item.id} className={`message ${item.role}`}>
              <div className="message-meta">
                <span>
                  {item.role === "user" ? "你" : item.role === "assistant" ? "Uma" : (item.name ?? "工具")}
                </span>
                <time>
                  {new Date(item.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                </time>
                {item.status === "streaming" && <span className="streaming">运行中</span>}
              </div>
              {item.role === "assistant" ? (
                <Markdown content={item.content} />
              ) : item.role === "tool" ? (
                <pre>{item.content}</pre>
              ) : (
                <p>{item.content}</p>
              )}
            </article>
          ))}
          <div ref={endRef} />
        </section>
        <div className="composer-wrap">
          {approvals
            .filter((approval) => approval.sessionId === selected)
            .map((approval) => (
              <ApprovalBar
                key={approval.id}
                approval={approval}
                resolve={(approved) => void resolveApproval(approval, approved)}
              />
            ))}
          {attachmentIds.length > 0 && (
            <div className="attachments">
              已附加 {attachmentIds.length} 个文件{" "}
              <button type="button" onClick={() => setAttachmentIds([])}>
                清除
              </button>
            </div>
          )}
          <form className="composer" onSubmit={submit}>
            <label
              className="icon file-button"
              htmlFor="attachment-upload"
              title="上传文件"
              aria-label="上传文件"
            >
              <FilePlus2 />
              <input
                id="attachment-upload"
                type="file"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) void upload(file);
                }}
              />
            </label>
            <textarea
              rows={1}
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  event.currentTarget.form?.requestSubmit();
                }
              }}
              placeholder={selected ? "向 UmaAgent 发送消息" : "先创建会话"}
              disabled={!selected}
            />
            {busy ? (
              <button
                type="button"
                className="danger icon"
                onClick={() => selected && void client.cancel(selected)}
                title="停止"
              >
                <CircleStop />
              </button>
            ) : (
              <button
                type="submit"
                className="primary icon"
                disabled={!prompt.trim() || !selected}
                title="发送"
              >
                <Send />
              </button>
            )}
          </form>
        </div>
      </main>
      {panelOpen && (
        <aside className="details">
          <RunPanel run={currentRun} retry={retryLast} />
        </aside>
      )}
    </div>
  );
}
