import type { DatabaseSync } from "node:sqlite";
import type { Response, ResponseActivity, ResponseStatus } from "@uma-agent/protocol";
import { integer, type Row, rows, text, toAttachment } from "./database-utils.js";
import { prepareStatement } from "./sql-statements.js";

/** 响应只读投影：按会话批量加载，避免每条回复各查询步骤和附件的 N+1 开销。 */
export class ResponseRepository {
  constructor(private readonly db: DatabaseSync) {}

  list(sessionId: string, page?: { runIds: string[]; messageIds: string[] }): Response[] {
    // 分页只读取当前页涉及的回答及其步骤、附件，不能为翻一页反复加载整段会话。
    const clauses: string[] = [];
    const parameters = [sessionId];
    if (page) {
      for (const [column, ids] of [
        ["run_id", page.runIds],
        ["message_id", page.messageIds],
      ] as const) {
        if (!ids.length) continue;
        clauses.push(`r.${column} IN (${ids.map(() => "?").join(",")})`);
        parameters.push(...ids);
      }
      if (!clauses.length) return [];
    }
    const filter = `r.session_id=?${page ? ` AND (${clauses.join(" OR ")})` : ""}`;
    const values = rows(
      prepareStatement(this.db, `SELECT r.* FROM responses r WHERE ${filter} ORDER BY r.created_at`),
      ...parameters,
    );
    const activities = rows(
      prepareStatement(
        this.db,
        `SELECT a.* FROM response_activities a JOIN responses r ON r.id=a.response_id WHERE ${filter} ORDER BY a.created_at`,
      ),
      ...parameters,
    );
    const attachments = rows(
      prepareStatement(
        this.db,
        `SELECT a.* FROM attachments a JOIN responses r ON r.id=a.response_id WHERE ${filter} ORDER BY a.created_at`,
      ),
      ...parameters,
    );
    const groupedActivities = new Map<string, Row[]>();
    const groupedAttachments = new Map<string, Row[]>();
    for (const [source, target] of [
      [activities, groupedActivities],
      [attachments, groupedAttachments],
    ] as const) {
      for (const value of source) {
        const id = text(value.response_id);
        const group = target.get(id);
        if (group) group.push(value);
        else target.set(id, [value]);
      }
    }
    return values.map((value) =>
      this.project(
        value,
        groupedActivities.get(text(value.id)) ?? [],
        groupedAttachments.get(text(value.id)) ?? [],
      ),
    );
  }

  get(value: Row): Response {
    return this.project(
      value,
      rows(
        prepareStatement(
          this.db,
          "SELECT * FROM response_activities WHERE response_id=? ORDER BY created_at",
        ),
        text(value.id),
      ),
      rows(
        prepareStatement(this.db, "SELECT * FROM attachments WHERE response_id=? ORDER BY created_at"),
        text(value.id),
      ),
    );
  }

  private project(value: Row, activities: Row[], attachments: Row[]): Response {
    return {
      id: text(value.id),
      sessionId: text(value.session_id),
      runId: text(value.run_id),
      messageId: text(value.message_id),
      status: text(value.status) as ResponseStatus,
      content: text(value.content),
      activities: activities.map(
        (item): ResponseActivity => ({
          id: text(item.id),
          responseId: text(item.response_id),
          kind: text(item.kind) as ResponseActivity["kind"],
          ...(item.status ? { status: text(item.status) as ResponseStatus } : {}),
          ...(item.text !== null && item.text !== undefined ? { text: text(item.text) } : {}),
          ...(item.tool_name ? { toolName: text(item.tool_name) } : {}),
          ...(item.attachment_id ? { attachmentId: text(item.attachment_id) } : {}),
          createdAt: integer(item.created_at),
        }),
      ),
      attachments: attachments.map(toAttachment),
      createdAt: integer(value.created_at),
      updatedAt: integer(value.updated_at),
    };
  }
}
