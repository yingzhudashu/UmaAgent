import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type EventConnectionState, type UmaClient, UmaClientError } from "@uma-agent/client";
import type { Approval, InteractionMode, SessionSnapshot, TranscriptItem } from "@uma-agent/protocol";
import {
  ArrowDown,
  Bot,
  CircleStop,
  FilePlus2,
  Menu,
  PanelRight,
  Pencil,
  RefreshCw,
  RotateCcw,
  Send,
  TerminalSquare,
  Trash2,
} from "lucide-react";
import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DiagnosticsArea } from "./areas/DiagnosticsArea.js";
import { EvaluationArea } from "./areas/EvaluationArea.js";
import { OptimizationArea } from "./areas/OptimizationArea.js";
import { ResourceArea } from "./areas/ResourceArea.js";
import { ApprovalBar, RunPanel } from "./areas/RunArea.js";
import { ScheduleArea } from "./areas/ScheduleArea.js";
import { SessionArea } from "./areas/SessionArea.js";
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
import { CommandPaletteHost } from "./components/CommandPalette.js";
import { InspectorContent } from "./components/InspectorContent.js";
import { InspectorDrawer } from "./components/InspectorDrawer.js";
import { ApprovalPanel, ConnectionPanel, SyncPanel } from "./components/InspectorStatusPanels.js";
import { MessageBubble } from "./components/MessageBubble.js";
import { ModeSelector } from "./components/ModeSelector.js";
import { ResponseCard } from "./components/ResponseCard.js";
import { SessionSettingsPanel } from "./components/SessionSettingsPanel.js";
import { type InspectorSection, StatusRail } from "./components/StatusRail.js";
import { Login } from "./Login.js";
import { buildConversationEntries } from "./responseTurns.js";

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
  const [createSessionError, setCreateSessionError] = useState<string>();
  const [prompt, setPrompt] = useState("");
  const [taskPrompt, setTaskPrompt] = useState("");
  const [interactionMode, setInteractionMode] = useState<InteractionMode>("agent");
  const [loginRequired, setLoginRequired] = useState<boolean>();
  const [userRole, setUserRole] = useState<"admin" | "user">("user");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [inspectorSection, setInspectorSection] = useState<InspectorSection>();
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [attachmentIds, setAttachmentIds] = useState<string[]>([]);
  const [browserOnline, setBrowserOnline] = useState(() => navigator.onLine);
  const [installPrompt, setInstallPrompt] = useState<InstallPromptEvent>();
  const [historical, setHistorical] = useState<TranscriptItem[]>([]);
  const [historyHasMore, setHistoryHasMore] = useState<boolean>();
  const [eventState, setEventState] = useState<EventConnectionState>(() => client.eventState());
  const [lastSyncAt, setLastSyncAt] = useState<number>();
  const [syncCursor, setSyncCursor] = useState<number>();
  const transcriptRef = useRef<HTMLElement>(null);
  const selectedForScrollRef = useRef<string | undefined>(undefined);
  const followTailRef = useRef(true);
  const scrollFrameRef = useRef<number | undefined>(undefined);
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);
  const [commandOpen, setCommandOpen] = useState(false);

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
  const health = useQuery({
    queryKey: ["health"],
    queryFn: () => client.health(),
    enabled: authenticated,
    refetchInterval: 15_000,
  });
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
  const evaluationTrends = useQuery({
    queryKey: ["evaluation-trends"],
    queryFn: () => client.listEvaluationTrends(Date.now() - 30 * 86_400_000, Date.now(), "day"),
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
    enabled: Boolean(selected && selected !== "undefined") && authenticated,
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
    if (sessions.isSuccess) {
      const available = sessions.data ?? [];
      if (selected && !available.some((session) => session.id === selected)) setSelected(undefined);
      if (!selected && available[0]) setSelected(available[0].id);
    }
  }, [sessions.error, sessions.data, sessions.isSuccess, selected, client]);
  useEffect(() => {
    if (authenticated) client.connectEvents();
  }, [authenticated, client]);
  useEffect(() => {
    if (!authenticated) return;
    const update = () => setEventState(client.eventState());
    update();
    const timer = window.setInterval(update, 1000);
    return () => window.clearInterval(timer);
  }, [authenticated, client]);
  useEffect(() => {
    if (!selected || selected === "undefined") return;
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
            setSyncCursor(durableSequence);
            setLastSyncAt(Date.now());
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
    const unique = [...new Map(items.map((item) => [item.id, item])).values()].sort(
      (a, b) => a.sequence - b.sequence,
    );
    return unique;
  }, [historical, snapshot.data?.transcript]);
  const conversationEntries = useMemo(
    () =>
      buildConversationEntries(transcript, snapshot.data?.responses ?? [], snapshot.data?.recentRuns ?? []),
    [transcript, snapshot.data?.responses, snapshot.data?.recentRuns],
  );
  const transcriptLength = transcript.length;
  const transcriptTail = transcript.at(-1);
  const transcriptTailSignature = transcriptTail
    ? `${transcriptTail.id}:${transcriptTail.sequence}:${transcriptTail.content.length}:${transcriptTail.status}`
    : "empty";
  const scrollToLatest = useCallback((behavior: ScrollBehavior = "auto") => {
    const area = transcriptRef.current;
    if (!area) return;
    if (scrollFrameRef.current !== undefined) cancelAnimationFrame(scrollFrameRef.current);
    scrollFrameRef.current = requestAnimationFrame(() => {
      area.scrollTo({ top: area.scrollHeight, behavior });
      followTailRef.current = true;
      setShowJumpToLatest(false);
      scrollFrameRef.current = undefined;
    });
  }, []);
  useEffect(
    () => () => {
      if (scrollFrameRef.current !== undefined) cancelAnimationFrame(scrollFrameRef.current);
    },
    [],
  );
  useEffect(() => {
    const area = transcriptRef.current;
    if (!area) return;
    const sessionChanged = selectedForScrollRef.current !== selected;
    if (sessionChanged) {
      selectedForScrollRef.current = selected;
      followTailRef.current = true;
      setShowJumpToLatest(false);
    }
    if (followTailRef.current && transcriptLength > 0) scrollToLatest();
  }, [selected, transcriptLength, scrollToLatest]);

  const onTranscriptScroll = () => {
    const area = transcriptRef.current;
    if (!area) return;
    const nearBottom = area.scrollHeight - area.scrollTop - area.clientHeight <= 96;
    followTailRef.current = nearBottom;
    setShowJumpToLatest(!nearBottom && transcriptLength > 0);
  };

  // New transcript items only move the viewport when the user is already following the tail.
  // biome-ignore lint/correctness/useExhaustiveDependencies: Streaming content changes are encoded in the tail signature.
  useEffect(() => {
    if (followTailRef.current && transcriptLength > 0) scrollToLatest();
  }, [transcriptTailSignature, transcriptLength, scrollToLatest]);

  const promptRef = useRef<HTMLTextAreaElement>(null);

  const createSession = useMutation({
    mutationFn: () => client.createSession(),
    onMutate: () => {
      setCreateSessionError(undefined);
    },
    onSuccess: async (session) => {
      setSelected(session.id);
      setSidebarOpen(false);
      setInteractionMode("agent");
      await queryClient.invalidateQueries({ queryKey: ["sessions"] });
      const value = await client.getSession(session.id);
      queryClient.setQueryData(["snapshot", session.id], value);
      await cacheSnapshot(value);
      await cacheHistory(session.id, []);
      await cacheCursor(session.id, value.snapshotSequence);
      setSyncCursor(value.snapshotSequence);
      setLastSyncAt(Date.now());
      requestAnimationFrame(() => promptRef.current?.focus());
    },
    onError: (error) => {
      setCreateSessionError(requestErrorMessage(error));
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
    enabled: Boolean(currentRun) && inspectorSection === "settings" && authenticated && userRole === "admin",
  });
  const browserOffline = !browserOnline;
  const coreUnavailable = authenticated && health.isError;
  const offline = browserOffline || coreUnavailable;
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
          disabled={browserOffline}
          creating={createSession.isPending}
          {...(createSessionError ? { createError: createSessionError } : {})}
          health={health.data}
          installable={Boolean(installPrompt)}
          create={() => createSession.mutate()}
          retryCreate={() => createSession.mutate()}
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
                onClick={() => {
                  setCommandOpen(true);
                }}
                title="快捷命令"
              >
                <TerminalSquare />
              </button>
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
                className={`icon ${inspectorSection ? "active" : ""}`}
                onClick={() => setInspectorSection((value) => (value ? undefined : "run"))}
                title="打开详情"
              >
                <PanelRight />
              </button>
            </div>
          </header>
          <section
            ref={transcriptRef}
            className="transcript"
            onScroll={onTranscriptScroll}
            aria-label="会话消息"
          >
            {(historyHasMore ?? snapshot.data?.history.hasMoreBefore) && (
              <button
                type="button"
                className="run-action"
                onClick={() => {
                  if (!selected) return;
                  const before = transcript[0]?.sequence ?? snapshot.data?.history.oldestMessageSequence;
                  const area = transcriptRef.current;
                  const previousHeight = area?.scrollHeight ?? 0;
                  const previousTop = area?.scrollTop ?? 0;
                  void client.getSessionHistory(selected, before, 100).then((page) => {
                    if (selected !== selectedForScrollRef.current) return;
                    const next = [...page.items, ...historical];
                    const unique = [...new Map(next.map((item) => [item.id, item])).values()].sort(
                      (a, b) => a.sequence - b.sequence,
                    );
                    setHistorical(unique);
                    setHistoryHasMore(page.hasMore);
                    void cacheHistory(selected, unique);
                    requestAnimationFrame(() => {
                      const current = transcriptRef.current;
                      if (current) current.scrollTop = current.scrollHeight - previousHeight + previousTop;
                    });
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
            {conversationEntries.map((entry) =>
              entry.kind === "message" ? (
                <MessageBubble
                  key={entry.item.id}
                  item={entry.item}
                  onRetry={entry.item.role === "user" ? () => retryMessage(entry.item) : undefined}
                  onReview={
                    entry.item.role === "assistant"
                      ? () => void client.reviewMessage(entry.item.id).then(() => snapshot.refetch())
                      : undefined
                  }
                  onImprove={
                    entry.item.role === "assistant"
                      ? () => void client.improveMessage(entry.item.id).then(() => snapshot.refetch())
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
              ) : (
                <ResponseCard
                  key={entry.id}
                  response={entry.response}
                  run={entry.run}
                  items={entry.items}
                  onReview={(messageId) =>
                    void client.reviewMessage(messageId).then(() => snapshot.refetch())
                  }
                  onImprove={(messageId) =>
                    void client.improveMessage(messageId).then(() => snapshot.refetch())
                  }
                  {...(entry.response.status === "awaiting_confirmation"
                    ? {
                        onConfirm: () =>
                          void client.confirmPlan(entry.response.runId).then(() => snapshot.refetch()),
                      }
                    : {})}
                  onDownload={(id) =>
                    void client.downloadAttachment(id).then((blob) => {
                      const url = URL.createObjectURL(blob);
                      const link = document.createElement("a");
                      link.href = url;
                      link.download =
                        entry.response.attachments.find((item) => item.id === id)?.name ?? "download";
                      link.click();
                      setTimeout(() => URL.revokeObjectURL(url), 60_000);
                    })
                  }
                />
              ),
            )}
            <div aria-hidden="true" />
          </section>
          {showJumpToLatest && (
            <button
              type="button"
              className="jump-latest"
              onClick={() => scrollToLatest("smooth")}
              title="回到最新消息"
            >
              <ArrowDown size={15} />
              最新消息
            </button>
          )}
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
                ref={promptRef}
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
        <CommandPaletteHost
          open={commandOpen}
          client={client}
          sessionId={selected}
          models={models.data}
          sessions={sessions.data}
          snapshot={snapshot.data}
          tasks={tasks.data}
          schedules={schedules.data}
          knowledge={knowledge.data}
          memoryCount={memories.data?.length ?? 0}
          report={report.data}
          publicConfig={publicConfig.data}
          evaluations={evaluations.data}
          optimization={optimization.data}
          skills={skills}
          onClose={() => setCommandOpen(false)}
        />
        <StatusRail
          online={!offline}
          busy={Boolean(busy)}
          approvals={approvals.filter((approval) => approval.sessionId === selected).length}
          open={inspectorSection}
          onOpen={(section) => setInspectorSection((current) => (current === section ? undefined : section))}
        />
        {inspectorSection && (
          <InspectorDrawer
            section={inspectorSection}
            onClose={() => {
              setInspectorSection(undefined);
            }}
          >
            <InspectorContent>
              {inspectorSection === "connection" && <ConnectionPanel health={health.data} />}
              {inspectorSection === "sync" && (
                <SyncPanel
                  browserOnline={browserOnline}
                  coreAvailable={!health.isError}
                  selected={selected}
                  eventState={eventState}
                  lastSyncAt={lastSyncAt}
                  cursor={syncCursor}
                  retry={() => client.connectEvents()}
                />
              )}
              {inspectorSection === "approvals" && (
                <ApprovalPanel
                  approvals={approvals}
                  selected={selected}
                  disabled={offline}
                  resolve={(approval, approved) => void resolveApproval(approval, approved)}
                />
              )}
              {inspectorSection === "run" && (
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
              {inspectorSection === "settings" && (
                <section className="inspector-group">
                  <h3>后台任务</h3>
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
                        <textarea
                          value={taskPrompt}
                          onChange={(event) => setTaskPrompt(event.target.value)}
                        />
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
                              setInspectorSection("run");
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
                </section>
              )}
              {inspectorSection === "settings" && (
                <section className="inspector-group">
                  <h3>记忆</h3>
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
                </section>
              )}
              {inspectorSection === "settings" && (
                <section className="inspector-group">
                  <h3>调度</h3>
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
                </section>
              )}
              {inspectorSection === "settings" && (
                <section className="inspector-group">
                  <h3>资源</h3>
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
                    reindexKnowledge={(id) =>
                      void client.reindexKnowledge(id).then(() => knowledge.refetch())
                    }
                    searchKnowledge={(query, sourceId) => client.searchKnowledge(query, sourceId)}
                  />
                </section>
              )}
              {inspectorSection === "settings" && userRole === "admin" && (
                <section className="inspector-group">
                  <h3>管理</h3>
                  <EvaluationArea reports={evaluations.data ?? []} trends={evaluationTrends.data ?? []} />
                  <DiagnosticsArea report={diagnostics.data} />
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
                </section>
              )}
              {inspectorSection === "settings" && (
                <section className="inspector-group">
                  <h3>会话设置</h3>
                  <SessionSettingsPanel
                    session={snapshot.data?.session}
                    health={health.data}
                    installAvailable={Boolean(installPrompt)}
                    install={() => void installPrompt?.prompt()}
                    report={report.data}
                    profile={profile.data}
                    saveProfile={async (content) => {
                      await client.updateAgentProfile(content);
                      await profile.refetch();
                    }}
                    logout={() => {
                      void client.logout().finally(() => {
                        setInteractionMode("agent");
                        setSelected(undefined);
                        setLoginRequired(true);
                        void clearCacheNamespace();
                        queryClient.clear();
                      });
                    }}
                    reloadConfig={() =>
                      void client.reloadConfig().then(() => queryClient.invalidateQueries())
                    }
                    publicConfig={publicConfig.data}
                    disabled={offline}
                  />
                </section>
              )}
            </InspectorContent>
          </InspectorDrawer>
        )}
      </div>
    </div>
  );
}
