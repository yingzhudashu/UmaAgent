import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type UmaClient, UmaClientError } from "@uma-agent/client";
import type { Approval, SessionSnapshot, TranscriptItem } from "@uma-agent/protocol";
import DOMPurify from "dompurify";
import {
  Bot,
  CircleStop,
  FilePlus2,
  Menu,
  PanelRight,
  Pencil,
  RefreshCw,
  RotateCcw,
  Send,
  Trash2,
} from "lucide-react";
import { marked } from "marked";
import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { DiagnosticsArea } from "./areas/DiagnosticsArea.js";
import { EvaluationArea } from "./areas/EvaluationArea.js";
import { OptimizationArea } from "./areas/OptimizationArea.js";
import { ResourceArea } from "./areas/ResourceArea.js";
import { ApprovalBar, RunPanel } from "./areas/RunArea.js";
import { ScheduleArea } from "./areas/ScheduleArea.js";
import { SessionArea } from "./areas/SessionArea.js";
import { SettingsArea } from "./areas/SettingsArea.js";
import {
  cacheCursor,
  cachedCursor,
  cachedHistory,
  cachedSessions,
  cachedSnapshot,
  cacheHistory,
  cacheSessions,
  cacheSnapshot,
  clearCacheNamespace,
  setCacheNamespace,
} from "./cache.js";
import { Login } from "./Login.js";

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

export interface AppProps {
  client: UmaClient;
  embedded?: boolean;
  theme?: "light" | "dark";
}

export function App({ client, embedded = false, theme = "light" }: AppProps) {
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<string>();
  const [prompt, setPrompt] = useState("");
  const [taskPrompt, setTaskPrompt] = useState("");
  const [loginRequired, setLoginRequired] = useState<boolean>();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [panelOpen, setPanelOpen] = useState(true);
  const [detailsTab, setDetailsTab] = useState<
    | "run"
    | "tasks"
    | "schedules"
    | "memory"
    | "resources"
    | "evaluations"
    | "diagnostics"
    | "optimization"
    | "settings"
    | "audit"
  >("run");
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [attachmentIds, setAttachmentIds] = useState<string[]>([]);
  const [browserOnline, setBrowserOnline] = useState(() => navigator.onLine);
  const [installPrompt, setInstallPrompt] = useState<InstallPromptEvent>();
  const [historical, setHistorical] = useState<TranscriptItem[]>([]);
  const [historyHasMore, setHistoryHasMore] = useState<boolean>();
  const endRef = useRef<HTMLDivElement>(null);

  const sessions = useQuery({
    queryKey: ["sessions"],
    queryFn: async () => {
      try {
        const bootstrap = await client.syncBootstrap();
        setCacheNamespace(bootstrap.user.id, client.serverOrigin);
        const values = bootstrap.sessions.map((item) => item.session);
        await cacheSessions(values);
        return values;
      } catch (error) {
        const cached = await cachedSessions();
        if (cached) return cached;
        throw error;
      }
    },
  });
  const authenticated = loginRequired === false;
  const models = useQuery({
    queryKey: ["models"],
    queryFn: () => client.listModels(),
    enabled: authenticated,
  });
  const health = useQuery({ queryKey: ["health"], queryFn: () => client.health(), refetchInterval: 15_000 });
  const tasks = useQuery({
    queryKey: ["tasks"],
    queryFn: () => client.listTasks(),
    enabled: authenticated,
  });
  const schedules = useQuery({
    queryKey: ["schedules"],
    queryFn: () => client.listSchedules(),
    enabled: authenticated,
  });
  const report = useQuery({
    queryKey: ["operations-report"],
    queryFn: () => client.operationsReport(),
    enabled: authenticated,
  });
  const diagnostics = useQuery({
    queryKey: ["diagnostics"],
    queryFn: () => client.diagnosticsReport(),
    enabled: authenticated,
  });
  const evaluations = useQuery({
    queryKey: ["evaluations"],
    queryFn: () => client.listEvaluationReports(),
    enabled: authenticated,
  });
  const optimization = useQuery({
    queryKey: ["optimization"],
    queryFn: () => client.listOptimizationProposals(),
    enabled: authenticated,
  });
  const publicConfig = useQuery({
    queryKey: ["config"],
    queryFn: () => client.publicConfig(),
    enabled: authenticated,
  });
  const memories = useQuery({
    queryKey: ["memory", "candidate"],
    queryFn: () => client.listMemoryFacts("candidate"),
    enabled: authenticated,
  });
  const skills = useQuery({
    queryKey: ["skills"],
    queryFn: () => client.skillState(),
    enabled: authenticated,
  });
  const profile = useQuery({
    queryKey: ["profile"],
    queryFn: () => client.getAgentProfile(),
    enabled: authenticated,
  });
  const mcp = useQuery({ queryKey: ["mcp"], queryFn: () => client.mcpStatus(), enabled: authenticated });
  const knowledge = useQuery({
    queryKey: ["knowledge"],
    queryFn: () => client.listKnowledge(),
    enabled: authenticated,
  });
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
    enabled: Boolean(selected) && authenticated,
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
  useEffect(
    () =>
      client.subscribeResources((event) => {
        const resources = event.type === "resource.invalidated" ? [event.resource] : event.resources;
        for (const resource of resources) {
          const key = resource === "memory" ? ["memory"] : [resource];
          void queryClient.invalidateQueries({ queryKey: key });
        }
      }),
    [queryClient, client],
  );
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
    if (sessions.error instanceof UmaClientError && sessions.error.status === 401) {
      setLoginRequired(true);
      void clearCacheNamespace();
      client.close();
    }
    if (sessions.isSuccess) setLoginRequired(false);
    if (!selected && sessions.data?.[0]) setSelected(sessions.data[0].id);
  }, [sessions.error, sessions.data, sessions.isSuccess, selected, client]);
  useEffect(() => {
    if (authenticated) client.connectEvents();
  }, [authenticated, client]);
  useEffect(() => {
    if (!selected) return;
    let unsubscribe: (() => void) | undefined;
    let cancelled = false;
    void Promise.all([cachedCursor(selected), cachedHistory(selected)])
      .catch(() => undefined)
      .then((cached) => {
        if (cancelled) return;
        setHistorical(cached?.[1] ?? []);
        setHistoryHasMore(undefined);
        unsubscribe = client.subscribeSessions(
          [{ id: selected, lastSequence: cached?.[0] ?? 0 }],
          (event) => {
            const durableSequence =
              event.type === "session.snapshot"
                ? (event.payload as SessionSnapshot).snapshotSequence
                : event.sequence;
            void cacheCursor(selected, durableSequence);
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
  }, [selected, queryClient, client]);
  const transcript = useMemo(() => {
    const items = [...historical, ...(snapshot.data?.transcript ?? [])];
    return [...new Map(items.map((item) => [item.id, item])).values()].sort(
      (a, b) => a.sequence - b.sequence,
    );
  }, [historical, snapshot.data?.transcript]);
  const transcriptLength = transcript.length;
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
    [...(snapshot.data?.recentRuns ?? [])]
      .reverse()
      .find(
        (run) => !["completed", "failed", "cancelled", "interrupted", "awaiting_input"].includes(run.status),
      ) ?? snapshot.data?.recentRuns.at(-1);
  const busy = currentRun && ["queued", "preflight", "running", "verifying"].includes(currentRun.status);
  const checkpoints = useQuery({
    queryKey: ["checkpoints", currentRun?.id],
    queryFn: () => client.listRunCheckpoints(currentRun?.id as string),
    enabled: Boolean(currentRun) && authenticated,
  });
  const actions = useQuery({
    queryKey: ["actions", currentRun?.id],
    queryFn: () => client.listRunActions(currentRun?.id as string),
    enabled: Boolean(currentRun) && authenticated,
  });
  const audit = useQuery({
    queryKey: ["audit", currentRun?.id],
    queryFn: () => client.listAudit(currentRun?.id as string),
    enabled: Boolean(currentRun) && detailsTab === "audit" && authenticated,
  });
  const offline = !browserOnline || health.isError;
  const Workspace = embedded ? "div" : "main";

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
    const lastUser = [...transcript].reverse().find((item) => item.role === "user");
    if (!lastUser || !selected) return;
    const ids = lastUser.attachments.map((attachment) => attachment.id);
    void client
      .sendMessage(selected, lastUser.content, ids.length ? { attachmentIds: ids } : {})
      .then(() => queryClient.invalidateQueries({ queryKey: ["snapshot", selected] }));
  };

  if (loginRequired === undefined)
    return (
      <div className={`uma-embed uma-embed--${embedded ? "embedded" : "standalone"} theme-${theme}`}>
        <output className="login-shell">正在连接 UmaAgent Core…</output>
      </div>
    );
  if (loginRequired)
    return (
      <div className={`uma-embed uma-embed--${embedded ? "embedded" : "standalone"} theme-${theme}`}>
        <Login
          client={client}
          embedded={embedded}
          onDone={() => {
            setLoginRequired(false);
            void sessions.refetch();
          }}
        />
      </div>
    );
  return (
    <div className={`uma-embed uma-embed--${embedded ? "embedded" : "standalone"} theme-${theme}`}>
      <div className="app-shell">
        <SessionArea
          sessions={sessions.data ?? []}
          selected={selected}
          open={sidebarOpen}
          disabled={offline}
          health={health.data}
          installable={Boolean(installPrompt)}
          create={(mode) => createSession.mutate(mode)}
          select={(id) => {
            setSelected(id);
            setSidebarOpen(false);
          }}
          close={() => setSidebarOpen(false)}
          install={() => {
            void installPrompt?.prompt().then(() => setInstallPrompt(undefined));
          }}
        />
        <Workspace className="workspace">
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
                  value={snapshot.data.session.queueMode}
                  disabled={offline}
                  onChange={(event) =>
                    updateSession.mutate({ queueMode: event.target.value as "queue" | "preemptive" })
                  }
                  title="消息队列模式"
                >
                  <option value="queue">queue</option>
                  <option value="preemptive">preemptive</option>
                </select>
              )}
              {snapshot.data && (
                <select
                  className="model-select"
                  value={`${snapshot.data.session.model.provider}/${snapshot.data.session.model.id}`}
                  disabled={offline}
                  onChange={(event) => {
                    const [provider, ...id] = event.target.value.split("/");
                    if (provider && id.length)
                      updateSession.mutate({ model: { provider, id: id.join("/") } });
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
                onClick={() =>
                  selected && void client.compactSession(selected).then(() => snapshot.refetch())
                }
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
            {(historyHasMore ?? snapshot.data?.history.hasMoreBefore) && (
              <button
                type="button"
                className="run-action"
                onClick={() => {
                  if (!selected) return;
                  const before = transcript[0]?.sequence ?? snapshot.data?.history.oldestMessageSequence;
                  void client.getSessionHistory(selected, before, 100).then((page) => {
                    const next = [...page.items, ...historical];
                    const unique = [...new Map(next.map((item) => [item.id, item])).values()].sort(
                      (a, b) => a.sequence - b.sequence,
                    );
                    setHistorical(unique);
                    setHistoryHasMore(page.hasMore);
                    void cacheHistory(selected, unique);
                  });
                }}
              >
                加载更早记录
              </button>
            )}
            {!transcript.length && (
              <div className="empty">
                <div className="brand-mark large">
                  <Bot size={30} />
                </div>
                <h2>开始一个任务</h2>
                <p>消息、工具和计划都会在服务器上持久化。</p>
              </div>
            )}
            {transcript.map((item) => (
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
                  <>
                    {item.revisionOfMessageId && (
                      <small className="operation-meta">修订自 {item.revisionOfMessageId}</small>
                    )}
                    <Markdown content={item.content} />
                    <div className="approval-actions">
                      <button
                        type="button"
                        disabled={offline}
                        onClick={() => void client.reviewMessage(item.id).then(() => snapshot.refetch())}
                      >
                        审查
                      </button>
                      <button
                        type="button"
                        disabled={offline}
                        onClick={() => void client.improveMessage(item.id).then(() => snapshot.refetch())}
                      >
                        改进
                      </button>
                    </div>
                  </>
                ) : item.role === "tool" ? (
                  <pre>{item.content}</pre>
                ) : (
                  <p>{item.content}</p>
                )}
                {item.attachments.map((attachment) => (
                  <button
                    type="button"
                    className="run-action"
                    key={attachment.id}
                    onClick={() =>
                      void client.attachmentContent(attachment.id).then((blob) => {
                        const url = URL.createObjectURL(blob);
                        window.open(url, "_blank", "noopener,noreferrer");
                        setTimeout(() => URL.revokeObjectURL(url), 60_000);
                      })
                    }
                  >
                    {attachment.name}
                  </button>
                ))}
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
        </Workspace>
        {panelOpen && (
          <aside className="details">
            <div className="detail-tabs">
              {(
                [
                  "run",
                  "tasks",
                  "schedules",
                  "memory",
                  "resources",
                  "evaluations",
                  "diagnostics",
                  "optimization",
                  "settings",
                  "audit",
                ] as const
              ).map((tab) => (
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
                resume={() =>
                  currentRun && void client.resumeRun(currentRun.id).then(() => snapshot.refetch())
                }
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
                <form
                  className="resource-form"
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (!taskPrompt.trim()) return;
                    void client.createTask(taskPrompt.trim(), selected).then(() => {
                      setTaskPrompt("");
                      void tasks.refetch();
                    });
                  }}
                >
                  <label>
                    后台任务
                    <textarea value={taskPrompt} onChange={(event) => setTaskPrompt(event.target.value)} />
                  </label>
                  <button type="submit" className="run-action" disabled={offline || !taskPrompt.trim()}>
                    新建后台任务
                  </button>
                </form>
                {tasks.data?.map((task) => (
                  <div key={task.id}>
                    <strong>{task.status}</strong>
                    <p>{task.prompt}</p>
                    {task.runId && (
                      <button
                        type="button"
                        onClick={() => {
                          setSelected(task.sessionId);
                          setDetailsTab("run");
                        }}
                      >
                        打开运行
                      </button>
                    )}
                    {["pending", "running"].includes(task.status) && (
                      <button
                        type="button"
                        disabled={offline}
                        onClick={() => void client.cancelTask(task.id).then(() => tasks.refetch())}
                      >
                        取消
                      </button>
                    )}
                    {!["pending", "running"].includes(task.status) && (
                      <button
                        type="button"
                        disabled={offline}
                        onClick={() => void client.deleteTask(task.id).then(() => tasks.refetch())}
                      >
                        删除记录
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
                    <p>
                      {fact.key} = {fact.value}
                    </p>
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
            {detailsTab === "schedules" && (
              <ScheduleArea
                schedules={schedules.data ?? []}
                disabled={offline}
                create={(input) => void client.createSchedule(input).then(() => schedules.refetch())}
                toggle={(id, enabled) =>
                  void client.updateSchedule(id, { enabled }).then(() => schedules.refetch())
                }
                run={(id) => void client.runSchedule(id).then(() => schedules.refetch())}
                remove={(id) => void client.deleteSchedule(id).then(() => schedules.refetch())}
                loadRuns={(id) => client.listScheduleRuns(id)}
                cancelRun={(id) => void client.cancelScheduleRun(id).then(() => schedules.refetch())}
              />
            )}
            {detailsTab === "resources" && (
              <ResourceArea
                skills={skills.data?.available ?? []}
                packages={skills.data?.packages ?? []}
                mcp={mcp.data ?? []}
                knowledge={knowledge.data ?? []}
                disabled={offline}
                refreshSkills={() => void client.refreshSkills().then(() => skills.refetch())}
                installSkill={(reference) =>
                  void client.installSkill({ source: "local", reference }).then(() => skills.refetch())
                }
                setSkillStatus={(id, action) =>
                  void client.setSkillStatus(id, action).then(() => skills.refetch())
                }
                addKnowledgePath={(name, path) =>
                  void client.indexKnowledge(name, path).then(() => knowledge.refetch())
                }
                uploadKnowledge={(file) =>
                  void client
                    .upload(file, file.name, selected)
                    .then((attachment) => {
                      if (!selected) throw new Error("Select a session before uploading knowledge");
                      return client.indexKnowledgeAttachment(file.name, attachment.id, selected);
                    })
                    .then(() => knowledge.refetch())
                }
                deleteKnowledge={(id) => void client.deleteKnowledge(id).then(() => knowledge.refetch())}
                reindexKnowledge={(id) => void client.reindexKnowledge(id).then(() => knowledge.refetch())}
                searchKnowledge={(query, sourceId) => client.searchKnowledge(query, sourceId)}
              />
            )}
            {detailsTab === "evaluations" && <EvaluationArea reports={evaluations.data ?? []} />}
            {detailsTab === "diagnostics" && <DiagnosticsArea report={diagnostics.data} />}
            {detailsTab === "optimization" && (
              <OptimizationArea
                proposals={optimization.data ?? []}
                disabled={offline}
                generate={() =>
                  void client.generateOptimizationProposals().then(() => optimization.refetch())
                }
                decide={(id, status) =>
                  void client.decideOptimizationProposal(id, status).then(() => optimization.refetch())
                }
              />
            )}
            {detailsTab === "settings" && (
              <SettingsArea
                session={snapshot.data?.session}
                health={health.data}
                installAvailable={Boolean(installPrompt)}
                install={() => void installPrompt?.prompt()}
                report={report.data}
                profile={profile.data}
                saveProfile={(content) =>
                  void client.updateAgentProfile(content).then(() => profile.refetch())
                }
                reloadConfig={() => void client.reloadConfig().then(() => queryClient.invalidateQueries())}
                publicConfig={publicConfig.data}
                disabled={offline}
              />
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
    </div>
  );
}
