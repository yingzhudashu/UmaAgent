import { describe, expect, it, vi } from "vitest";
import { createFeishuAdapter } from "../src/adapter.js";

describe("Feishu adapter composition", () => {
  it("uses injected gateways, store, clock, and connection lifecycle for observable health", async () => {
    const core = { close: vi.fn() } as never;
    const feishu = { createCard: vi.fn() } as never;
    const store = { close: vi.fn() } as never;
    const connection = {
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      connected: vi.fn(() => true),
    };
    const adapter = createFeishuAdapter({
      core,
      feishu,
      store,
      connection,
      clock: {
        now: () => 123,
        setTimeout: vi.fn() as never,
        clearTimeout: vi.fn(),
      },
    });
    expect(adapter.core).toBe(core);
    await adapter.start();
    await adapter.start();
    expect(connection.start).toHaveBeenCalledTimes(1);
    adapter.inbound();
    expect(adapter.health()).toEqual({ status: "ok", connected: true, lastInboundAt: 123 });
    adapter.failed(new Error("rate limited"));
    expect(adapter.health()).toMatchObject({ status: "degraded", lastError: "rate limited" });
    await adapter.stop();
    await adapter.stop();
    expect(connection.stop).toHaveBeenCalledTimes(1);
    expect(adapter.health().status).toBe("stopped");
  });

  it("runs optional hooks with the default clock and reports non-Error failures", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(456);
    const onStart = vi.fn();
    const onStop = vi.fn();
    const adapter = createFeishuAdapter({
      core: {} as never,
      feishu: {} as never,
      store: {} as never,
      onStart,
      onStop,
    });

    expect(adapter.health()).toEqual({ status: "stopped", connected: false });
    await adapter.start();
    expect(onStart).toHaveBeenCalledOnce();
    adapter.inbound();
    adapter.failed("disconnected");
    expect(adapter.health()).toEqual({
      status: "degraded",
      connected: true,
      lastInboundAt: 456,
      lastError: "disconnected",
    });
    const callback = vi.fn();
    const timer = adapter.clock.setTimeout(callback, 10);
    await vi.advanceTimersByTimeAsync(10);
    expect(callback).toHaveBeenCalledOnce();
    adapter.clock.clearTimeout(timer);
    await adapter.stop();
    expect(onStop).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });
});
