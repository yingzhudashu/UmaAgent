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
    this.db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    const version = Number(
      (this.db.prepare("PRAGMA user_version").get() as Row | undefined)?.user_version ?? 0,
    );
    if (version === 0) {
      this.db.exec(readFileSync(new URL("./schema.sql", import.meta.url), "utf8"));
      this.db.exec("PRAGMA user_version=2");
    } else if (version !== 2) {
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
  }): { id: string; sessionId: string; chatId: string } | undefined {
    const row = this.db
      .prepare(
        "SELECT id,uma_session_id,chat_id FROM conversation_maps WHERE tenant_key=? AND chat_type=? AND chat_id=? AND thread_root_id=?",
      )
      .get(key.tenant, key.chatType, key.chatId, key.threadRoot) as Row | undefined;
    return row
      ? { id: text(row.id), sessionId: text(row.uma_session_id), chatId: text(row.chat_id) }
      : undefined;
  }
  createConversation(
    key: { tenant: string; chatType: string; chatId: string; threadRoot: string },
    sessionId: string,
  ): { id: string; sessionId: string; chatId: string } {
    const id = randomUUID();
    this.db
      .prepare(
        "INSERT INTO conversation_maps(id,tenant_key,chat_type,chat_id,thread_root_id,uma_session_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",
      )
      .run(id, key.tenant, key.chatType, key.chatId, key.threadRoot, sessionId, Date.now(), Date.now());
    return { id, sessionId, chatId: key.chatId };
  }
  listConversations(): Array<{ id: string; sessionId: string; chatId: string }> {
    return (this.db.prepare("SELECT id,uma_session_id,chat_id FROM conversation_maps").all() as Row[]).map(
      (row) => ({ id: text(row.id), sessionId: text(row.uma_session_id), chatId: text(row.chat_id) }),
    );
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
  markCardFailed(conversationId: string, runId: string, error: string): void {
    this.db
      .prepare("UPDATE outbound_cards SET status='failed',error=?,updated_at=? WHERE id=?")
      .run(error, Date.now(), `${conversationId}:${runId}`);
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

  latestConversationSequence(conversationId: string): number {
    const row = this.db
      .prepare(
        "SELECT COALESCE(MAX(last_rendered_sequence),0) AS sequence FROM outbound_cards WHERE conversation_map_id=?",
      )
      .get(conversationId) as Row;
    return Number(row.sequence ?? 0);
  }

  putActionCallback(input: {
    id: string;
    kind: "approval" | "resume" | "run_action";
    targetId: string;
    runId?: string;
    decision?: string;
    feishuMessageId: string;
    tokenHash: string;
    expiresAt: number;
  }): void {
    this.db
      .prepare(
        "INSERT INTO action_callbacks(id,kind,target_id,run_id,decision,feishu_message_id,callback_token_hash,expires_at,status) VALUES(?,?,?,?,?,?,?,?,?)",
      )
      .run(
        input.id,
        input.kind,
        input.targetId,
        input.runId ?? null,
        input.decision ?? null,
        input.feishuMessageId,
        input.tokenHash,
        input.expiresAt,
        "pending",
      );
  }

  claimActionCallback(tokenHash: string):
    | {
        kind: "approval" | "resume" | "run_action";
        targetId: string;
        runId?: string;
        decision?: string;
        used: boolean;
      }
    | undefined {
    const row = this.db
      .prepare(
        "SELECT kind,target_id,run_id,decision,status FROM action_callbacks WHERE callback_token_hash=? AND expires_at>?",
      )
      .get(tokenHash, Date.now()) as Row | undefined;
    if (!row) return undefined;
    const value = {
      kind: text(row.kind) as "approval" | "resume" | "run_action",
      targetId: text(row.target_id),
      ...(row.run_id ? { runId: text(row.run_id) } : {}),
      ...(row.decision ? { decision: text(row.decision) } : {}),
    };
    if (row.status === "used") return { ...value, used: true };
    const result = this.db
      .prepare("UPDATE action_callbacks SET status='used' WHERE callback_token_hash=? AND status='pending'")
      .run(tokenHash);
    if (result.changes !== 1) return undefined;
    return { ...value, used: false };
  }

  releaseActionCallback(tokenHash: string): void {
    this.db
      .prepare("UPDATE action_callbacks SET status='pending' WHERE callback_token_hash=? AND status='used'")
      .run(tokenHash);
  }
}
