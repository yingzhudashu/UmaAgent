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
import { prepareStatement } from "./sql-statements.js";
import type { StoredAgentMessage } from "./types.js";

/** Read-only transcript queries. It deliberately does not own transactions. */
export class MessageRepository {
  constructor(private readonly db: DatabaseSync) {}

  getMessage(id: string): TranscriptItem {
    const value = row(prepareStatement(this.db, "SELECT * FROM messages WHERE id=?"), id);
    if (!value) throw new Error(`Message not found: ${id}`);
    return this.toTranscriptItem(value);
  }

  findMessageOwner(id: string): { sessionId: string; runId?: string } | undefined {
    const value = row(prepareStatement(this.db, "SELECT session_id,run_id FROM messages WHERE id=?"), id);
    if (!value) return undefined;
    return {
      sessionId: text(value.session_id),
      ...(value.run_id ? { runId: text(value.run_id) } : {}),
    };
  }

  listMessages(sessionId: string, runId?: string): TranscriptItem[] {
    const values = this.visibleRows(sessionId, runId === undefined ? {} : { runId });
    const attachments = this.loadAttachments([...new Set(values.flatMap(attachmentIdsFrom))]);
    return values.map((value) => this.toTranscriptItem(value, attachments));
  }

  listHistory(sessionId: string, beforeSequence?: number, limit = 100): SessionHistoryPage {
    const bounded = Math.max(1, Math.min(500, limit));
    const page = this.visibleRows(sessionId, {
      ...(beforeSequence === undefined ? {} : { beforeSequence }),
      limit: bounded + 1,
      newestFirst: true,
    });
    const hasMore = page.length > bounded;
    const selected = page.slice(0, bounded).reverse();
    const attachments = this.loadAttachments([...new Set(selected.flatMap(attachmentIdsFrom))]);
    return {
      sessionId,
      items: selected.map((value) => this.toTranscriptItem(value, attachments)),
      oldestSequence: selected.length ? integer(selected[0]?.sequence) : 0,
      hasMore,
    };
  }

  /** 活动分支只读取轻量标识；正文和 payload 仅在确实需要的窗口中加载。 */
  visibleKeys(sessionId: string): Row[] {
    return this.visibleRows(sessionId, {}, "id,run_id,sequence");
  }

  /** 日/会话摘要仅需要末尾公开正文和范围边界，无需反复构造全部 Transcript 与附件。 */
  rollupContext(sessionId: string) {
    const keys = this.visibleRows(sessionId, {}, "sequence,created_at");
    const latest = keys.at(-1);
    if (!latest) return undefined;
    const day = new Date(integer(latest.created_at)).toISOString().slice(0, 10);
    const dayStart = Date.parse(`${day}T00:00:00.000Z`);
    const dayKeys = keys.filter(
      (value) => integer(value.created_at) >= dayStart && integer(value.created_at) < dayStart + 86_400_000,
    );
    const summarize = (values: Row[]) =>
      values
        .reverse()
        .map((value) => `${text(value.role)}: ${text(value.content)}`)
        .join("\n")
        .slice(0, 8_000);
    return {
      day,
      firstSequence: integer(keys[0]?.sequence),
      lastSequence: integer(latest.sequence),
      dayFirstSequence: integer(dayKeys[0]?.sequence),
      dayLastSequence: integer(dayKeys.at(-1)?.sequence),
      dailyText: summarize(
        this.visibleRows(
          sessionId,
          {
            publicOnly: true,
            createdFrom: dayStart,
            createdBefore: dayStart + 86_400_000,
            newestFirst: true,
            limit: 100,
          },
          "role,content",
        ),
      ),
      sessionText: summarize(
        this.visibleRows(sessionId, { publicOnly: true, newestFirst: true, limit: 50 }, "role,content"),
      ),
    };
  }

  private visibleRows(
    sessionId: string,
    options: {
      beforeSequence?: number;
      afterSequence?: number;
      limit?: number;
      newestFirst?: boolean;
      agentOnly?: boolean;
      runId?: string;
      publicOnly?: boolean;
      createdFrom?: number;
      createdBefore?: number;
    } = {},
    columns = "*",
  ): Row[] {
    const branch = row(
      prepareStatement(
        this.db,
        "SELECT b.name,b.head_message_id,f.source_message_id AS fork_source_message_id FROM sessions s LEFT JOIN conversation_branches b ON b.id=s.active_branch_id LEFT JOIN conversation_branch_forks f ON f.branch_id=b.id WHERE s.id=?",
      ),
      sessionId,
    );
    const branched = Boolean(branch?.head_message_id);
    const forkSourceMessageId = branch?.fork_source_message_id
      ? text(branch.fork_source_message_id)
      : undefined;
    // UNION 去重保证异常祖先环不会无限递归；每一步都约束 session_id。
    const ancestry = branched
      ? `WITH RECURSIVE active_path(id,parent_message_id,run_id,sequence) AS (
      SELECT id,parent_message_id,run_id,sequence FROM messages WHERE id=? AND session_id=?
      UNION SELECT p.id,p.parent_message_id,p.run_id,p.sequence FROM messages p JOIN active_path a ON p.id=a.parent_message_id WHERE p.session_id=?
    ), prefix_path(id,parent_message_id,run_id,sequence) AS (
      SELECT m.id,m.parent_message_id,m.run_id,m.sequence
      FROM messages m
      WHERE m.id=(SELECT parent_message_id FROM messages WHERE id=? AND session_id=?)
      UNION SELECT p.id,p.parent_message_id,p.run_id,p.sequence FROM messages p JOIN prefix_path a ON p.id=a.parent_message_id WHERE p.session_id=?
    ) `
      : "";
    const conditions = ["session_id=?"];
    const args: Array<string | number> = branched
      ? [
          text(branch?.head_message_id),
          sessionId,
          sessionId,
          forkSourceMessageId ?? "",
          sessionId,
          sessionId,
          sessionId,
        ]
      : [sessionId];
    if (branched) {
      conditions.push(`(
      id IN (SELECT id FROM active_path) OR run_id IN (SELECT run_id FROM active_path)
      OR id IN (SELECT id FROM prefix_path) OR run_id IN (SELECT run_id FROM prefix_path))`);
    }
    if (options.beforeSequence !== undefined) {
      conditions.push("sequence < ?");
      args.push(options.beforeSequence);
    }
    if (options.afterSequence !== undefined) {
      conditions.push("sequence > ?");
      args.push(options.afterSequence);
    }
    if (options.agentOnly) conditions.push("(status='complete' OR (role='tool' AND status='error'))");
    if (options.runId !== undefined) {
      conditions.push("run_id=?");
      args.push(options.runId);
    }
    if (options.publicOnly) conditions.push("role!='tool'");
    if (options.createdFrom !== undefined) {
      conditions.push("created_at>=?");
      args.push(options.createdFrom);
    }
    if (options.createdBefore !== undefined) {
      conditions.push("created_at<?");
      args.push(options.createdBefore);
    }
    const limit = options.limit === undefined ? "" : " LIMIT ?";
    if (options.limit !== undefined) args.push(options.limit);
    return rows(
      prepareStatement(
        this.db,
        `${ancestry}SELECT ${columns} FROM messages WHERE ${conditions.join(" AND ")} ORDER BY sequence ${options.newestFirst ? "DESC" : "ASC"}${limit}`,
      ),
      ...args,
    );
  }

  listAgentMessages(
    sessionId: string,
    options: { beforeSequence?: number; afterSequence?: number } = {},
  ): StoredAgentMessage[] {
    const values = this.visibleRows(sessionId, { ...options, agentOnly: true });
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
    const messageRows = rows(
      prepareStatement(this.db, `SELECT * FROM messages WHERE id IN (${placeholders})`),
      ...ids,
    );
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
      ...(value.parent_message_id ? { parentMessageId: text(value.parent_message_id) } : {}),
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
      prepareStatement(this.db, `SELECT * FROM attachments WHERE id IN (${placeholders})`),
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
