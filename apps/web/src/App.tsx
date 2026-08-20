import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { UmaClient, UmaClientError } from "@uma-agent/client";
import type { Approval, Run, RunAction, RunCheckpoint, SessionSnapshot } from "@uma-agent/protocol";
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
import { cachedSnapshot, cacheSnapshot } from "./cache.js";

const coreUrl = import.meta.env.VITE_UMA_CORE_URL?.trim() || window.location.origin;
const client = new UmaClient({ baseUrl: coreUrl });
client.connectEvents();

interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

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

function RunPanel({
  run,
  checkpoints,
  actions,
  retry,
  resume,
  decide,
  disabled,
}: {
  run: Run | undefined;
  checkpoints: RunCheckpoint[];
  actions: RunAction[];
  retry: () => void;
  resume: () => void;
  decide: (action: RunAction, decision: "approve" | "reject" | "acknowledge") => void;
  disabled: boolean;
}) {
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
      {checkpoints.at(-1) && (
        <p className="muted">
          检查点 #{checkpoints.at(-1)?.checkpointNo} · {checkpoints.at(-1)?.phase}
        </p>
      )}
      {actions
        .filter((action) => ["prepared", "uncertain"].includes(action.status))
        .map((action) => (
          <div className="action-card" key={action.id}>
            <strong>{action.toolName}</strong>
            <small className="action-status">{action.status}</small>
            <div className="approval-actions">
              <button type="button" disabled={disabled} onClick={() => decide(action, "reject")}>
                拒绝
              </button>
              {action.status === "prepared" ? (
                <button
                  type="button"
                  className="primary"
                  disabled={disabled}
                  onClick={() => decide(action, "approve")}
                >
                  执行一次
                </button>
              ) : (
                <button
                  type="button"
                  className="primary"
                  disabled={disabled}
                  onClick={() => decide(action, "acknowledge")}
                >
                  确认可能已执行
                </button>
              )}
            </div>
          </div>
        ))}
      {run.status === "interrupted" && run.resume?.state === "available" && (
        <button type="button" className="run-action" disabled={disabled} onClick={resume}>
          继续运行
        </button>
      )}
      {["failed", "cancelled"].includes(run.status) && (
        <button type="button" className="run-action" disabled={disabled} onClick={retry}>
          <RotateCcw size={15} />
          重试
        </button>
      )}
    </div>
  );
}

function ApprovalBar({
  approval,
  resolve,
  disabled,
}: {
  approval: Approval;
  resolve: (approved: boolean) => void;
  disabled: boolean;
}) {
  return (
    <div className="approval">
      <div>
        <strong>{approval.toolName}</strong>
        <code>{JSON.stringify(approval.input)}</code>
      </div>
      <div className="approval-actions">
        <button type="button" disabled={disabled} onClick={() => resolve(false)}>
          <X size={16} />
          拒绝
        </button>
        <button type="button" className="primary" disabled={disabled} onClick={() => resolve(true)}>
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
  const [detailsTab, setDetailsTab] = useState<"run" | "tasks" | "memory" | "system" | "audit">("run");
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [attachmentIds, setAttachmentIds] = useState<string[]>([]);
  const [browserOnline, setBrowserOnline] = useState(() => navigator.onLine);
  const [installPrompt, setInstallPrompt] = useState<InstallPromptEvent>();
  const endRef = useRef<HTMLDivElement>(null);

  const sessions = useQuery({ queryKey: ["sessions"], queryFn: () => client.listSessions() });
  const models = useQuery({ queryKey: ["models"], queryFn: () => client.listModels() });
  const health = useQuery({ queryKey: ["health"], queryFn: () => client.health(), refetchInterval: 15_000 });
  const tasks = useQuery({ queryKey: ["tasks"], queryFn: () => client.listTasks() });
  const memories = useQuery({
    queryKey: ["memory", "candidate"],
    queryFn: () => client.listMemoryFacts("candidate"),
  });
  const skills = useQuery({ queryKey: ["skills"], queryFn: () => client.listSkills() });
  const mcp = useQuery({ queryKey: ["mcp"], queryFn: () => client.mcpStatus() });
  const knowledge = useQuery({ queryKey: ["knowledge"], queryFn: () => client.listKnowledge() });
  const snapshot = useQuery({
    queryKey: ["snapshot", selected],
    queryFn: async () => {
      const sessionId = selected as string;
      try {
        const value = await client.getSession(sessionId);
        await cacheSnapshot(value);
        return value;
      } catch (error) {
        const cached = await cachedSnapshot(sessionId);
        if (cached) return cached;
        throw error;
      }
    },
    enabled: Boolean(selected),
    refetchInterval: false,
  });
  useEffect(() => {
    const capture = (event: Event) => {
      event.preventDefault();
      setInstallPrompt(event as InstallPromptEvent);
    };
    window.addEventListener("beforeinstallprompt", capture);
    return () => window.removeEventListener("beforeinstallprompt", capture);
  }, []);
  useEffect(() => {
    const online = () => setBrowserOnline(true);
    const offline = () => setBrowserOnline(false);
    window.addEventListener("online", online);
    window.addEventListener("offline", offline);
    return () => {
      window.removeEventListener("online", online);
      window.removeEventListener("offline", offline);
    };
  }, []);
  useEffect(() => {
    if (sessions.error instanceof UmaClientError && sessions.error.status === 401) setLoginRequired(true);
    if (!selected && sessions.data?.[0]) setSelected(sessions.data[0].id);
  }, [sessions.error, sessions.data, selected]);
  useEffect(() => {
    if (!selected) return;
    let unsubscribe: (() => void) | undefined;
    let cancelled = false;
    void cachedSnapshot(selected)
      .catch(() => undefined)
      .then((cached) => {
        if (cancelled) return;
        unsubscribe = client.subscribeSessions(
          [{ id: selected, lastSequence: cached?.snapshotSequence ?? 0 }],
          (event) => {
            if (event.type === "approval.requested")
              setApprovals((items) => [
                ...items.filter((item) => item.id !== (event.payload as Approval).id),
                event.payload as Approval,
              ]);
            if (event.type === "approval.resolved")
              setApprovals((items) => items.filter((item) => item.id !== (event.payload as Approval).id));
            if (event.type === "session.snapshot")
              queryClient.setQueryData(["snapshot", selected], event.payload as SessionSnapshot);
            if (event.type === "session.snapshot") void cacheSnapshot(event.payload as SessionSnapshot);
            else void queryClient.invalidateQueries({ queryKey: ["snapshot", selected] });
            void queryClient.invalidateQueries({ queryKey: ["sessions"] });
          },
        );
      });
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [selected, queryClient]);
  const transcriptLength = snapshot.data?.transcript.length;
  // biome-ignore lint/correctness/useExhaustiveDependencies: New transcript items must trigger scrolling.
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [transcriptLength]);

  const createSession = useMutation({
    mutationFn: (mode: "workspace" | "assistant") => client.createSession({ mode }),
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
  const checkpoints = useQuery({
    queryKey: ["checkpoints", currentRun?.id],
    queryFn: () => client.listRunCheckpoints(currentRun?.id as string),
    enabled: Boolean(currentRun),
  });
  const actions = useQuery({
    queryKey: ["actions", currentRun?.id],
    queryFn: () => client.listRunActions(currentRun?.id as string),
    enabled: Boolean(currentRun),
  });
  const audit = useQuery({
    queryKey: ["audit", currentRun?.id],
    queryFn: () => client.listAudit(currentRun?.id as string),
    enabled: Boolean(currentRun) && detailsTab === "audit",
  });
  const offline = !browserOnline || health.isError;

  const upload = async (file: File) => {
    if (offline) return;
    const attachment = await client.upload(file, file.name, selected);
    setAttachmentIds((items) => [...items, attachment.id]);
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (prompt.trim() && selected && !offline) sendMessage.mutate(prompt.trim());
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
        <button
          type="button"
          className="new-session"
          disabled={offline}
          onClick={() => createSession.mutate("workspace")}
        >
          <MessageSquarePlus size={17} />
          新会话
        </button>
        <button
          type="button"
          className="new-session"
          disabled={offline}
          onClick={() => createSession.mutate("assistant")}
        >
          <MessageSquarePlus size={17} />
          助手会话
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
              <span>
                {session.mode === "assistant" ? "助手 · " : ""}
                {session.title}
              </span>
              <small>{session.model.id}</small>
            </button>
          ))}
        </nav>
        <div className="sidebar-footer">
          <span className={`health-dot ${health.data?.status === "ok" ? "online" : "offline"}`} />
          Core {health.data?.status === "ok" ? "online" : "offline"}
          {installPrompt && (
            <button
              type="button"
              onClick={() => {
                void installPrompt.prompt().then(() => setInstallPrompt(undefined));
              }}
            >
              安装应用
            </button>
          )}
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
                disabled={offline}
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
              disabled={!selected || offline}
            >
              <Pencil />
            </button>
            <button
              type="button"
              className="icon"
              onClick={removeSession}
              title="删除会话"
              disabled={!selected || offline}
            >
              <Trash2 />
            </button>
            <button type="button" className="icon" onClick={() => void snapshot.refetch()} title="刷新">
              <RefreshCw />
            </button>
            <button
              type="button"
              className="icon"
              onClick={() => selected && void client.compactSession(selected).then(() => snapshot.refetch())}
              title="压缩上下文"
              disabled={!selected || offline}
            >
              <RotateCcw />
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
                disabled={offline}
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
                disabled={!selected || offline}
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
              disabled={!selected || offline}
            />
            {busy ? (
              <button
                type="button"
                className="danger icon"
                onClick={() => selected && void client.cancel(selected)}
                disabled={offline}
                title="停止"
              >
                <CircleStop />
              </button>
            ) : (
              <button
                type="submit"
                className="primary icon"
                disabled={!prompt.trim() || !selected || offline}
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
          <div className="detail-tabs">
            {(["run", "tasks", "memory", "system", "audit"] as const).map((tab) => (
              <button
                type="button"
                className={`detail-tab ${detailsTab === tab ? "active" : ""}`}
                onClick={() => setDetailsTab(tab)}
                key={tab}
              >
                {tab}
              </button>
            ))}
          </div>
          {detailsTab === "run" && (
            <RunPanel
              run={currentRun}
              checkpoints={checkpoints.data ?? []}
              actions={actions.data ?? []}
              retry={retryLast}
              resume={() => currentRun && void client.resumeRun(currentRun.id).then(() => snapshot.refetch())}
              decide={(action, decision) =>
                currentRun &&
                void client.decideRunAction(currentRun.id, action.id, decision).then(() => {
                  void actions.refetch();
                  void snapshot.refetch();
                })
              }
              disabled={offline}
            />
          )}
          {detailsTab === "tasks" && (
            <div className="operation-list">
              <button
                type="button"
                className="run-action"
                disabled={offline}
                onClick={() => {
                  const value = window.prompt("后台任务内容")?.trim();
                  if (value)
                    void client.createTask(value, selected).then(() => {
                      void tasks.refetch();
                    });
                }}
              >
                新建后台任务
              </button>
              {tasks.data?.map((task) => (
                <div key={task.id}>
                  <strong>{task.status}</strong>
                  <p>{task.prompt}</p>
                  {["pending", "running"].includes(task.status) && (
                    <button
                      type="button"
                      disabled={offline}
                      onClick={() => void client.cancelTask(task.id).then(() => tasks.refetch())}
                    >
                      取消
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
          {detailsTab === "memory" && (
            <div className="operation-list">
              {memories.data?.map((fact) => (
                <div key={fact.id}>
                  <p>{fact.content}</p>
                  <small className="operation-meta">{fact.confidence.toFixed(2)}</small>
                  <div className="approval-actions">
                    <button
                      type="button"
                      disabled={offline}
                      onClick={() =>
                        void client.reviewMemoryFact(fact.id, "rejected").then(() => memories.refetch())
                      }
                    >
                      拒绝
                    </button>
                    <button
                      type="button"
                      className="primary"
                      disabled={offline}
                      onClick={() =>
                        void client.reviewMemoryFact(fact.id, "active").then(() => memories.refetch())
                      }
                    >
                      保留
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
          {detailsTab === "system" && (
            <div className="operation-list">
              <div>
                <strong>Skills</strong>
                <p>{skills.data?.map((item) => item.name).join(", ") || "-"}</p>
                <button
                  type="button"
                  disabled={offline}
                  onClick={() => void client.refreshSkills().then(() => skills.refetch())}
                >
                  刷新
                </button>
              </div>
              <div>
                <strong>MCP</strong>
                <p>
                  {mcp.data
                    ?.map((item) => `${item.name}:${item.connected ? "online" : "offline"}`)
                    .join(", ") || "-"}
                </p>
              </div>
              <div>
                <strong>Knowledge</strong>
                <p>
                  {knowledge.data?.map((item) => `${item.name} (${item.documentCount})`).join(", ") || "-"}
                </p>
                <button
                  type="button"
                  disabled={offline}
                  onClick={() => {
                    const path = window.prompt("服务器上的知识目录路径")?.trim();
                    if (!path) return;
                    const name = window
                      .prompt("知识库名称", path.split(/[\\/]/).at(-1) || "Knowledge")
                      ?.trim();
                    if (name)
                      void client.indexKnowledge(name, path).then(() => {
                        void knowledge.refetch();
                      });
                  }}
                >
                  添加目录
                </button>
              </div>
            </div>
          )}
          {detailsTab === "audit" && (
            <div className="operation-list">
              {audit.data?.map((record) => (
                <div key={record.id}>
                  <strong>
                    {record.kind} · {record.name}
                  </strong>
                  <small className="operation-meta">{record.status}</small>
                  {record.error && <p className="error">{record.error}</p>}
                </div>
              ))}
            </div>
          )}
        </aside>
      )}
    </div>
  );
}
