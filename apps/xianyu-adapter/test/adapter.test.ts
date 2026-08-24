import { describe, expect, it, vi } from "vitest";
import { createXianyuAdapter } from "../src/adapter.js";

describe("Xianyu adapter lifecycle", () => {
  it("forwards inbound messages, supports pause/resume, and reports health", async () => {
    let handler:
      | ((message: {
          conversation: { adapter: string; tenantId: string; conversationId: string; kind: "direct" };
          externalMessageId: string;
          text: string;
        }) => Promise<void>)
      | undefined;
    const transport = {
      start: vi.fn(async (next: typeof handler) => {
        handler = next;
      }),
      stop: vi.fn(async () => undefined),
      send: vi.fn(async () => undefined),
      connected: () => true,
    };
    const core = {
      mapConversation: vi.fn(async () => "session-1"),
      sendMessage: vi.fn(async () => undefined),
    };
    const adapter = createXianyuAdapter({ transport, core });
    await adapter.start();
    await handler?.({
      conversation: { adapter: "xianyu", tenantId: "t", conversationId: "c", kind: "direct" },
      externalMessageId: "m",
      text: "hello",
    });
    expect(core.sendMessage).toHaveBeenCalled();
    adapter.pause();
    await handler?.({
      conversation: { adapter: "xianyu", tenantId: "t", conversationId: "c", kind: "direct" },
      externalMessageId: "m2",
      text: "ignored",
    });
    expect(core.sendMessage).toHaveBeenCalledTimes(1);
    adapter.resume();
    expect(adapter.health()).toMatchObject({ status: "ok", connected: true, paused: false, inbound: 1 });
    await adapter.stop();
    expect(adapter.health().status).toBe("stopped");
  });
});
