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
): void {
  const estimated =
    estimateContextTokens(messages).tokens + Math.ceil((systemPrompt.length + currentPrompt.length) / 4);
  const outputReserve = Math.min(
    model.maxTokens ?? 4_096,
    Math.max(1_024, Math.floor(model.contextWindow * 0.2)),
  );
  if (estimated + outputReserve >= model.contextWindow) throw new ContextOverflowError();
}

function composeMessages(summary: ContextSummary | undefined, pending: StoredAgentMessage[]): AgentMessage[] {
  return [
    ...(summary
      ? [createCompactionSummaryMessage(summary.content, 0, summary.updatedAt) as AgentMessage]
      : []),
    ...pending.map((entry) => entry.message),
  ];
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
    if (cut < 2) return { messages: composeMessages(summary, pending), ...(summary ? { summary } : {}) };

    const toSummarize = pending.slice(0, cut);
    try {
      const generated = await generateSummary(
        toSummarize.map((entry) => entry.message),
        this.models.models,
        model,
        Math.min(8_192, Math.max(1_024, Math.floor(model.contextWindow * 0.05))),
        signal,
        "Preserve goals, decisions, constraints, exact filenames, attachment IDs, relevant paths, file changes, tool outcomes and errors, unresolved references, and unresolved work.",
        summary?.content,
        session.thinkingLevel,
      );
      if (generated.ok) {
        const last = toSummarize.at(-1);
        if (last) {
          // The database keeps the newest boundary when two runs compact concurrently.
          // Re-read it before slicing so an older compaction can never hide newer history.
          const persisted = this.database.putContextSummary(session.id, last.sequence, generated.value);
          summary = persisted;
          pending = entries.filter((entry) => entry.sequence > persisted.throughSequence);
        }
      }
    } catch {
      // Compaction is advisory; the next model call reports a hard context failure.
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
