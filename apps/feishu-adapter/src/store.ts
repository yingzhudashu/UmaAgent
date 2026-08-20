import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

type Row = Record<string, unknown>;
const text = (value: unknown) => String(value ?? "");

export class AdapterStore {
  readonly db: DatabaseSync;
  constructor(readonly stateDir: string) {
    mkdirSync(stateDir, { recursive: true });
    this.db = new DatabaseSync(join(stateDir, "feishu.db"));
    const version = Number(
      (this.db.prepare("PRAGMA user_version").get() as Row | undefined)?.user_version ?? 0,
    );
    if (version === 0) {
      this.db.exec(readFileSync(new URL("./schema.sql", import.meta.url), "utf8"));
      this.db.exec("PRAGMA user_version=1");
    } else if (version !== 1) {
      this.db.close();
      throw new Error(`Unsupported Feishu adapter schema ${version}; reset state explicitly.`);
    }
  }
  close(): void {
    this.db.close();
  }
  getConversation(key: {
    tenant: string;
    chatType: string;
    chatId: string;
    threadRoot: string;
  }): { id: string; sessionId: string } | undefined {
    const row = this.db
      .prepare(
        "SELECT id,uma_session_id FROM conversation_maps WHERE tenant_key=? AND chat_type=? AND chat_id=? AND thread_root_id=?",
      )
      .get(key.tenant, key.chatType, key.chatId, key.threadRoot) as Row | undefined;
    return row ? { id: text(row.id), sessionId: text(row.uma_session_id) } : undefined;
  }
  createConversation(
    key: { tenant: string; chatType: string; chatId: string; threadRoot: string },
    sessionId: string,
  ): { id: string; sessionId: string } {
    const id = randomUUID();
    this.db
      .prepare(
        "INSERT INTO conversation_maps(id,tenant_key,chat_type,chat_id,thread_root_id,uma_session_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",
      )
      .run(id, key.tenant, key.chatType, key.chatId, key.threadRoot, sessionId, Date.now(), Date.now());
    return { id, sessionId };
  }
  claimInbound(
    externalId: string,
    conversationId: string,
    senderId: string | undefined,
    rawType: string,
  ): { messageId: string; fresh: boolean } {
    const existing = this.db
      .prepare("SELECT uma_message_id FROM inbound_messages WHERE external_message_id=?")
      .get(externalId) as Row | undefined;
    if (existing) return { messageId: text(existing.uma_message_id), fresh: false };
    const messageId = randomUUID();
    this.db
      .prepare(
        "INSERT INTO inbound_messages(external_message_id,conversation_map_id,sender_id,raw_type,uma_message_id,status,received_at) VALUES(?,?,?,?,?,?,?)",
      )
      .run(externalId, conversationId, senderId ?? null, rawType, messageId, "received", Date.now());
    return { messageId, fresh: true };
  }
  markInbound(messageId: string, status: "processed" | "failed", error?: string): void {
    this.db
      .prepare("UPDATE inbound_messages SET status=?,processed_at=?,error=? WHERE uma_message_id=?")
      .run(status, Date.now(), error ?? null, messageId);
  }
  upsertCard(
    conversationId: string,
    runId: string,
    sequence: number,
    status: string,
    messageId?: string,
  ): void {
    this.db
      .prepare(
        "INSERT INTO outbound_cards(id,conversation_map_id,run_id,feishu_message_id,last_rendered_sequence,status,updated_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET feishu_message_id=excluded.feishu_message_id,last_rendered_sequence=excluded.last_rendered_sequence,status=excluded.status,updated_at=excluded.updated_at",
      )
      .run(
        `${conversationId}:${runId}`,
        conversationId,
        runId,
        messageId ?? null,
        sequence,
        status,
        Date.now(),
      );
  }
  getCard(conversationId: string, runId: string): { messageId?: string; sequence: number } | undefined {
    const row = this.db
      .prepare("SELECT feishu_message_id,last_rendered_sequence FROM outbound_cards WHERE id=?")
      .get(`${conversationId}:${runId}`) as Row | undefined;
    return row
      ? {
          ...(row.feishu_message_id ? { messageId: text(row.feishu_message_id) } : {}),
          sequence: Number(row.last_rendered_sequence ?? 0),
        }
      : undefined;
  }

  putApprovalCallback(input: {
    id: string;
    approvalId: string;
    feishuMessageId: string;
    tokenHash: string;
    expiresAt: number;
  }): void {
    this.db
      .prepare(
        "INSERT INTO approval_callbacks(id,approval_id,feishu_message_id,callback_token_hash,expires_at,status) VALUES(?,?,?,?,?,?)",
      )
      .run(input.id, input.approvalId, input.feishuMessageId, input.tokenHash, input.expiresAt, "pending");
  }

  resolveApprovalCallback(tokenHash: string): { approvalId: string; status: string } | undefined {
    const row = this.db
      .prepare(
        "SELECT approval_id,status FROM approval_callbacks WHERE callback_token_hash=? AND expires_at>?",
      )
      .get(tokenHash, Date.now()) as Row | undefined;
    if (!row) return undefined;
    this.db
      .prepare("UPDATE approval_callbacks SET status='used' WHERE callback_token_hash=? AND status='pending'")
      .run(tokenHash);
    return { approvalId: text(row.approval_id), status: text(row.status) };
  }
}
