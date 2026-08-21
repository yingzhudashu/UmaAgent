import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AdapterStore } from "../src/store.js";

const temporary: string[] = [];
afterEach(async () =>
  Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))),
);

describe("AdapterStore", () => {
  it("deduplicates inbound messages and persists conversation mappings", async () => {
    const root = await mkdtemp(join(tmpdir(), "uma-feishu-store-"));
    temporary.push(root);
    const store = new AdapterStore(root);
    const conversation = store.createConversation(
      { tenant: "tenant", chatType: "group", chatId: "chat", threadRoot: "thread" },
      "session-1",
    );
    const first = store.claimInbound({
      externalId: "external-1",
      senderId: "sender",
      rawType: "text",
      payload: { text: "hello" },
    });
    const duplicate = store.claimInbound({
      externalId: "external-1",
      senderId: "sender",
      rawType: "text",
      payload: { text: "hello" },
    });
    expect(first.fresh).toBe(true);
    expect(duplicate).toEqual({ messageId: first.messageId, fresh: false });
    expect(store.listPendingInbound()).toHaveLength(1);
    expect(store.startInbound("external-1")).toBe(true);
    store.attachInboundConversation("external-1", conversation.id);
    store.markInbound(first.messageId, "processed");
    expect(store.listPendingInbound()).toHaveLength(0);
    expect(
      store.getConversation({ tenant: "tenant", chatType: "group", chatId: "chat", threadRoot: "thread" }),
    ).toEqual({ id: conversation.id, sessionId: "session-1", chatId: "chat" });
    store.close();
  });

  it("claims opaque callbacks once and treats repeated clicks as successful reads", async () => {
    const root = await mkdtemp(join(tmpdir(), "uma-feishu-callback-"));
    temporary.push(root);
    const store = new AdapterStore(root);
    store.putActionCallback({
      id: "callback-1",
      kind: "run_action",
      targetId: "action-1",
      runId: "run-1",
      decision: "acknowledge",
      feishuMessageId: "message-1",
      tokenHash: "hash-1",
      expiresAt: Date.now() + 60_000,
    });
    expect(store.claimActionCallback("hash-1")).toEqual({
      kind: "run_action",
      targetId: "action-1",
      runId: "run-1",
      decision: "acknowledge",
      used: false,
    });
    expect(store.claimActionCallback("hash-1")?.used).toBe(true);
    store.releaseActionCallback("hash-1");
    expect(store.claimActionCallback("hash-1")?.used).toBe(false);
    expect(store.claimActionCallback("unknown")).toBeUndefined();
    store.close();
  });

  it("restores processing inbound work as pending after restart and recognizes Adapter replies", async () => {
    const root = await mkdtemp(join(tmpdir(), "uma-feishu-restart-"));
    temporary.push(root);
    let store = new AdapterStore(root);
    const conversation = store.createConversation(
      { tenant: "tenant", chatType: "group", chatId: "chat", threadRoot: "" },
      "session-1",
    );
    const claimed = store.claimInbound({
      externalId: "pending-1",
      senderId: "owner",
      rawType: "text",
      payload: { message: { message_id: "pending-1" } },
    });
    expect(store.startInbound("pending-1")).toBe(true);
    store.upsertCard(conversation.id, "run-1", 4, "running", "adapter-message-1");
    store.close();

    store = new AdapterStore(root);
    expect(store.listPendingInbound()).toEqual([
      {
        externalId: "pending-1",
        messageId: claimed.messageId,
        payload: { message: { message_id: "pending-1" } },
      },
    ]);
    expect(store.isOutboundMessage("adapter-message-1")).toBe(true);
    expect(store.isOutboundMessage("user-message-1")).toBe(false);
    store.close();
  });

  it("covers card state, conversation lists, and inbound failure transitions", async () => {
    const root = await mkdtemp(join(tmpdir(), "uma-feishu-cards-"));
    temporary.push(root);
    const store = new AdapterStore(root);
    expect(
      store.getConversation({ tenant: "missing", chatType: "p2p", chatId: "chat", threadRoot: "" }),
    ).toBeUndefined();
    const conversation = store.createConversation(
      { tenant: "tenant", chatType: "p2p", chatId: "chat", threadRoot: "" },
      "session-1",
    );
    expect(store.listConversations()).toEqual([conversation]);

    const inbound = store.claimInbound({ externalId: "failed-1", rawType: "file", payload: { key: 1 } });
    expect(store.startInbound("missing")).toBe(false);
    expect(store.startInbound("failed-1")).toBe(true);
    store.markInbound(inbound.messageId, "failed", "download failed");
    expect(store.isOutboundMessage(undefined)).toBe(false);

    expect(store.getCard(conversation.id, "missing")).toBeUndefined();
    store.upsertCard(conversation.id, "run-1", 1, "running");
    expect(store.getCard(conversation.id, "run-1")).toEqual({ sequence: 1 });
    store.upsertCard(conversation.id, "run-1", 3, "completed", "message-1");
    expect(store.getCard(conversation.id, "run-1")).toEqual({ messageId: "message-1", sequence: 3 });
    expect(store.latestConversationSequence(conversation.id)).toBe(3);
    expect(store.latestConversationSequence("missing")).toBe(0);
    store.markCardFailed(conversation.id, "run-1", "rate limited");
    store.close();
  });

  it("rejects expired callbacks and unsupported on-disk schemas", async () => {
    const root = await mkdtemp(join(tmpdir(), "uma-feishu-schema-"));
    temporary.push(root);
    let store = new AdapterStore(root);
    store.putActionCallback({
      id: "expired",
      kind: "approval",
      targetId: "approval-1",
      feishuMessageId: "message-1",
      tokenHash: "expired-hash",
      expiresAt: Date.now() - 1,
    });
    expect(store.claimActionCallback("expired-hash")).toBeUndefined();
    store.close();

    store = new AdapterStore(root);
    store.db.exec("PRAGMA user_version=99");
    store.close();
    expect(() => new AdapterStore(root)).toThrow("Unsupported Feishu adapter schema 99");
  });
});
