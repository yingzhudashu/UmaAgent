import {
  type AgentMessage,
  createCompactionSummaryMessage,
  estimateContextTokens,
  generateSummary,
} from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import type { Session } from "@uma-agent/protocol";
import type { UmaDatabase } from "./database.js";
import type { ModelRegistry } from "./models.js";
import type { ContextSummary, StoredAgentMessage, UmaConfig } from "./types.js";

export interface CompactedContext {
  messages: AgentMessage[];
  summary?: ContextSummary;
}

export interface MessageContext extends CompactedContext {
  current: StoredAgentMessage;
}

export class ContextOverflowError extends Error {
  readonly code = "ContextOverflow";

  constructor() {
    super("ContextOverflow: the conversation cannot fit within the selected model context window");
    this.name = "ContextOverflowError";
  }
}

export function assertContextCapacity(
  model: Model<UmaConfig["models"][number]["api"]>,
  messages: AgentMessage[],
  systemPrompt = "",
  currentPrompt = "",
): number {
  const contextTokens = estimateContextTokens(messages).tokens;
  const estimated = contextTokens + Math.ceil((systemPrompt.length + currentPrompt.length) / 4);
  const outputReserve = Math.min(
    model.maxTokens ?? 4_096,
    Math.max(1_024, Math.floor(model.contextWindow * 0.2)),
  );
  if (estimated + outputReserve >= model.contextWindow) throw new ContextOverflowError();
  return contextTokens;
}

function composeMessages(summary: ContextSummary | undefined, pending: StoredAgentMessage[]): AgentMessage[] {
  // Provider usage on an assistant message describes the pre-compaction
  // request. Keeping it after inserting a summary makes the SDK estimator
  // treat the compacted prefix as if it were still present and can report a
  // false context overflow during an edit/rerun.
  const compactedPending = summary
    ? pending.map((entry) => {
        if (entry.message.role !== "assistant") return entry.message;
        const { usage: _usage, ...message } = entry.message as AgentMessage & { usage?: unknown };
        return message as AgentMessage;
      })
    : pending.map((entry) => entry.message);
  return [
    ...(summary
      ? [createCompactionSummaryMessage(summary.content, 0, summary.updatedAt) as AgentMessage]
      : []),
    ...compactedPending,
  ];
}

function messageText(message: AgentMessage): string {
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}

function boundedMessage(message: AgentMessage, maxTokens: number): AgentMessage {
  if (estimateContextTokens([message]).tokens <= maxTokens) return message;
  const text = messageText(message);
  const maxChars = Math.max(512, maxTokens * 4);
  const clipped = text.length <= maxChars
    ? text
    : `${text.slice(0, Math.floor(maxChars * 0.7))}\n[…内容已截断…]\n${text.slice(-Math.floor(maxChars * 0.3))}`;
  return {
    ...(message as object),
    content: `[压缩输入中的超大消息，已保留首尾内容]\n${clipped}`,
  } as AgentMessage;
}

function fallbackSummary(entries: AgentMessage[], previous?: string): string {
  const lines = entries.map((message) => `[${message.role}] ${messageText(message)}`);
  const text = [previous ? `已有摘要：${previous}` : "已有摘要：无", ...lines].join("\n");
  return text.length <= 24_000 ? text : `${text.slice(0, 20_000)}\n[…历史已压缩，以上为保留内容…]\n${text.slice(-4_000)}`;
}

export class ContextManager {
  constructor(
    private readonly database: UmaDatabase,
    private readonly models: ModelRegistry,
  ) {}

  async compact(
    session: Session,
    entries: StoredAgentMessage[],
    signal: AbortSignal,
    force = false,
    modelOverride?: Model<UmaConfig["models"][number]["api"]>,
  ): Promise<CompactedContext> {
    let summary = this.database.getContextSummary(session.id);
    let pending = entries.filter((entry) => entry.sequence > (summary?.throughSequence ?? 0));
    const summaryMessage = summary
      ? [createCompactionSummaryMessage(summary.content, 0, summary.updatedAt) as AgentMessage]
      : [];
    const model = modelOverride ?? this.models.get(session.model);
    const contextTokens = estimateContextTokens([
      ...summaryMessage,
      ...pending.map((entry) => entry.message),
    ]).tokens;
    if ((!force && contextTokens < model.contextWindow * 0.65) || pending.length < 6)
      return { messages: composeMessages(summary, pending), ...(summary ? { summary } : {}) };

    const keepRecentTokens = Math.min(20_000, Math.floor(model.contextWindow * 0.2));
    let retainedTokens = 0;
    let cut = pending.length;
    while (cut > 0 && retainedTokens < keepRecentTokens) {
      cut--;
      const entry = pending[cut];
      if (entry) retainedTokens += estimateContextTokens([entry.message]).tokens;
    }
    // Manual compaction must make progress even when only one oversized entry
    // remains. Automatic compaction keeps the conservative boundary below.
    if (cut < 1) return { messages: composeMessages(summary, pending), ...(summary ? { summary } : {}) };

    const toSummarize = pending.slice(0, cut);
    const maxBatchTokens = Math.max(8_000, Math.floor(model.contextWindow * 0.22));
    const batches: StoredAgentMessage[][] = [];
    let batch: StoredAgentMessage[] = [];
    let batchTokens = 0;
    for (const entry of toSummarize) {
      const entryTokens = estimateContextTokens([entry.message]).tokens;
      if (batch.length > 0 && batchTokens + entryTokens > maxBatchTokens) {
        batches.push(batch);
        batch = [];
        batchTokens = 0;
      }
      batch.push(entry);
      batchTokens += Math.min(entryTokens, maxBatchTokens);
    }
    if (batch.length > 0) batches.push(batch);

    let generatedContent = summary?.content;
    let lastSuccessful: StoredAgentMessage | undefined;
    try {
      for (const currentBatch of batches) {
        const input = currentBatch.map((entry) => ({
          ...entry,
          message: boundedMessage(entry.message, Math.max(1_000, Math.floor(maxBatchTokens / Math.max(1, currentBatch.length)))),
        }));
        const generated = await generateSummary(
          input.map((entry) => entry.message),
          this.models.models,
          model,
          Math.min(8_192, Math.max(1_024, Math.floor(model.contextWindow * 0.05))),
          signal,
          "Preserve goals, decisions, constraints, exact filenames, attachment IDs, relevant paths, file changes, tool outcomes and errors, unresolved references, and unresolved work.",
          generatedContent?.slice(-24_000),
          session.thinkingLevel,
        );
        generatedContent = generated.ok ? generated.value : fallbackSummary(input.map((entry) => entry.message), generatedContent);
        lastSuccessful = currentBatch.at(-1);
      }
    } catch {
      generatedContent = fallbackSummary(toSummarize.map((entry) => entry.message), generatedContent);
      lastSuccessful = toSummarize.at(-1);
    }
    if (generatedContent && lastSuccessful) {
      // The database keeps the newest boundary when two runs compact concurrently.
      const persisted = this.database.putContextSummary(session.id, lastSuccessful.sequence, generatedContent);
      summary = persisted;
      pending = entries.filter((entry) => entry.sequence > persisted.throughSequence);
    }
    return { messages: composeMessages(summary, pending), ...(summary ? { summary } : {}) };
  }

  async buildForMessage(
    session: Session,
    messageId: string,
    signal: AbortSignal,
    model: Model<UmaConfig["models"][number]["api"]>,
  ): Promise<MessageContext> {
    const transcript = this.database.getMessage(messageId);
    if (transcript.status !== "complete") throw new Error("Context message is not complete");
    const summary = this.database.getContextSummary(session.id);
    const entries = this.database.listAgentMessages(session.id, {
      beforeSequence: transcript.sequence,
      ...(summary ? { afterSequence: summary.throughSequence } : {}),
    });
    const current = this.database.listAgentMessages(session.id, {
      afterSequence: transcript.sequence - 1,
      beforeSequence: transcript.sequence + 1,
    })[0] ?? {
      id: messageId,
      sequence: transcript.sequence,
      message: { role: "user", content: transcript.content, timestamp: transcript.createdAt },
    };
    return { ...(await this.compact(session, entries, signal, false, model)), current };
  }
}
