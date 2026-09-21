import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  type EventConnectionState,
  type MaintenanceStatus,
  type UmaClient,
  UmaClientError,
} from "@uma-agent/client";
import type { Approval, Session, SessionSnapshot, TranscriptItem } from "@uma-agent/protocol";
import { ArrowDown, Bot } from "lucide-react";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApprovalBar, RunPanel } from "./areas/RunArea.js";
import { SessionArea } from "./areas/SessionArea.js";
import {
  BackgroundTaskArea,
  DiagnosticsArea,
  EvaluationArea,
  MemoryArea,
  OptimizationArea,
  ResourceArea,
  ScheduleArea,
  XianyuWorkspace,
} from "./areas/WorkspaceAreas.js";
import {
  cacheCursor,
  cachedHistory,
  cachedSessions,
  cachedSnapshot,
  cacheHistory,
  cacheSessions,
  cacheSnapshot,
  clearCacheNamespace,
  setCacheNamespace,
} from "./cache.js";
import { AppearanceSettings } from "./components/AppearanceSettings.js";
import { CommandPaletteHost } from "./components/CommandPalette.js";
import { ConfirmDialog } from "./components/ConfirmDialog.js";
import { ConversationComposer } from "./components/ConversationComposer.js";
import { ConversationHeader } from "./components/ConversationHeader.js";
import { InspectorContent } from "./components/InspectorContent.js";
import { InspectorDrawer, type InspectorSection } from "./components/InspectorDrawer.js";
import { ApprovalPanel, ConnectionPanel, SyncPanel } from "./components/InspectorStatusPanels.js";
import { MessageBubble } from "./components/MessageBubble.js";
import { type Destination, destinations, ProjectNavigation } from "./components/ProjectNavigation.js";
import { QualityNavigation } from "./components/QualityNavigation.js";
import { QueueDock } from "./components/QueueDock.js";
import { RenameSessionDialog } from "./components/RenameSessionDialog.js";
import { ResponseCard } from "./components/ResponseCard.js";
import { SessionSettingsPanel } from "./components/SessionSettingsPanel.js";
import { UnsavedChanges, useLeaveConfirmation } from "./components/UnsavedChanges.js";
import { Login } from "./Login.js";
import { type QualityOperation, useQualityHistory } from "./quality-history.js";
import { requestErrorMessage } from "./request-error.js";
import { buildConversationEntries } from "./responseTurns.js";
import { applyDurableEvent, applyStreamingEvent, mergeSessionSnapshot } from "./streaming.js";
import { useConversationDrafts } from "./useConversationDrafts.js";

type SettingsArea =
  | "session"
  | "tasks"
  | "memory"
  | "schedules"
  | "resources"
  | "admin"
  | "sessions"
  | "xianyu";

interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

export interface AppProps {
  client: UmaClient;
  embedded?: boolean;
  theme?: "light" | "dark";
}

export function App(props: AppProps) {
  return (
    <UnsavedChanges>
      <AppContent {...props} />
    </UnsavedChanges>
  );
}
function AppContent({ client, embedded = false, theme = "light" }: AppProps) {
  const leave = useLeaveConfirmation();
  const closeInspector = useCallback(
    () =>
      leave(() => {
        setDestination("sessions");
        setInspectorSection(undefined);
      }),
    [leave],
  );
  const queryClient = useQueryClient();
  const [qualityTab, setQualityTab] = useState("diagnostics");
  const [diagnosticDays, setDiagnosticDays] = useState(1);
  const [renameTitle, setRenameTitle] = useState<string>();
  const [globalError, setGlobalError] = useState("");
  const [profileDraft, setProfileDraft] = useState<string>();
  const [destination, setDestination] = useState<Destination>("sessions");
  const [appearance, setAppearance] = useState<"light" | "dark" | "system">(() => {
    const saved = localStorage.getItem("UmaAgent.appearance");
    return saved === "light" || saved === "dark" ? saved : "system";
  });
  const effectiveTheme = appearance === "system" ? theme : appearance;

  const [selected, setSelected] = useState<string>();
  const pendingCreatedSessions = useRef(new Map<string, Session>());
  const [createSessionError, setCreateSessionError] = useState<string>();
  const {
    draft,
    prompt,
    attachments,
    interactionMode,
    setPrompt,
    setInteractionMode,
    setAttachments,
    sendMessage,
    submit: sendDraft,
    upload: uploadDraft,
    clear: clearDrafts,
    uploading,
    authGeneration,
  } = useConversationDrafts(client, selected);
  const [loginRequired, setLoginRequired] = useState<boolean>();
  const [userRole, setUserRole] = useState<"admin" | "user">("user");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [inspectorSection, setInspectorSection] = useState<InspectorSection>();
  const [settingsArea, setSettingsArea] = useState<SettingsArea>("session");
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [browserOnline, setBrowserOnline] = useState(() => navigator.onLine);
  const [cacheUnavailable, setCacheUnavailable] = useState(false);
  const cacheFailed = useCallback(() => setCacheUnavailable(true), []);
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
  const [deleteSessionPending, setDeleteSessionPending] = useState<string>();
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
    queryFn: async ({ signal }) => {
      try {
        const bootstrap = await client.syncBootstrap();
        signal.throwIfAborted();
        setUserRole(bootstrap.user.role);
        setCacheNamespace(bootstrap.user.id, client.serverOrigin);
        const confirmed = bootstrap.sessions.map((item) => item.session);
        for (const session of confirmed) pendingCreatedSessions.current.delete(session.id);
        const values = [...pendingCreatedSessions.current.values(), ...confirmed];
        await cacheSessions(values).catch(cacheFailed);
        return values;
      } catch (error) {
        signal.throwIfAborted();
        if (error instanceof UmaClientError && error.status === 401) throw error;
        const cached = await cachedSessions().catch(() => undefined);
        if (cached)
          return [
            ...pendingCreatedSessions.current.values(),
            ...cached.filter((session) => !pendingCreatedSessions.current.has(session.id)),
          ];
        throw error;
      }
    },
  });
  const authenticated = loginRequired === false;
  // 设置按当前区域查询；命令直接交 Core 执行，不提前读取所有管理资源。
  const areaEnabled = (area: SettingsArea) =>
    authenticated && inspectorSection === "settings" && settingsArea === area;
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
    enabled: areaEnabled("tasks"),
  });
  const schedules = useQuery({
    queryKey: ["schedules"],
    queryFn: () => client.listSchedules(),
    enabled: areaEnabled("schedules"),
  });
  const report = useQuery({
    queryKey: ["operations-report"],
    queryFn: () => client.operationsReport(),
    enabled: areaEnabled("session") && userRole === "admin",
  });
  const diagnostics = useQuery({
    queryKey: ["diagnostics", diagnosticDays],
    queryFn: () => {
      const to = Date.now();
      return client.diagnosticsReport(to - diagnosticDays * 86_400_000, to);
    },
    enabled: areaEnabled("admin") && userRole === "admin" && qualityTab === "diagnostics",
  });
  const evaluations = useQuery({
    queryKey: ["evaluations"],
    queryFn: () => client.listEvaluationReports(),
    enabled: areaEnabled("admin") && userRole === "admin" && qualityTab === "evaluations",
  });
  const evaluationTrends = useQuery({
    queryKey: ["evaluation-trends"],
    queryFn: () => client.listEvaluationTrends(Date.now() - 30 * 86_400_000, Date.now(), "day"),
    enabled: areaEnabled("admin") && userRole === "admin" && qualityTab === "evaluations",
  });
  const optimization = useQuery({
    queryKey: ["optimization"],
    queryFn: () => client.listOptimizationProposals(),
    enabled: areaEnabled("admin") && userRole === "admin" && qualityTab === "optimization",
  });
  const publicConfig = useQuery({
    queryKey: ["config"],
    queryFn: () => client.publicConfig(),
    enabled: areaEnabled("session") && userRole === "admin",
  });
  const memories = useQuery({
    queryKey: ["memory", "candidate"],
    queryFn: () => client.listMemoryFacts("candidate"),
    enabled: areaEnabled("memory"),
  });
  const skills = useQuery({
    queryKey: ["skills"],
    queryFn: () => client.skillState(),
    enabled: areaEnabled("resources") && userRole === "admin",
  });
  const profile = useQuery({
    queryKey: ["profile"],
    queryFn: () => client.getAgentProfile(),
    enabled: areaEnabled("session"),
  });
  const mcp = useQuery({
    queryKey: ["mcp"],
    queryFn: () => client.mcpStatus(),
    enabled: areaEnabled("resources") && userRole === "admin",
  });
  const knowledge = useQuery({
    queryKey: ["knowledge"],
    queryFn: () => client.listKnowledge(),
    enabled: areaEnabled("resources"),
  });
  const selectedSession = sessions.data?.find((item) => item.id === selected);
  const activeBranchId = selectedSession?.activeBranchId;
  const snapshot = useQuery({
    queryKey: ["snapshot", selected, activeBranchId],
    queryFn: async () => {
      const sessionId = selected as string;
      try {
        const received = await client.getSession(sessionId);
        await cacheSnapshot(received).catch(cacheFailed);
        // HTTP 快照可能晚于 WebSocket 增量返回；与重连快照使用相同游标规则，
        // 避免旧请求把已经显示的工具步骤或回复覆盖为空。
        return mergeSessionSnapshot(
          queryClient.getQueryData<SessionSnapshot>(["snapshot", sessionId, activeBranchId]),
          received,
        );
      } catch (error) {
        if (error instanceof UmaClientError && error.status === 401) throw error;
        const cached = await cachedSnapshot(sessionId, activeBranchId).catch(() => undefined);
        if (cached)
          return mergeSessionSnapshot(
            queryClient.getQueryData<SessionSnapshot>(["snapshot", sessionId, activeBranchId]),
            cached,
          );
        throw error;
      }
    },
    enabled: Boolean(selected && selected !== "undefined") && authenticated,
    refetchInterval: false,
  });
  const queue = useQuery({
    queryKey: ["queue", selected],
    queryFn: () => client.listQueue(selected as string),
    enabled: Boolean(selected && selected !== "undefined") && authenticated,
    refetchInterval: false,
  });
  useQualityHistory(client, snapshot.data?.transcript, Boolean(authenticated), selected, mergeQualityHistory);
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
      pendingCreatedSessions.current.clear();
      setLoginRequired(true);
      void clearCacheNamespace();
      client.close();
    }
    if (sessions.isSuccess) setLoginRequired(false);
    if (sessions.isError && loginRequired === undefined) setLoginRequired(true);
    if (sessions.isSuccess) {
      const available = sessions.data ?? [];
      // A list refresh may lag behind a successful create response. It must not
      // undo explicit selection; deletion handles selection in its own callback.
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
  const snapshotReady = Boolean(snapshot.data);
  useEffect(() => {
    if (!selected || selected === "undefined" || !snapshotReady) return;
    let unsubscribe: (() => void) | undefined;
    let cancelled = false;
    void cachedHistory(selected, activeBranchId)
      .catch(() => undefined)
      .then((cached) => {
        if (cancelled) return;
        setHistorical(cached ?? []);
        setHistoryHasMore(undefined);
        unsubscribe = client.subscribeSessions(
          // 只有快照落入该分支的缓存后才订阅；提前消费事件会让无投影的增量静默丢失。
          [
            {
              id: selected,
              lastSequence:
                queryClient.getQueryData<SessionSnapshot>(["snapshot", selected, activeBranchId])
                  ?.snapshotSequence ?? 0,
            },
          ],
          (event) => {
            const transient = event.type === "message.delta" && "transient" in event && event.transient;
            const durableSequence =
              event.type === "session.snapshot"
                ? (event.payload as SessionSnapshot).snapshotSequence
                : event.sequence;
            if (!transient) {
              void cacheCursor(selected, durableSequence).catch(cacheFailed);
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
            if (event.type === "session.snapshot") {
              const value = event.payload as SessionSnapshot;
              const key = ["snapshot", selected, value.session.activeBranchId] as const;
              const merged = mergeSessionSnapshot(queryClient.getQueryData<SessionSnapshot>(key), value);
              queryClient.setQueryData(key, merged);
              void cacheSnapshot(merged).catch(cacheFailed);
              queryClient.setQueryData(["queue", selected], value.queue);
            } else if (event.type === "message.delta") {
              applyStreamingEvent(queryClient, selected, event, activeBranchId);
            } else if (event.type === "queue.updated") {
              void queryClient.invalidateQueries({ queryKey: ["queue", selected] });
            } else {
              applyDurableEvent(queryClient, selected, event, activeBranchId);
              if (
                event.type === "response.completed" ||
                (event.type === "run.updated" &&
                  ["completed", "failed", "cancelled", "interrupted"].includes(
                    String((event.payload as { status?: string }).status),
                  ))
              ) {
                const completed = queryClient.getQueryData<SessionSnapshot>([
                  "snapshot",
                  selected,
                  activeBranchId,
                ]);
                if (completed) void cacheSnapshot(completed).catch(cacheFailed);
              }
              if (event.type === "run.updated")
                void queryClient.invalidateQueries({ queryKey: ["queue", selected] });
            }
            if (event.type !== "message.delta" && event.type !== "queue.updated")
              void queryClient.invalidateQueries({ queryKey: ["sessions"] });
          },
        );
      });
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [selected, activeBranchId, queryClient, client, snapshotReady, cacheFailed]);
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
    mutationFn: async () => {
      const generation = authGeneration.current;
      return { session: await client.createSession(), generation };
    },
    onMutate: () => {
      setCreateSessionError(undefined);
    },
    onSuccess: async ({ session, generation }) => {
      if (generation !== authGeneration.current) return;
      await queryClient.cancelQueries({ queryKey: ["sessions"] });
      if (generation !== authGeneration.current) return;
      pendingCreatedSessions.current.set(session.id, session);
      queryClient.setQueryData<Session[]>(["sessions"], (current = []) => [
        session,
        ...current.filter((item) => item.id !== session.id),
      ]);
      setSelected(session.id);
      setDestination("sessions");
      setInspectorSection(undefined);
      setSidebarOpen(false);
      setHistorical([]);
      setHistoryHasMore(undefined);
      setSyncCursor(undefined);
      setLastSyncAt(undefined);
      requestAnimationFrame(() => promptRef.current?.focus());
    },
    onError: (error) => {
      setCreateSessionError(requestErrorMessage(error));
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
    onSuccess: (_, id) => {
      pendingCreatedSessions.current.delete(id);
      queryClient.setQueryData<Session[]>(["sessions"], (current = []) =>
        current.filter((session) => session.id !== id),
      );
      setSelected((current) => (current === id ? undefined : current));
      void queryClient.invalidateQueries({ queryKey: ["sessions"] });
    },
  });
  const recentRuns = snapshot.data?.recentRuns ?? [];
  const runningRun = [...recentRuns]
    .reverse()
    .find((run) => ["preflight", "running", "verifying"].includes(run.status));
  const currentRun =
    runningRun ??
    [...recentRuns]
      .reverse()
      .find(
        (run) => !["completed", "failed", "cancelled", "interrupted", "awaiting_input"].includes(run.status),
      ) ??
    recentRuns.at(-1);
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
  const Workspace = embedded ? "div" : "main";
  // Keep the standard agent workspace as the default for every role. The
  // administrator can explicitly open 咸鱼工作台 from the project navigation.
  const upload = async (file: Blob, name = "pasted-image.png") => {
    if (!offline) await uploadDraft(file, name);
  };
  const submit = () => {
    if (!offline && !createSession.isPending) sendDraft();
  };
  const resolveApproval = async (approval: Approval, approved: boolean) => {
    await client.resolveApproval(approval.id, approved);
    setApprovals((items) => items.filter((item) => item.id !== approval.id));
  };
  const renameSession = () => {
    const current = snapshot.data?.session;
    if (!current) return;
    setRenameTitle(current.title);
  };
  const removeSession = () => {
    if (selected && !deleteSession.isPending) setDeleteSessionPending(selected);
  };
  const confirmDeleteSession = () => {
    if (!deleteSessionPending) return;
    deleteSession.mutate(deleteSessionPending, { onSettled: () => setDeleteSessionPending(undefined) });
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
      .then(() => queryClient.invalidateQueries({ queryKey: ["queue", selected] }));
  };
  const retryMessage = (item: TranscriptItem) => {
    if (item.role !== "user" || !selected) return;
    const mode = snapshot.data?.recentRuns.find((run) => run.id === item.runId)?.interactionMode;
    if (!mode) return;
    const ids = item.attachments.map((attachment) => attachment.id);
    void client
      .sendMessage(selected, item.content, { mode, ...(ids.length ? { attachmentIds: ids } : {}) })
      .then(() => queryClient.invalidateQueries({ queryKey: ["queue", selected] }));
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
    clearDrafts();
    pendingCreatedSessions.current.clear();
    const logout = client.logout();
    setLoginRequired(true);
    setSelected(undefined);
    setProfileDraft(undefined);
    setQualityOperations({});
    setCommandOpen(false);
    setLastSyncAt(undefined);
    setSyncCursor(undefined);
    setApprovals([]);
    setHistorical([]);
    setHistoryHasMore(undefined);
    setInspectorSection(undefined);
    setSettingsArea("session");
    setSidebarOpen(false);
    setUserRole("user");
    setDestination("sessions");
    void queryClient.cancelQueries();
    queryClient.clear();
    void clearCacheNamespace();
    void logout.catch(() => undefined);
  };
  const navigate = (next: Destination) =>
    leave(() => {
      setDestination(next);
      setSidebarOpen(false);
      if (next === "sessions") {
        setInspectorSection(undefined);
        return;
      }

      setSettingsArea(next);
      setInspectorSection("settings");
    });
  const qualityQueries =
    qualityTab === "diagnostics"
      ? [diagnostics]
      : qualityTab === "evaluations"
        ? [evaluations, evaluationTrends]
        : [optimization];
  const managementQueries =
    inspectorSection === "settings"
      ? {
          tasks: [tasks],
          schedules: [schedules],
          memory: [memories],
          resources: [knowledge],
          admin: qualityQueries,
          session: [],
          sessions: [],
          xianyu: [],
        }[settingsArea]
      : [];
  if (loginRequired === undefined)
    return (
      <div
        data-design-shell="UmaAgent"
        className={`uma-embed uma-embed--${embedded ? "embedded" : "standalone"} theme-${effectiveTheme}`}
      >
        <output className="login-shell">正在连接 UmaAgent Core…</output>
      </div>
    );
  if (loginRequired)
    return (
      <div
        data-design-shell="UmaAgent"
        className={`uma-embed uma-embed--${embedded ? "embedded" : "standalone"} theme-${effectiveTheme}`}
      >
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
    <div
      data-design-shell="UmaAgent"
      className={`uma-embed uma-embed--${embedded ? "embedded" : "standalone"} theme-${effectiveTheme}`}
    >
      <div className={`app-shell design-shell ${destination !== "sessions" ? "is-management" : ""}`}>
        {maintenance.data?.maintenance && (
          <output className="maintenance-banner">
            {maintenance.data.message ?? "系统正在停服更新，请稍候。"}
          </output>
        )}
        <SessionArea
          navigation={
            <ProjectNavigation
              current={destination}
              admin={userRole === "admin"}
              navigate={navigate}
              status={{
                online: !offline,
                busy: Boolean(busy),
                approvals: approvals.filter((approval) => approval.sessionId === selected).length,
                open: inspectorSection,
                onOpen: (section) =>
                  leave(() => {
                    setDestination("sessions");
                    setSidebarOpen(false);
                    if (section === "settings") setSettingsArea("session");
                    setInspectorSection((current) =>
                      destination === "sessions" && current === section ? undefined : section,
                    );
                  }),
              }}
            />
          }
          showSessions={destination === "sessions"}
          sessions={sessions.data ?? []}
          selected={selected}
          open={sidebarOpen}
          disabled={browserOffline}
          creating={createSession.isPending}
          {...(createSessionError ? { createError: createSessionError } : {})}
          health={health.data}
          installable={Boolean(installPrompt)}
          create={() =>
            leave(() => {
              navigate("sessions");
              createSession.mutate();
            })
          }
          retryCreate={() => createSession.mutate()}
          select={(id) =>
            leave(() => {
              navigate("sessions");
              setSelected(id);
              setSidebarOpen(false);
            })
          }
          close={() => setSidebarOpen(false)}
          install={() => {
            void installPrompt?.prompt().then(() => setInstallPrompt(undefined));
          }}
        />
        <Workspace className="workspace" hidden={destination !== "sessions"}>
          <ConversationHeader
            session={snapshot.data?.session ?? selectedSession}
            models={models.data ?? []}
            disabled={!selected || offline || createSession.isPending || sendMessage.isPending || uploading}
            openNavigation={() => setSidebarOpen(true)}
            openCommands={() => setCommandOpen(true)}
            update={(patch) => updateSession.mutate(patch)}
            rename={renameSession}
            remove={removeSession}
            refresh={() => void snapshot.refetch()}
            compact={async () => {
              if (!selected) return;
              try {
                await client.compactSession(selected);
                await snapshot.refetch();
              } catch (error) {
                setGlobalError(error instanceof Error ? error.message : "压缩上下文失败，请稍后重试");
              }
            }}
          />
          <section
            ref={transcriptRef}
            className="transcript"
            onScroll={onTranscriptScroll}
            aria-label="会话消息"
          >
            {snapshot.isError && (
              <div role="alert" className="composer-error">
                <span>会话内容读取失败，请重试。</span>
                <button type="button" onClick={() => void snapshot.refetch()}>
                  重新读取会话
                </button>
              </div>
            )}
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
                    void cacheHistory(selected, unique, activeBranchId).catch(cacheFailed);
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
          <div className="composer-wrap">
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
            <QueueDock
              running={runningRun}
              {...(runningRun
                ? { runningMessage: transcript.find((item) => item.id === runningRun.messageId) }
                : {})}
              queue={queue.data ?? []}
              disabled={offline}
              reorder={async (runIds) => {
                if (!selected) return;
                await client.reorderQueue(
                  selected,
                  runIds,
                  queue.data?.[0]?.queueRevision ?? snapshot.data?.session.queueRevision ?? 1,
                );
                await queue.refetch();
              }}
              prioritize={async (runId) => {
                await client.prioritizeRun(runId);
                await queue.refetch();
              }}
              cancel={async (runId) => {
                await client.cancelRun(runId);
                await queue.refetch();
              }}
              edit={async (item, text) => {
                await client.editMessage(item.message.id, text);
                await queue.refetch();
              }}
            />
            {connectionMessage && <p className="connection-notice">{connectionMessage}</p>}
            {cacheUnavailable && (
              <output className="connection-notice">浏览器无法保存离线缓存，当前页面可继续使用。</output>
            )}
            {sendMessage.isError && sendMessage.variables?.sessionId === selected && (
              <div className="composer-error" role="alert">
                <span>{requestErrorMessage(sendMessage.error)}</span>
                <button type="button" className="text-action" onClick={() => void snapshot.refetch()}>
                  核对会话记录
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
            <ConversationComposer
              attachments={attachments}
              removeAttachment={(id) => setAttachments((items) => items.filter((item) => item.id !== id))}
              interactionMode={interactionMode}
              changeMode={setInteractionMode}
              prompt={prompt}
              changePrompt={setPrompt}
              promptRef={promptRef}
              hasSession={Boolean(selected)}
              readOnly={Boolean(draft.pending)}
              busy={Boolean(busy)}
              disabled={!selected || offline || createSession.isPending || sendMessage.isPending || uploading}
              submit={submit}
              cancel={() => selected && void client.cancel(selected)}
              upload={(file, name) =>
                void upload(file, name).catch((error) => setGlobalError(requestErrorMessage(error)))
              }
            />
          </div>
        </Workspace>
        {deleteSessionPending && (
          <ConfirmDialog
            title="删除会话？"
            busy={deleteSession.isPending}
            danger
            cancel={() => setDeleteSessionPending(undefined)}
            confirm={confirmDeleteSession}
          >
            会话及全部记录将被删除，此操作不可恢复。
          </ConfirmDialog>
        )}
        {renameTitle !== undefined && (
          <RenameSessionDialog
            title={renameTitle}
            original={selectedSession?.title ?? ""}
            change={setRenameTitle}
            busy={updateSession.isPending}
            failed={updateSession.isError}
            close={() => setRenameTitle(undefined)}
            save={() => {
              if (renameTitle.trim())
                updateSession.mutate(
                  { title: renameTitle.trim() },
                  { onSuccess: () => setRenameTitle(undefined) },
                );
            }}
          />
        )}
        {globalError && (
          <div className="composer-error" role="alert">
            {globalError}
            <button type="button" onClick={() => setGlobalError("")}>
              关闭
            </button>
          </div>
        )}
        <CommandPaletteHost
          open={commandOpen}
          onOpen={() => setCommandOpen(true)}
          client={client}
          sessionId={selected}
          onClose={() => setCommandOpen(false)}
        />
        {inspectorSection && (
          <InspectorDrawer
            inline={destination !== "sessions"}
            title={destination !== "sessions" ? destinations[destination].label : undefined}
            description={destination !== "sessions" ? destinations[destination].description : undefined}
            screen={destination !== "sessions" ? destinations[destination].screen : undefined}
            openNavigation={() => setSidebarOpen(true)}
            section={inspectorSection}
            onClose={closeInspector}
          >
            <Suspense fallback={<output>正在加载管理区域…</output>}>
              <InspectorContent>
                {managementQueries.some((q) => q.isLoading) && <output>正在读取页面数据…</output>}
                {managementQueries
                  .filter((q) => q.isError)
                  .map((q) => (
                    <p key={q.errorUpdatedAt} role="alert" className="error">
                      {q.error instanceof Error ? q.error.message : "数据读取失败"}
                      <button type="button" onClick={() => void q.refetch()}>
                        重新读取
                      </button>
                    </p>
                  ))}
                {destination === "xianyu" && userRole === "admin" && (
                  <XianyuWorkspace client={client} embedded onSwitchAccount={signOut} />
                )}
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
                    client={client}
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
                {inspectorSection === "settings" && settingsArea === "tasks" && (
                  <BackgroundTaskArea
                    tasks={tasks.data ?? []}
                    disabled={offline}
                    create={(prompt) => {
                      if (!selected) throw new Error("请先创建或选择会话");
                      return client.createTask(prompt, selected).then(() => tasks.refetch());
                    }}
                    cancel={(id) => client.cancelTask(id).then(() => tasks.refetch())}
                    remove={(id) => client.deleteTask(id).then(() => tasks.refetch())}
                    openRun={(task) =>
                      leave(() => {
                        setDestination("sessions");
                        setSelected(task.sessionId);
                        setInspectorSection("run");
                      })
                    }
                  />
                )}
                {inspectorSection === "settings" && settingsArea === "memory" && (
                  <MemoryArea
                    facts={memories.data ?? []}
                    disabled={offline}
                    reject={(id) => client.reviewMemoryFact(id, "rejected").then(() => memories.refetch())}
                    accept={(id) => client.reviewMemoryFact(id, "active").then(() => memories.refetch())}
                  />
                )}
                {inspectorSection === "settings" && settingsArea === "schedules" && (
                  <ScheduleArea
                    schedules={schedules.data ?? []}
                    disabled={offline}
                    create={(input) => client.createSchedule(input).then(() => schedules.refetch())}
                    toggle={(id, enabled) =>
                      client.updateSchedule(id, { enabled }).then(() => schedules.refetch())
                    }
                    run={(id) => client.runSchedule(id).then(() => schedules.refetch())}
                    remove={(id) => client.deleteSchedule(id).then(() => schedules.refetch())}
                    loadRuns={(id) => client.listScheduleRuns(id)}
                    cancelRun={(id) => client.cancelScheduleRun(id).then(() => schedules.refetch())}
                  />
                )}
                {inspectorSection === "settings" && settingsArea === "resources" && (
                  <ResourceArea
                    admin={userRole === "admin"}
                    packages={skills.data?.packages ?? []}
                    mcp={mcp.data ?? []}
                    knowledge={knowledge.data ?? []}
                    disabled={offline}
                    refreshSkills={() => client.refreshSkills().then(() => skills.refetch())}
                    installSkill={(reference) =>
                      client.installSkill({ source: "local", reference }).then(() => skills.refetch())
                    }
                    setSkillStatus={(id, action) =>
                      client.setSkillStatus(id, action).then(() => skills.refetch())
                    }
                    addKnowledgePath={(name, path) =>
                      client.indexKnowledge(name, path).then(() => knowledge.refetch())
                    }
                    uploadKnowledge={(file) =>
                      client
                        .upload(file, file.name, selected)
                        .then((attachment) => {
                          if (!selected) throw new Error("Select a session before uploading knowledge");
                          return client.indexKnowledgeAttachment(file.name, attachment.id, selected);
                        })
                        .then(() => knowledge.refetch())
                    }
                    deleteKnowledge={(id) => client.deleteKnowledge(id).then(() => knowledge.refetch())}
                    reindexKnowledge={(id) => client.reindexKnowledge(id).then(() => knowledge.refetch())}
                    searchKnowledge={(query, sourceId) => client.searchKnowledge(query, sourceId)}
                  />
                )}
                {inspectorSection === "settings" && settingsArea === "admin" && userRole === "admin" && (
                  <section className="inspector-group">
                    <QualityNavigation
                      tab={qualityTab}
                      changeTab={setQualityTab}
                      days={diagnosticDays}
                      changeDays={setDiagnosticDays}
                      pending={offline || qualityQueries.some((query) => query.isFetching)}
                      refresh={() => {
                        for (const query of qualityQueries) void query.refetch();
                      }}
                    />
                    {qualityTab === "evaluations" && (
                      <EvaluationArea reports={evaluations.data ?? []} trends={evaluationTrends.data ?? []} />
                    )}
                    {qualityTab === "diagnostics" && <DiagnosticsArea report={diagnostics.data} />}
                    {qualityTab === "optimization" && (
                      <OptimizationArea
                        proposals={optimization.data ?? []}
                        disabled={offline}
                        generate={() =>
                          client.generateOptimizationProposals().then(() => optimization.refetch())
                        }
                        decide={(id, status) =>
                          client.decideOptimizationProposal(id, status).then(() => optimization.refetch())
                        }
                      />
                    )}
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
                {inspectorSection === "settings" && settingsArea === "session" && (
                  <section className="inspector-group">
                    {destination !== "sessions" && (
                      <AppearanceSettings
                        value={appearance}
                        change={(value) => {
                          setAppearance(value);
                          localStorage.setItem("UmaAgent.appearance", value);
                        }}
                      />
                    )}
                    <SessionSettingsPanel
                      client={client}
                      scope={destination === "sessions" ? "session" : "account"}
                      session={snapshot.data?.session}
                      health={health.data}
                      installAvailable={Boolean(installPrompt)}
                      install={() => void installPrompt?.prompt()}
                      report={report.data}
                      profile={profile.data}
                      draft={profileDraft}
                      changeDraft={setProfileDraft}
                      saveProfile={async (content) => {
                        const saved = await client.updateAgentProfile(content);
                        queryClient.setQueryData(["profile"], saved);
                        setProfileDraft(undefined);
                      }}
                      logout={() => leave(signOut)}
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
            </Suspense>
          </InspectorDrawer>
        )}
      </div>
    </div>
  );
}
