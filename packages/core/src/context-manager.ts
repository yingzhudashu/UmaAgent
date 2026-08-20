import { type AgentMessage, estimateContextTokens, generateSummary } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import type { Session } from "@uma-agent/protocol";
import type { UmaDatabase } from "./database.js";
import type { ModelRegistry } from "./models.js";
import type { ContextSummary, StoredAgentMessage, UmaConfig } from "./types.js";

export interface CompactedContext {
  messages: AgentMessage[];
  summary?: ContextSummary;
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
    const summaryMessage: AgentMessage[] = summary
      ? [{ role: "user", content: `Conversation summary:\n${summary.content}`, timestamp: summary.updatedAt }]
      : [];
    const model = modelOverride ?? this.models.get(session.model);
    const contextTokens = estimateContextTokens([
      ...summaryMessage,
      ...pending.map((entry) => entry.message),
    ]).tokens;
    if ((!force && contextTokens < model.contextWindow * 0.65) || pending.length < 6)
      return { messages: pending.map((entry) => entry.message), ...(summary ? { summary } : {}) };

    const keepRecentTokens = Math.min(20_000, Math.floor(model.contextWindow * 0.2));
    let retainedTokens = 0;
    let cut = pending.length;
    while (cut > 0 && retainedTokens < keepRecentTokens) {
      cut--;
      const entry = pending[cut];
      if (entry) retainedTokens += estimateContextTokens([entry.message]).tokens;
    }
    if (cut < 2) return { messages: pending.map((entry) => entry.message), ...(summary ? { summary } : {}) };

    const toSummarize = pending.slice(0, cut);
    try {
      const generated = await generateSummary(
        toSummarize.map((entry) => entry.message),
        this.models.models,
        model,
        Math.min(8_192, Math.max(1_024, Math.floor(model.contextWindow * 0.05))),
        signal,
        "Preserve goals, decisions, constraints, file changes, tool outcomes, and unresolved work.",
        summary?.content,
        session.thinkingLevel,
      );
      if (generated.ok) {
        const last = toSummarize.at(-1);
        if (last) summary = this.database.putContextSummary(session.id, last.sequence, generated.value);
        pending = pending.slice(cut);
      }
    } catch {
      // Compaction is advisory; the next model call reports a hard context failure.
    }
    return { messages: pending.map((entry) => entry.message), ...(summary ? { summary } : {}) };
  }
}
