import type { Response, Run, TranscriptItem } from "@uma-agent/protocol";

export type ConversationEntry =
  | { kind: "message"; item: TranscriptItem }
  | { kind: "response"; response: Response; run: Run | undefined; items: TranscriptItem[] };

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
  const renderedResponses = new Set<string>();
  for (const item of transcript) {
    const response = responseForItem(item, byMessageId, byRunId);
    if (response) {
      if (item.role !== "user") continue;
      entries.push({ kind: "message", item });
      if (!renderedResponses.has(response.id)) {
        renderedResponses.add(response.id);
        entries.push({
          kind: "response",
          response,
          run: runsById.get(response.runId),
          items: itemsByRun.get(response.runId) ?? [],
        });
      }
      continue;
    }
    entries.push({ kind: "message", item });
  }

  for (const response of responses) {
    if (renderedResponses.has(response.id)) continue;
    renderedResponses.add(response.id);
    entries.push({
      kind: "response",
      response,
      run: runsById.get(response.runId),
      items: itemsByRun.get(response.runId) ?? [],
    });
  }

  return entries;
}
