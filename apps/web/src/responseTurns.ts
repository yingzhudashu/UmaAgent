import type { Response, Run, TranscriptItem } from "@uma-agent/protocol";

export type ConversationEntry =
  | { kind: "message"; item: TranscriptItem }
  | {
      kind: "response";
      id: string;
      response: Response;
      run: Run | undefined;
      items: TranscriptItem[];
      isCurrentSegment: boolean;
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

  const orderedEntries: Array<{ entry: ConversationEntry; sortKey: number; order: number }> = [];
  let order = 0;
  const renderedSegments = new Set<string>();
  const appendEntry = (entry: ConversationEntry, sortKey: number) => {
    orderedEntries.push({ entry, sortKey, order: order++ });
  };
  const appendResponseSegment = (
    response: Response,
    run: Run | undefined,
    segment: TranscriptItem[],
    sortKey: number,
  ) => {
    const firstUser = segment.find((item) => item.role === "user");
    const segmentId = `${response.id}:${firstUser?.id ?? segment[0]?.id ?? "empty"}`;
    if (renderedSegments.has(segmentId)) return;
    renderedSegments.add(segmentId);
    const hasLaterUser = (itemsByRun.get(response.runId) ?? []).some(
      (item) => item.role === "user" && item.sequence > (firstUser?.sequence ?? 0),
    );
    appendEntry(
      {
        kind: "response",
        id: segmentId,
        response,
        run,
        items: segment,
        isCurrentSegment: !hasLaterUser,
      },
      sortKey,
    );
  };
  for (const item of transcript) {
    const response = responseForItem(item, byMessageId, byRunId);
    if (response) {
      if (item.role !== "user") continue;
      appendEntry({ kind: "message", item }, item.sequence);
      const runItems = itemsByRun.get(response.runId) ?? [];
      const segment = runItems.filter(
        (candidate) =>
          candidate.sequence >= item.sequence &&
          candidate.sequence <
            (runItems.find((next) => next.role === "user" && next.sequence > item.sequence)?.sequence ??
              Number.POSITIVE_INFINITY),
      );
      appendResponseSegment(response, runsById.get(response.runId), segment, item.sequence + 0.1);
      continue;
    }
    appendEntry({ kind: "message", item }, item.sequence);
  }

  for (const response of responses) {
    const runItems = itemsByRun.get(response.runId) ?? [];
    if (!runItems.some((item) => item.role === "user")) {
      const firstVisible = runItems[0];
      const responseMessage = transcript.find((item) => item.id === response.messageId);
      const sortKey = firstVisible
        ? firstVisible.sequence + 0.1
        : responseMessage
          ? responseMessage.sequence + 0.1
          : (transcript[0]?.sequence ?? 0) - 0.1;
      appendResponseSegment(response, runsById.get(response.runId), runItems, sortKey);
    }
  }

  return orderedEntries
    .sort((left, right) => left.sortKey - right.sortKey || left.order - right.order)
    .map(({ entry }) => entry);
}
