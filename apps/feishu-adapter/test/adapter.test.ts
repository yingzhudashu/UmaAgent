import { describe, expect, it, vi } from "vitest";
import { createFeishuAdapter } from "../src/adapter.js";

describe("Feishu adapter composition", () => {
  it("uses injected gateways, store, and clock for observable health", () => {
    const core = { close: vi.fn() } as never;
    const feishu = { createCard: vi.fn() } as never;
    const store = { close: vi.fn() } as never;
    const adapter = createFeishuAdapter({
      core,
      feishu,
      store,
      clock: {
        now: () => 123,
        setTimeout: vi.fn() as never,
        clearTimeout: vi.fn(),
      },
    });
    expect(adapter.core).toBe(core);
    adapter.started();
    adapter.inbound();
    expect(adapter.health()).toEqual({ status: "ok", connected: true, lastInboundAt: 123 });
    adapter.failed(new Error("rate limited"));
    expect(adapter.health()).toMatchObject({ status: "degraded", lastError: "rate limited" });
    adapter.stopped();
    expect(adapter.health().status).toBe("stopped");
  });
});
