import { EventEmitter } from "node:events";
import type { Browser } from "playwright";
import { describe, expect, it, vi } from "vitest";
import { createBrowserInstanceFactory } from "../src/browser-instance.js";

function browserInstance() {
  const events = new EventEmitter();
  let connected = true;
  const browser = Object.assign(events, {
    isConnected: () => connected,
    close: vi.fn(async () => {
      connected = false;
      events.emit("disconnected");
    }),
    disconnect: () => {
      connected = false;
      events.emit("disconnected");
    },
  });
  return browser as unknown as Browser & { disconnect: () => void };
}

describe("browser launch lifecycle", () => {
  it("shares concurrent launches and reuses the connected browser", async () => {
    const browser = browserInstance();
    const launch = vi.fn(async () => browser);
    const factory = createBrowserInstanceFactory(launch);

    const [first, concurrent, later] = await Promise.all([factory.get(), factory.get(), factory.get()]);

    expect(first).toBe(browser);
    expect(concurrent).toBe(browser);
    expect(later).toBe(browser);
    expect(launch).toHaveBeenCalledTimes(1);
    expect(factory.isConnected()).toBe(true);
  });

  it("retries a failed launch and replaces a disconnected browser", async () => {
    const recovered = browserInstance();
    const replacement = browserInstance();
    const launch = vi
      .fn()
      .mockRejectedValueOnce(new Error("missing browser"))
      .mockResolvedValueOnce(recovered)
      .mockResolvedValueOnce(replacement);
    const factory = createBrowserInstanceFactory(launch);

    await expect(factory.get()).rejects.toThrow("missing browser");
    expect(await factory.get()).toBe(recovered);
    recovered.disconnect();
    expect(factory.isConnected()).toBe(false);
    expect(await factory.get()).toBe(replacement);
    expect(launch).toHaveBeenCalledTimes(3);
  });

  it("closes only the active browser instance", async () => {
    const browser = browserInstance();
    const factory = createBrowserInstanceFactory(async () => browser);
    await factory.get();

    await factory.close();

    expect(browser.close).toHaveBeenCalledOnce();
    expect(factory.isConnected()).toBe(false);
  });
});
