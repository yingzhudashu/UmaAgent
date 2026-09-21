import type { DatabaseSync } from "node:sqlite";
import type { Run } from "@uma-agent/protocol";
import { integer, rows, text } from "./database-utils.js";
import { prepareStatement } from "./sql-statements.js";

export interface QualityRunHistory {
  id: string;
  kind: "review" | "improve";
  status: Run["status"];
  resultMessageId?: string;
  resultContent?: string;
  error?: string;
  createdAt: number;
  updatedAt: number;
}

export class QualityHistoryRepository {
  constructor(private readonly db: DatabaseSync) {}

  listForMessage(messageId: string): QualityRunHistory[] {
    return rows(
      prepareStatement(
        this.db,
        "SELECT r.id,r.kind,r.status,r.result_message_id,m.content AS result_content,r.error,r.created_at,r.updated_at FROM runs r LEFT JOIN messages m ON m.id=r.result_message_id WHERE r.target_message_id=? AND r.kind IN ('review','improve') ORDER BY r.created_at,r.id",
      ),
      messageId,
    ).map((value) => ({
      id: text(value.id),
      kind: text(value.kind) as "review" | "improve",
      status: text(value.status) as Run["status"],
      ...(value.result_message_id ? { resultMessageId: text(value.result_message_id) } : {}),
      ...(value.result_content !== null && value.result_content !== undefined
        ? { resultContent: text(value.result_content) }
        : {}),
      ...(value.error ? { error: text(value.error) } : {}),
      createdAt: integer(value.created_at),
      updatedAt: integer(value.updated_at),
    }));
  }
}
