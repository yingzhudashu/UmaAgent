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
    const first = store.claimInbound("external-1", conversation.id, "sender", "text");
    const duplicate = store.claimInbound("external-1", conversation.id, "sender", "text");
    expect(first.fresh).toBe(true);
    expect(duplicate).toEqual({ messageId: first.messageId, fresh: false });
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
});
