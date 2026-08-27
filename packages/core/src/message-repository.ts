import type { DatabaseSync } from "node:sqlite";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import type { Attachment, MessageSource, SessionHistoryPage, TranscriptItem } from "@uma-agent/protocol";
import {
  attachmentIdsFrom,
  integer,
  parseJson,
  type Row,
  row,
  rows,
  text,
  toAttachment,
} from "./database-utils.js";
import type { StoredAgentMessage } from "./types.js";

/** Read-only transcript queries. It deliberately does not own transactions. */
export class MessageRepository {
  constructor(private readonly db: DatabaseSync) {}

  getMessage(id: string): TranscriptItem {
    const value = row(this.db.prepare("SELECT * FROM messages WHERE id=?"), id);
    if (!value) throw new Error(`Message not found: ${id}`);
    return this.toTranscriptItem(value);
  }

  findMessageOwner(id: string): { sessionId: string; runId?: string } | undefined {
    const value = row(this.db.prepare("SELECT session_id,run_id FROM messages WHERE id=?"), id);
    if (!value) return undefined;
    return {
      sessionId: text(value.session_id),
      ...(value.run_id ? { runId: text(value.run_id) } : {}),
    };
  }

  listMessages(sessionId: string): TranscriptItem[] {
    const ids = rows(
      this.db.prepare("SELECT id FROM messages WHERE session_id=? ORDER BY sequence"),
      sessionId,
    ).map((value) => text(value.id));
    return this.listByIds(ids);
  }

  listHistory(sessionId: string, beforeSequence?: number, limit = 100): SessionHistoryPage {
    const bounded = Math.max(1, Math.min(500, limit));
    const values = rows(
      beforeSequence === undefined
        ? this.db.prepare(
            "SELECT id,sequence FROM messages WHERE session_id=? ORDER BY sequence DESC LIMIT ?",
          )
        : this.db.prepare(
            "SELECT id,sequence FROM messages WHERE session_id=? AND sequence<? ORDER BY sequence DESC LIMIT ?",
          ),
      ...(beforeSequence === undefined ? [sessionId, bounded + 1] : [sessionId, beforeSequence, bounded + 1]),
    );
    const hasMore = values.length > bounded;
    const page = values.slice(0, bounded).reverse();
    const items = this.listByIds(page.map((value) => text(value.id)));
    return {
      sessionId,
      items,
      oldestSequence: page.length ? integer(page[0]?.sequence) : 0,
      hasMore,
    };
  }

  listAgentMessages(
    sessionId: string,
    options: { beforeSequence?: number; afterSequence?: number } = {},
  ): StoredAgentMessage[] {
    const conditions = ["session_id=?", "(status='complete' OR (role='tool' AND status='error'))"];
    const parameters: Array<string | number> = [sessionId];
    if (options.afterSequence !== undefined) {
      conditions.push("sequence>?");
      parameters.push(options.afterSequence);
    }
    if (options.beforeSequence !== undefined) {
      conditions.push("sequence<?");
      parameters.push(options.beforeSequence);
    }
    const values = rows(
      this.db.prepare(
        `SELECT id,sequence,role,status,name,content,payload_json,attachment_ids_json,updated_at FROM messages WHERE ${conditions.join(" AND ")} ORDER BY sequence`,
      ),
      ...parameters,
    );
    const attachmentIds = [...new Set(values.flatMap(attachmentIdsFrom))];
    const attachments = this.loadAttachments(attachmentIds);
    return values.flatMap((value) => {
      const parsed = parseJson<AgentMessage | null>(value.payload_json, null);
      const message = this.withAttachmentContext(
        parsed ?? this.deriveAgentMessage(value),
        attachmentIdsFrom(value),
        attachments,
      );
      return [{ id: text(value.id), sequence: integer(value.sequence), message }];
    });
  }

  listByIds(ids: string[]): TranscriptItem[] {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => "?").join(",");
    const messageRows = rows(this.db.prepare(`SELECT * FROM messages WHERE id IN (${placeholders})`), ...ids);
    const attachmentIds = [...new Set(messageRows.flatMap(attachmentIdsFrom))];
    const attachments = this.loadAttachments(attachmentIds);
    const byId = new Map(messageRows.map((value) => [text(value.id), value]));
    return ids
      .map((id) => byId.get(id))
      .filter((value): value is Row => value !== undefined)
      .map((value) => this.toTranscriptItem(value, attachments));
  }

  private toTranscriptItem(value: Row, attachments?: Map<string, Attachment>): TranscriptItem {
    const attachmentIds = attachmentIdsFrom(value);
    const resolvedAttachments = attachments ?? this.loadAttachments(attachmentIds);
    const source = value.source_json
      ? parseJson<MessageSource | undefined>(value.source_json, undefined)
      : undefined;
    return {
      id: text(value.id),
      sequence: integer(value.sequence),
      role: text(value.role) as TranscriptItem["role"],
      status: text(value.status) as TranscriptItem["status"],
      content: text(value.content),
      ...(value.name ? { name: text(value.name) } : {}),
      ...(value.run_id ? { runId: text(value.run_id) } : {}),
      ...(value.revision_of_message_id ? { revisionOfMessageId: text(value.revision_of_message_id) } : {}),
      attachments: attachmentIds
        .map((attachmentId) => resolvedAttachments.get(attachmentId))
        .filter((item): item is Attachment => item !== undefined),
      ...(source ? { source } : {}),
      createdAt: integer(value.created_at),
      updatedAt: integer(value.updated_at),
    };
  }

  private loadAttachments(ids: string[]): Map<string, Attachment> {
    const result = new Map<string, Attachment>();
    if (ids.length === 0) return result;
    const placeholders = ids.map(() => "?").join(",");
    for (const value of rows(
      this.db.prepare(`SELECT * FROM attachments WHERE id IN (${placeholders})`),
      ...ids,
    )) {
      const attachment = toAttachment(value);
      result.set(attachment.id, attachment);
    }
    return result;
  }

  private withAttachmentContext(
    message: AgentMessage,
    ids: string[],
    attachments: Map<string, Attachment>,
  ): AgentMessage {
    if (message.role !== "user" || ids.length === 0) return message;
    const metadata = ids
      .map((id) => attachments.get(id))
      .filter((item): item is Attachment => item !== undefined)
      .map((item) => `- ${item.name} (id: ${item.id}, type: ${item.mimeType})`)
      .join("\n");
    if (!metadata) return message;
    const suffix = `\n\n<attachments>\n${metadata}\n</attachments>`;
    return {
      ...message,
      content:
        typeof message.content === "string"
          ? `${message.content}${suffix}`
          : [...message.content, { type: "text", text: suffix }],
    };
  }

  private deriveAgentMessage(value: Row): AgentMessage {
    const role = text(value.role);
    const content = text(value.content);
    const timestamp = integer(value.updated_at);
    if (role === "assistant")
      return {
        role: "assistant",
        content: [{ type: "text", text: content }],
        api: "openai-responses",
        provider: "uma-agent",
        model: "historical",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp,
      } as AssistantMessage;
    if (role === "tool")
      return {
        role: "toolResult",
        toolCallId: `historical-${text(value.id)}`,
        toolName: text(value.name) || "tool",
        content: [{ type: "text", text: content }],
        isError: text(value.status) === "error",
        timestamp,
      } as ToolResultMessage;
    return { role: "user", content, timestamp };
  }
}
