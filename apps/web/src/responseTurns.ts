import type { Response, ResponseStatus, Run, TranscriptItem } from "@uma-agent/protocol";

export type ConversationEntry =
  | { kind: "message"; item: TranscriptItem }
  | {
      kind: "response";
      id: string;
      response: Response;
      run: Run | undefined;
      items: TranscriptItem[];
    };

function responseForItem(
  item: TranscriptItem,
  byMessageId: Map<string, Response>,
  byRunId: Map<string, Response>,
): Response | undefined {
  return byMessageId.get(item.id) ?? (item.runId ? byRunId.get(item.runId) : undefined);
}

export function buildConversationEntries(
  transcript: TranscriptItem[],
  responses: Response[],
  runs: Run[],
): ConversationEntry[] {
  const byMessageId = new Map(responses.map((response) => [response.messageId, response]));
  const byRunId = new Map(responses.map((response) => [response.runId, response]));
  const runsById = new Map(runs.map((run) => [run.id, run]));
  const itemsByRun = new Map<string, TranscriptItem[]>();
  for (const item of transcript) {
    if (!item.runId) continue;
    const items = itemsByRun.get(item.runId) ?? [];
    items.push(item);
    itemsByRun.set(item.runId, items);
  }

  const entries: ConversationEntry[] = [];
  const renderedSegments = new Set<string>();
  const appendResponseSegment = (response: Response, run: Run | undefined, segment: TranscriptItem[]) => {
    const firstUser = segment.find((item) => item.role === "user");
    const segmentId = `${response.id}:${firstUser?.id ?? segment[0]?.id ?? "empty"}`;
    if (renderedSegments.has(segmentId)) return;
    renderedSegments.add(segmentId);
    const hasLaterUser = (itemsByRun.get(response.runId) ?? []).some(
      (item) => item.role === "user" && item.sequence > (firstUser?.sequence ?? 0),
    );
    const status: ResponseStatus = hasLaterUser ? "clarifying" : response.status;
    entries.push({
      kind: "response",
      id: segmentId,
      response: status === response.status ? response : { ...response, status },
      run,
      items: segment,
    });
  };
  for (const item of transcript) {
    const response = responseForItem(item, byMessageId, byRunId);
    if (response) {
      if (item.role !== "user") continue;
      entries.push({ kind: "message", item });
      const runItems = itemsByRun.get(response.runId) ?? [];
      const segment = runItems.filter(
        (candidate) =>
          candidate.sequence >= item.sequence &&
          candidate.sequence <
            (runItems.find((next) => next.role === "user" && next.sequence > item.sequence)?.sequence ??
              Number.POSITIVE_INFINITY),
      );
      appendResponseSegment(response, runsById.get(response.runId), segment);
      continue;
    }
    entries.push({ kind: "message", item });
  }

  for (const response of responses) {
    const runItems = itemsByRun.get(response.runId) ?? [];
    if (!runItems.some((item) => item.role === "user"))
      appendResponseSegment(response, runsById.get(response.runId), runItems);
  }

  return entries;
}
