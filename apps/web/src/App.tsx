import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  type EventConnectionState,
  type MaintenanceStatus,
  type UmaClient,
  UmaClientError,
} from "@uma-agent/client";
import type {
  Approval,
  Attachment,
  InteractionMode,
  QualityAssessment,
  SessionSnapshot,
  TranscriptItem,
} from "@uma-agent/protocol";
import {
  ArrowDown,
  Bot,
  ChevronRight,
  CircleStop,
  FilePlus2,
  Menu,
  Pencil,
  RefreshCw,
  RotateCcw,
  Send,
  Store,
  TerminalSquare,
  Trash2,
} from "lucide-react";
import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BackgroundTaskArea } from "./areas/BackgroundTaskArea.js";
import { DiagnosticsArea } from "./areas/DiagnosticsArea.js";
import { EvaluationArea } from "./areas/EvaluationArea.js";
import { MemoryArea } from "./areas/MemoryArea.js";
import { OptimizationArea } from "./areas/OptimizationArea.js";
import { ResourceArea } from "./areas/ResourceArea.js";
import { ApprovalBar, RunPanel } from "./areas/RunArea.js";
import { ScheduleArea } from "./areas/ScheduleArea.js";
import { SessionArea } from "./areas/SessionArea.js";
import { XianyuArea } from "./areas/XianyuArea.js";
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
import { useQualityHistory } from "./quality-history.js";
import { buildConversationEntries } from "./responseTurns.js";
import { applyStreamingEvent } from "./streaming.js";

interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

type QualityOperation = {
  kind: "review" | "improve";
  status: "running" | "completed" | "failed";
  runId?: string;
  error?: string;
  assessments?: readonly QualityAssessment[];
  result?: string;
};
export interface AppProps {
  client: UmaClient;
  embedded?: boolean;
  theme?: "light" | "dark";
}

function preserveStreamingContent(
  current: SessionSnapshot | undefined,
  next: SessionSnapshot,
): SessionSnapshot {
  if (!current) return next;
  const previous = new Map(current.transcript.map((item) => [item.id, item]));
  return {
    ...next,
    transcript: next.transcript.map((item) => {
      const old = previous.get(item.id);
      return old?.status === "streaming" && old.content.length > item.content.length
        ? { ...item, content: old.content, updatedAt: old.updatedAt }
        : item;
    }),
  };
}

export function App({ client, embedded = false, theme = "light" }: AppProps) {
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<string>();
  const [createSessionError, setCreateSessionError] = useState<string>();
  const [prompt, setPrompt] = useState("");
  const [interactionMode, setInteractionMode] = useState<InteractionMode>("agent");
  const [loginRequired, setLoginRequired] = useState<boolean>();
  const [userRole, setUserRole] = useState<"admin" | "user">("user");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [inspectorSection, setInspectorSection] = useState<InspectorSection>();
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
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
  const [qualityOperations, setQualityOperations] = useState<Record<string, QualityOperation>>({});
  const mergeQualityHistory = useCallback((restored: Record<string, QualityOperation>) => {
    setQualityOperations((current) => {
      const next = { ...current };
      for (const [messageId, operation] of Object.entries(restored))
        if (current[messageId]?.status !== "running") next[messageId] = operation;
      return next;
    });
  }, []);

  const sessions = useQuery({
    queryKey: ["sessions"],
    enabled: loginRequired !== true,
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
  const maintenance = useQuery<MaintenanceStatus>({
    queryKey: ["maintenance"],
    queryFn: () => client.maintenanceStatus(),
    refetchInterval: 10_000,
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
  const selectedSession = sessions.data?.find((item) => item.id === selected);
  const activeBranchId = selectedSession?.activeBranchId;
  const snapshot = useQuery({
    queryKey: ["snapshot", selected, activeBranchId],
    queryFn: async () => {
      const sessionId = selected as string;
      try {
        const value = await client.getSession(sessionId);
        await cacheSnapshot(value);
        return value;
      } catch (error) {
        const cached = await cachedSnapshot(sessionId, activeBranchId);
        if (cached) return cached;
        throw error;
      }
    },
    enabled: Boolean(selected && selected !== "undefined") && authenticated,
    refetchInterval: false,
  });
  useQualityHistory(
    client,
    snapshot.data?.transcript,
    Boolean(authenticated),
    selected && `${selected}:${snapshot.data?.snapshotSequence ?? 0}`,
    mergeQualityHistory,
  );
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
    if (loginRequired === true) return;
    const authError = Number((sessions.error as { status?: unknown } | null)?.status) === 401;
    if (authError) {
      setLoginRequired(true);
      void clearCacheNamespace();
      client.close();
    }
    if (sessions.isSuccess) setLoginRequired(false);
    if (sessions.isError && loginRequired === undefined) setLoginRequired(true);
    if (sessions.isSuccess) {
      const available = sessions.data ?? [];
      if (selected && !available.some((session) => session.id === selected)) setSelected(undefined);
      if (!selected && available[0]) setSelected(available[0].id);
    }
  }, [sessions.error, sessions.data, sessions.isSuccess, sessions.isError, selected, client, loginRequired]);
  useEffect(() => {
    if (loginRequired !== undefined || sessions.isSuccess) return;
    const timer = window.setTimeout(() => {
      if (!sessions.isSuccess) setLoginRequired(true);
    }, 10_000);
    return () => window.clearTimeout(timer);
  }, [loginRequired, sessions.isSuccess]);
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
    void Promise.all([cachedCursor(selected), cachedHistory(selected, activeBranchId)])
      .catch(() => undefined)
      .then((cached) => {
        if (cancelled) return;
        setHistorical(cached?.[1] ?? []);
        setHistoryHasMore(undefined);
        unsubscribe = client.subscribeSessions(
          [{ id: selected, lastSequence: cached?.[0] ?? 0 }],
          (event) => {
            const transient = event.type === "message.delta" && "transient" in event && event.transient;
            const durableSequence =
              event.type === "session.snapshot"
                ? (event.payload as SessionSnapshot).snapshotSequence
                : event.sequence;
            if (!transient) {
              void cacheCursor(selected, durableSequence);
              setSyncCursor(durableSequence);
            }
            setLastSyncAt(Date.now());
            if (event.type === "approval.requested")
              setApprovals((items) => [
                ...items.filter((item) => item.id !== (event.payload as Approval).id),
                event.payload as Approval,
              ]);
            if (event.type === "approval.resolved")
              setApprovals((items) => items.filter((item) => item.id !== (event.payload as Approval).id));
            if (event.type === "session.snapshot")
              queryClient.setQueryData<SessionSnapshot>(
                ["snapshot", selected, (event.payload as SessionSnapshot).session.activeBranchId],
                (current) => preserveStreamingContent(current, event.payload as SessionSnapshot),
              );
            if (event.type === "session.snapshot") {
              void cacheSnapshot(event.payload as SessionSnapshot);
            } else if (event.type === "message.delta") {
              applyStreamingEvent(queryClient, selected, event, activeBranchId);
            } else {
              void queryClient.invalidateQueries({ queryKey: ["snapshot", selected] });
            }
            if (event.type !== "message.delta")
              void queryClient.invalidateQueries({ queryKey: ["sessions"] });
          },
        );
      });
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [selected, activeBranchId, queryClient, client]);
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
      queryClient.setQueryData(["snapshot", session.id, value.session.activeBranchId], value);
      await cacheSnapshot(value);
      await cacheHistory(session.id, [], value.session.activeBranchId);
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
        ...(attachments.length ? { attachmentIds: attachments.map((item) => item.id) } : {}),
      }),
    onSuccess: () => {
      setPrompt("");
      setAttachments([]);
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
  const offline = browserOffline || coreUnavailable || maintenance.data?.maintenance === true;
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
  const upload = async (file: Blob, name = "pasted-image.png") => {
    if (offline || !selected) return;
    const attachment = await client.upload(file, name, selected);
    setAttachments((items) => [...items, attachment]);
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if ((prompt.trim() || attachments.length > 0) && selected && !offline)
      sendMessage.mutate(prompt.trim() || "请分析这张图片。");
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
  const editMessage = async (item: TranscriptItem, text: string): Promise<void> => {
    if (!selected || item.role !== "user") throw new Error("当前会话不可用");
    const sessionId = selected;
    try {
      const result = await client.editMessage(item.id, text);
      // 编辑会话切换了活动分支；旧分页记录属于旧分支，必须立即丢弃，
      // 否则重新获取快照时会与新分支内容合并显示。
      setHistorical([]);
      setHistoryHasMore(undefined);
      await cacheHistory(sessionId, []);
      await queryClient.invalidateQueries({ queryKey: ["sessions"] });
      await queryClient.invalidateQueries({ queryKey: ["snapshot", sessionId] });
      await client.waitForRun(result.runId);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["sessions"] }),
        queryClient.invalidateQueries({ queryKey: ["snapshot", sessionId] }),
        queryClient.invalidateQueries({ queryKey: ["history", sessionId] }),
      ]);
    } catch (error) {
      throw new Error(requestErrorMessage(error));
    }
  };
  const startQuality = (messageId: string, kind: "review" | "improve") => {
    const current = qualityOperations[messageId];
    if (current?.status === "running" || !selected) return;
    const sessionId = selected;
    setQualityOperations((items) => ({ ...items, [messageId]: { kind, status: "running" } }));
    const request = kind === "review" ? client.reviewMessage(messageId) : client.improveMessage(messageId);
    void request
      .then((started) => {
        setQualityOperations((items) => ({
          ...items,
          [messageId]: { kind, status: "running", runId: started.runId },
        }));
        return client.waitForRun(started.runId).then(async (run) => {
          const assessments = await client.listRunQuality(started.runId);
          const latest = run.resultMessageId
            ? (await client.getSession(sessionId)).transcript.find((item) => item.id === run.resultMessageId)
                ?.content
            : undefined;
          setQualityOperations((items) => ({
            ...items,
            [messageId]: {
              kind,
              status: "completed",
              runId: started.runId,
              assessments,
              ...(latest !== undefined ? { result: latest } : {}),
            },
          }));
          await queryClient.invalidateQueries({ queryKey: ["snapshot", sessionId] });
        });
      })
      .catch((error) => {
        setQualityOperations((items) => ({
          ...items,
          [messageId]: {
            kind,
            status: "failed",
            error: requestErrorMessage(error),
          },
        }));
      });
  };
  const signOut = () => {
    const logout = client.logout();
    setLoginRequired(true);
    client.close();
    setInteractionMode("agent");
    setSelected(undefined);
    setPrompt("");
    setApprovals([]);
    setAttachments([]);
    setHistorical([]);
    setHistoryHasMore(undefined);
    setInspectorSection(undefined);
    setSidebarOpen(false);
    setUserRole("user");
    void queryClient.cancelQueries();
    queryClient.clear();
    void clearCacheNamespace();
    void logout.catch(() => undefined);
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
        {maintenance.data?.maintenance && (
          <output className="maintenance-banner">
            {maintenance.data.message ?? "系统正在停服更新，请稍候。"}
          </output>
        )}
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
                className={`icon ${inspectorSection === "xianyu" ? "active" : ""}`}
                onClick={() =>
                  setInspectorSection((current) => (current === "xianyu" ? undefined : "xianyu"))
                }
                title="咸鱼控制台"
              >
                <Store />
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
                    void cacheHistory(selected, unique, activeBranchId);
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
                  session={snapshot.data?.session}
                  onRetry={entry.item.role === "user" ? () => retryMessage(entry.item) : undefined}
                  onEdit={entry.item.role === "user" ? (text) => editMessage(entry.item, text) : undefined}
                  onReview={
                    entry.item.role === "assistant" ? () => startQuality(entry.item.id, "review") : undefined
                  }
                  onImprove={
                    entry.item.role === "assistant" ? () => startQuality(entry.item.id, "improve") : undefined
                  }
                  {...(qualityOperations[entry.item.id]
                    ? {
                        qualityOperation: qualityOperations[entry.item.id],
                        onQualityRetry: () =>
                          startQuality(entry.item.id, qualityOperations[entry.item.id]?.kind ?? "review"),
                      }
                    : {})}
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
                  session={snapshot.data?.session}
                  run={entry.run}
                  items={entry.items}
                  isCurrentSegment={entry.isCurrentSegment}
                  onReview={(messageId) => startQuality(messageId, "review")}
                  onImprove={(messageId) => startQuality(messageId, "improve")}
                  {...(() => {
                    const messageId = entry.items.filter((item) => item.role === "assistant").at(-1)?.id;
                    const operation = messageId ? qualityOperations[messageId] : undefined;
                    return operation
                      ? {
                          qualityOperation: operation,
                          onQualityRetry: () => startQuality(messageId as string, operation.kind),
                        }
                      : {};
                  })()}
                  {...(entry.response.status === "awaiting_confirmation" && entry.isCurrentSegment
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
            {(snapshot.data?.queue?.length ?? 0) > 0 && (
              <details className="queue-panel" open>
                <summary className="queue-panel__heading">
                  <strong>排队中</strong>
                  <span>{snapshot.data?.queue.length} 条</span>
                </summary>
                <div className="queue-panel__list">
                  {snapshot.data?.queue.map((item, index, queue) => (
                    <div className="queue-item" key={item.run.id}>
                      <span className="queue-item__position">{item.position}</span>
                      <span className="queue-item__text" title={item.message.content}>
                        {item.message.content}
                      </span>
                      <button
                        type="button"
                        className="icon"
                        title="移至队首"
                        aria-label="移至队首"
                        onClick={() => void client.prioritizeRun(item.run.id).then(() => snapshot.refetch())}
                      >
                        <ArrowDown size={14} className="queue-move-first" />
                      </button>
                      <button
                        type="button"
                        className="icon"
                        title="上移"
                        aria-label="上移"
                        disabled={index === 0}
                        onClick={() => {
                          const ids = queue.map((entry) => entry.run.id);
                          [ids[index - 1], ids[index]] = [ids[index] as string, ids[index - 1] as string];
                          void client.reorderQueue(selected as string, ids).then(() => snapshot.refetch());
                        }}
                      >
                        <ChevronRight size={14} className="queue-up" />
                      </button>
                      <button
                        type="button"
                        className="icon"
                        title="下移"
                        aria-label="下移"
                        disabled={index === queue.length - 1}
                        onClick={() => {
                          const ids = queue.map((entry) => entry.run.id);
                          [ids[index], ids[index + 1]] = [ids[index + 1] as string, ids[index] as string];
                          void client.reorderQueue(selected as string, ids).then(() => snapshot.refetch());
                        }}
                      >
                        <ChevronRight size={14} className="queue-down" />
                      </button>
                      <button
                        type="button"
                        className="icon"
                        title="取消"
                        aria-label="取消"
                        onClick={() => void client.cancelRun(item.run.id).then(() => snapshot.refetch())}
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  ))}
                </div>
              </details>
            )}
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
            {attachments.length > 0 && (
              <div className="attachments">
                {attachments.map((attachment) => (
                  <button
                    type="button"
                    key={attachment.id}
                    title={`移除 ${attachment.name}`}
                    onClick={() =>
                      setAttachments((items) => items.filter((item) => item.id !== attachment.id))
                    }
                  >
                    {attachment.name} ×
                  </button>
                ))}
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
                    if (file)
                      void upload(file, file.name).catch((error) => window.alert(requestErrorMessage(error)));
                    event.currentTarget.value = "";
                  }}
                />
              </label>
              <textarea
                ref={promptRef}
                rows={1}
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                onPaste={(event) => {
                  const image = [...event.clipboardData.items]
                    .find((item) => item.kind === "file" && item.type.startsWith("image/"))
                    ?.getAsFile();
                  if (!image) return;
                  event.preventDefault();
                  void upload(image, `pasted-image-${Date.now()}.${image.type.split("/")[1] ?? "png"}`).catch(
                    (error) => window.alert(requestErrorMessage(error)),
                  );
                }}
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
                  disabled={(!prompt.trim() && attachments.length === 0) || !selected || offline}
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
              {inspectorSection === "xianyu" && <XianyuArea client={client} />}
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
                <BackgroundTaskArea
                  tasks={tasks.data ?? []}
                  disabled={offline}
                  create={(prompt) => {
                    if (!selected) return;
                    void client.createTask(prompt, selected).then(() => tasks.refetch());
                  }}
                  cancel={(id) => void client.cancelTask(id).then(() => tasks.refetch())}
                  remove={(id) => void client.deleteTask(id).then(() => tasks.refetch())}
                  openRun={(task) => {
                    setSelected(task.sessionId);
                    setInspectorSection("run");
                  }}
                />
              )}
              {inspectorSection === "settings" && (
                <MemoryArea
                  facts={memories.data ?? []}
                  disabled={offline}
                  reject={(id) => void client.reviewMemoryFact(id, "rejected").then(() => memories.refetch())}
                  accept={(id) => void client.reviewMemoryFact(id, "active").then(() => memories.refetch())}
                />
              )}
              {inspectorSection === "settings" && (
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
              {inspectorSection === "settings" && (
                <ResourceArea
                  admin={userRole === "admin"}
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
                    logout={signOut}
                    reloadConfig={() =>
                      void client.reloadConfig().then(() => queryClient.invalidateQueries())
                    }
                    publicConfig={publicConfig.data}
                    disabled={offline}
                    saveSession={async (patch) => {
                      await updateSession.mutateAsync(patch);
                    }}
                    uploadAvatar={async (file) =>
                      (await client.upload(file, file.name, selected, "avatar")).id
                    }
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
