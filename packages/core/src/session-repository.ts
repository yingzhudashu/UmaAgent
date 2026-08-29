import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ModelRef, Session } from "@uma-agent/protocol";
import { row, rows, toSession } from "./database-utils.js";

/** Session CRUD only. Transaction ownership stays with UmaDatabase. */
export class SessionRepository {
  constructor(private readonly db: DatabaseSync) {}

  list(userId?: string): Session[] {
    return rows(
      userId
        ? this.db.prepare("SELECT * FROM sessions WHERE user_id=? ORDER BY updated_at DESC")
        : this.db.prepare("SELECT * FROM sessions ORDER BY updated_at DESC"),
      ...(userId ? [userId] : []),
    ).map(toSession);
  }

  create(input: {
    userId: string;
    title: string;
    workspace?: string;
    model: ModelRef;
    thinkingLevel: ThinkingLevel;
    queueMode?: Session["queueMode"];
    assistantName?: string;
    assistantAvatarAttachmentId?: string | null;
  }): Session {
    const id = randomUUID();
    const now = Date.now();
    this.db
      .prepare(
        "INSERT INTO sessions(id,user_id,title,assistant_name,assistant_avatar_attachment_id,workspace,model_provider,model_id,thinking_level,queue_mode,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        id,
        input.userId,
        input.title,
        input.assistantName ?? "UmaAgent",
        input.assistantAvatarAttachmentId ?? null,
        input.workspace ?? null,
        input.model.provider,
        input.model.id,
        input.thinkingLevel,
        input.queueMode ?? "queue",
        now,
        now,
      );
    return this.get(id);
  }

  get(id: string): Session {
    const result = row(this.db.prepare("SELECT * FROM sessions WHERE id = ?"), id);
    if (!result) throw new Error(`Session not found: ${id}`);
    return toSession(result);
  }

  update(
    id: string,
    patch: {
      title?: string;
      model?: ModelRef;
      thinkingLevel?: ThinkingLevel;
      queueMode?: Session["queueMode"];
      assistantName?: string;
      assistantAvatarAttachmentId?: string | null;
    },
  ): Session {
    const current = this.get(id);
    this.db
      .prepare(
        "UPDATE sessions SET title=?, assistant_name=?, assistant_avatar_attachment_id=?, model_provider=?, model_id=?, thinking_level=?, queue_mode=?, updated_at=? WHERE id=?",
      )
      .run(
        patch.title ?? current.title,
        patch.assistantName ?? current.assistantName,
        patch.assistantAvatarAttachmentId === undefined
          ? (current.assistantAvatarAttachmentId ?? null)
          : patch.assistantAvatarAttachmentId,
        patch.model?.provider ?? current.model.provider,
        patch.model?.id ?? current.model.id,
        patch.thinkingLevel ?? current.thinkingLevel,
        patch.queueMode ?? current.queueMode,
        Date.now(),
        id,
      );
    return this.get(id);
  }

  delete(id: string): void {
    const result = this.db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
    if (result.changes === 0) throw new Error(`Session not found: ${id}`);
  }
}
