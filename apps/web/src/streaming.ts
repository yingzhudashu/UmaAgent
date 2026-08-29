import type { QueryClient } from "@tanstack/react-query";
import type {
  AgentEventEnvelope,
  Attachment,
  MessageDelta,
  Response,
  Run,
  SessionSnapshot,
  TranscriptItem,
} from "@uma-agent/protocol";

export function applyStreamingEvent(
  queryClient: QueryClient,
  sessionId: string,
  event: AgentEventEnvelope,
  activeBranchId?: string,
): void {
  if (event.type !== "message.delta") return;
  const payload = event.payload as MessageDelta;
  if (typeof payload.messageId !== "string" || typeof payload.append !== "string") return;
  queryClient.setQueryData<SessionSnapshot>(["snapshot", sessionId, activeBranchId], (current) => {
    if (!current) return current;
    return {
      ...current,
      transcript: current.transcript.map((item) =>
        item.id === payload.messageId
          ? { ...item, content: `${item.content}${payload.append}`, updatedAt: Date.now() }
          : item,
      ),
    };
  });
}

function updateSnapshot(
  queryClient: QueryClient,
  sessionId: string,
  activeBranchId: string | undefined,
  update: (current: SessionSnapshot) => SessionSnapshot,
): void {
  queryClient.setQueryData<SessionSnapshot>(["snapshot", sessionId, activeBranchId], (current) =>
    current ? update(current) : current,
  );
}

function mergeTranscriptItem(items: TranscriptItem[], item: TranscriptItem): TranscriptItem[] {
  const existing = items.find((value) => value.id === item.id);
  if (existing) return items.map((value) => (value.id === item.id ? { ...value, ...item } : value));
  return [...items, item].sort((left, right) => left.sequence - right.sequence);
}

function updateTranscriptSummary(
  items: TranscriptItem[],
  payload: Record<string, unknown>,
): TranscriptItem[] {
  const messageId = typeof payload.messageId === "string" ? payload.messageId : undefined;
  if (!messageId) return items;
  return items.map((item) =>
    item.id === messageId
      ? {
          ...item,
          ...(typeof payload.status === "string"
            ? { status: payload.status as TranscriptItem["status"] }
            : {}),
          ...(typeof payload.updatedAt === "number" ? { updatedAt: payload.updatedAt } : {}),
        }
      : item,
  );
}

function mergeRun(runs: Run[], run: Run): Run[] {
  const next = runs.some((value) => value.id === run.id)
    ? runs.map((value) => (value.id === run.id ? run : value))
    : [...runs, run];
  return next.sort((left, right) => left.createdAt - right.createdAt).slice(-20);
}

function mergeResponse(responses: Response[], response: Response): Response[] {
  const current = responses.find((value) => value.runId === response.runId);
  if (current && current.updatedAt > response.updatedAt) return responses;
  const merged: Response = current
    ? {
        ...response,
        activities: [
          ...new Map([...current.activities, ...response.activities].map((item) => [item.id, item])).values(),
        ].sort((left, right) => left.createdAt - right.createdAt),
        attachments: [
          ...new Map(
            [...current.attachments, ...response.attachments].map((item) => [item.id, item]),
          ).values(),
        ],
      }
    : response;
  const next = current
    ? responses.map((value) => (value.runId === response.runId ? merged : value))
    : [...responses, response];
  return next.sort((left, right) => left.createdAt - right.createdAt);
}

function mergeResponseLists(current: Response[], incoming: Response[]): Response[] {
  const byRunId = new Map<string, Response>();
  for (const response of [...current, ...incoming]) {
    const previous = byRunId.get(response.runId);
    if (!previous || response.updatedAt >= previous.updatedAt) {
      byRunId.set(response.runId, previous ? (mergeResponse([previous], response)[0] ?? response) : response);
    }
  }
  return [...byRunId.values()].sort((left, right) => left.createdAt - right.createdAt);
}

export function mergeSessionSnapshot(
  current: SessionSnapshot | undefined,
  incoming: SessionSnapshot,
): SessionSnapshot {
  if (!current || incoming.snapshotSequence < current.snapshotSequence) return current ?? incoming;
  const transcript = new Map(current.transcript.map((item) => [item.id, item]));
  for (const item of incoming.transcript) {
    const previous = transcript.get(item.id);
    transcript.set(
      item.id,
      previous?.status === "streaming" && previous.content.length > item.content.length ? previous : item,
    );
  }
  const recentRuns = new Map(current.recentRuns.map((run) => [run.id, run]));
  for (const run of incoming.recentRuns) {
    const previous = recentRuns.get(run.id);
    if (!previous || run.updatedAt >= previous.updatedAt) recentRuns.set(run.id, run);
  }
  return {
    ...incoming,
    transcript: [...transcript.values()].sort((left, right) => left.sequence - right.sequence),
    recentRuns: [...recentRuns.values()].sort((left, right) => left.createdAt - right.createdAt),
    responses: mergeResponseLists(current.responses ?? [], incoming.responses ?? []),
  };
}

/** Applies durable run events locally so a streaming response is not rebuilt by refetch races. */
export function applyDurableEvent(
  queryClient: QueryClient,
  sessionId: string,
  event: AgentEventEnvelope,
  activeBranchId?: string,
): void {
  if (event.type === "session.snapshot") return;
  updateSnapshot(queryClient, sessionId, activeBranchId, (current) => {
    const next = { ...current, snapshotSequence: Math.max(current.snapshotSequence, event.sequence) };
    switch (event.type) {
      case "message.started":
        return {
          ...next,
          transcript: mergeTranscriptItem(current.transcript, event.payload as TranscriptItem),
        };
      case "message.completed": {
        const payload = event.payload as unknown;
        return {
          ...next,
          transcript:
            payload && typeof payload === "object" && "id" in payload
              ? mergeTranscriptItem(current.transcript, payload as TranscriptItem)
              : updateTranscriptSummary(current.transcript, (payload ?? {}) as Record<string, unknown>),
        };
      }
      case "tool.started": {
        const payload = event.payload as { item?: TranscriptItem };
        return payload.item
          ? { ...next, transcript: mergeTranscriptItem(current.transcript, payload.item) }
          : next;
      }
      case "tool.completed": {
        const payload = event.payload as { item?: TranscriptItem } & Record<string, unknown>;
        return {
          ...next,
          transcript: payload.item
            ? mergeTranscriptItem(current.transcript, payload.item)
            : updateTranscriptSummary(current.transcript, payload),
        };
      }
      case "run.updated":
        return { ...next, recentRuns: mergeRun(current.recentRuns, event.payload as Run) };
      case "response.started":
      case "response.updated":
      case "response.completed":
        return { ...next, responses: mergeResponse(current.responses ?? [], event.payload as Response) };
      case "response.activity": {
        const payload = event.payload as { responseId?: string; activity?: Response["activities"][number] };
        const activity = payload.activity;
        if (!payload.responseId || !activity) return next;
        return {
          ...next,
          responses: (current.responses ?? []).map((response) =>
            response.id !== payload.responseId
              ? response
              : {
                  ...response,
                  activities: [
                    ...response.activities.filter((item) => item.id !== activity.id),
                    activity,
                  ].sort((left, right) => left.createdAt - right.createdAt),
                  updatedAt: Math.max(response.updatedAt, activity.createdAt),
                },
          ),
        };
      }
      case "response.attachment.updated": {
        const payload = event.payload as { responseId?: string; attachment?: Attachment };
        if (!payload.responseId || !payload.attachment) return next;
        return {
          ...next,
          responses: (current.responses ?? []).map((response) =>
            response.id !== payload.responseId
              ? response
              : {
                  ...response,
                  attachments: [
                    ...response.attachments.filter((item) => item.id !== payload.attachment?.id),
                    payload.attachment as Attachment,
                  ],
                },
          ),
        };
      }
      case "plan.updated": {
        const runId = event.runId;
        if (!runId) return next;
        return {
          ...next,
          recentRuns: current.recentRuns.map((run) =>
            run.id === runId ? { ...run, plan: event.payload as Run["plan"] } : run,
          ),
        };
      }
      default:
        return next;
    }
  });
}
