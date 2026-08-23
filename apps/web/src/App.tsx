import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type UmaClient, UmaClientError } from "@uma-agent/client";
import type { Approval, InteractionMode, SessionSnapshot, TranscriptItem } from "@uma-agent/protocol";
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
import { InspectorDrawer } from "./components/InspectorDrawer.js";
import { MessageBubble } from "./components/MessageBubble.js";
import { ModeSelector } from "./components/ModeSelector.js";
import { type InspectorSection, StatusRail } from "./components/StatusRail.js";
import { Login } from "./Login.js";

interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
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
  const [interactionMode, setInteractionMode] = useState<InteractionMode>("ask");
  const [loginRequired, setLoginRequired] = useState<boolean>();
  const [userRole, setUserRole] = useState<"admin" | "user">("user");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);
  const [inspectorSection, setInspectorSection] = useState<InspectorSection>();
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
        setUserRole(bootstrap.user.role);
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
    enabled: authenticated && userRole === "admin",
  });
  const diagnostics = useQuery({
    queryKey: ["diagnostics"],
    queryFn: () => client.diagnosticsReport(),
    enabled: authenticated && userRole === "admin",
  });
  const evaluations = useQuery({
    queryKey: ["evaluations"],
    queryFn: () => client.listEvaluationReports(),
    enabled: authenticated && userRole === "admin",
  });
  const optimization = useQuery({
    queryKey: ["optimization"],
    queryFn: () => client.listOptimizationProposals(),
    enabled: authenticated && userRole === "admin",
  });
  const publicConfig = useQuery({
    queryKey: ["config"],
    queryFn: () => client.publicConfig(),
    enabled: authenticated && userRole === "admin",
  });
  const memories = useQuery({
    queryKey: ["memory", "candidate"],
    queryFn: () => client.listMemoryFacts("candidate"),
    enabled: authenticated,
  });
  const skills = useQuery({
    queryKey: ["skills"],
    queryFn: () => client.skillState(),
    enabled: authenticated && userRole === "admin",
  });
  const profile = useQuery({
    queryKey: ["profile"],
    queryFn: () => client.getAgentProfile(),
    enabled: authenticated,
  });
  const mcp = useQuery({
    queryKey: ["mcp"],
    queryFn: () => client.mcpStatus(),
    enabled: authenticated && userRole === "admin",
  });
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
    const authError = Number((sessions.error as { status?: unknown } | null)?.status) === 401;
    if (authError) {
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
    mutationFn: () => client.createSession(),
    onSuccess: (session) => {
      setSelected(session.id);
      void queryClient.invalidateQueries({ queryKey: ["sessions"] });
    },
  });
  const sendMessage = useMutation({
    mutationFn: (text: string) =>
      client.sendMessage(selected as string, text, {
        mode: interactionMode,
        ...(attachmentIds.length ? { attachmentIds } : {}),
      }),
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
  const connectionMessage = !browserOnline
    ? "当前设备处于离线状态，已缓存内容仍可阅读。"
    : health.isError
      ? "无法连接 UmaAgent Core，请检查服务状态后重试。"
      : undefined;
  const requestErrorMessage = (error: unknown): string => {
    if (!(error instanceof UmaClientError)) return "请求未完成，请稍后重试。";
    if (error.code === "provider_error" || error.code === "provider_contract_error")
      return `模型服务暂时不可用${error.requestId ? `（请求 ${error.requestId}）` : ""}。`;
    if (error.code === "forbidden") return "当前账号没有执行此操作的权限。";
    if (error.code === "rate_limited") return "请求过于频繁，请稍后重试。";
    return `${error.message}${error.requestId ? `（请求 ${error.requestId}）` : ""}`;
  };
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
    const mode = snapshot.data?.recentRuns.find((run) => run.id === lastUser.runId)?.interactionMode;
    if (!mode) return;
    const ids = lastUser.attachments.map((attachment) => attachment.id);
    void client
      .sendMessage(selected, lastUser.content, {
        mode,
        ...(ids.length ? { attachmentIds: ids } : {}),
      })
      .then(() => queryClient.invalidateQueries({ queryKey: ["snapshot", selected] }));
  };
  const retryMessage = (item: TranscriptItem) => {
    if (item.role !== "user" || !selected) return;
    const mode = snapshot.data?.recentRuns.find((run) => run.id === item.runId)?.interactionMode;
    if (!mode) return;
    const ids = item.attachments.map((attachment) => attachment.id);
    void client
      .sendMessage(selected, item.content, { mode, ...(ids.length ? { attachmentIds: ids } : {}) })
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
          create={() => createSession.mutate()}
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
                onClick={() => {
                  setPanelOpen((value) => !value);
                  setInspectorSection((value) => (value ? undefined : "run"));
                }}
                title="打开详情"
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
              <MessageBubble
                key={item.id}
                item={item}
                onRetry={item.role === "user" ? () => retryMessage(item) : undefined}
                onReview={
                  item.role === "assistant"
                    ? () => void client.reviewMessage(item.id).then(() => snapshot.refetch())
                    : undefined
                }
                onImprove={
                  item.role === "assistant"
                    ? () => void client.improveMessage(item.id).then(() => snapshot.refetch())
                    : undefined
                }
                onAttachment={(id) =>
                  void client.attachmentContent(id).then((blob) => {
                    const url = URL.createObjectURL(blob);
                    window.open(url, "_blank", "noopener,noreferrer");
                    setTimeout(() => URL.revokeObjectURL(url), 60_000);
                  })
                }
              />
            ))}
            <div ref={endRef} />
          </section>
          <div className="composer-wrap">
            {connectionMessage && <p className="connection-notice">{connectionMessage}</p>}
            {sendMessage.isError && (
              <div className="composer-error" role="alert">
                <span>{requestErrorMessage(sendMessage.error)}</span>
                <button
                  type="button"
                  className="text-action"
                  onClick={() => {
                    sendMessage.reset();
                    retryLast();
                  }}
                >
                  重试
                </button>
              </div>
            )}
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
            <ModeSelector
              value={interactionMode}
              onChange={setInteractionMode}
              disabled={!selected || offline}
            />
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
        <StatusRail
          online={!offline}
          busy={Boolean(busy)}
          approvals={approvals.filter((approval) => approval.sessionId === selected).length}
          open={panelOpen ? inspectorSection : undefined}
          onOpen={(section) => {
            setPanelOpen(true);
            setInspectorSection(section);
            if (section === "run") setDetailsTab("run");
            if (section === "settings") setDetailsTab("settings");
            if (section === "resources") setDetailsTab("resources");
          }}
        />
        {panelOpen && inspectorSection && (
          <InspectorDrawer
            section={inspectorSection}
            onClose={() => {
              setPanelOpen(false);
              setInspectorSection(undefined);
            }}
          >
            <div className="details">
              <div className="detail-tabs">
                {(
                  [
                    "run",
                    "tasks",
                    "schedules",
                    "memory",
                    "resources",
                    ...(userRole === "admin" ? ["evaluations", "diagnostics", "optimization"] : []),
                    "settings",
                    ...(userRole === "admin" ? ["audit"] : []),
                  ] as const
                ).map((tab) => (
                  <button
                    type="button"
                    className={`detail-tab ${detailsTab === tab ? "active" : ""}`}
                    onClick={() => setDetailsTab(tab as typeof detailsTab)}
                    key={tab}
                  >
                    {
                      {
                        run: "运行",
                        tasks: "后台任务",
                        schedules: "调度",
                        memory: "记忆",
                        resources: "资源",
                        evaluations: "评测",
                        diagnostics: "诊断",
                        optimization: "优化",
                        settings: "设置",
                        audit: "审计",
                      }[tab]
                    }
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
                  admin={userRole === "admin"}
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
                  logout={() => {
                    void client.logout().finally(() => {
                      setInteractionMode("ask");
                      setSelected(undefined);
                      setLoginRequired(true);
                      void clearCacheNamespace();
                      queryClient.clear();
                    });
                  }}
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
            </div>
          </InspectorDrawer>
        )}
      </div>
    </div>
  );
}
