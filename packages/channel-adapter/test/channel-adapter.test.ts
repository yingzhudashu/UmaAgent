import { describe, expect, it, vi } from "vitest";
import { retryWithBackoff, UpdateThrottle } from "../src/index.js";

describe("channel adapter utilities", () => {
  it("retries transient failures with bounded backoff", async () => {
    vi.useFakeTimers();
    const operation = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("limited"))
      .mockResolvedValue("ok");
    const result = retryWithBackoff(operation, { attempts: 2, baseDelayMs: 10 });
    await vi.advanceTimersByTimeAsync(10);
    await expect(result).resolves.toBe("ok");
    expect(operation).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it("throttles outbound updates to the configured interval", () => {
    const throttle = new UpdateThrottle(1_000);
    expect(throttle.ready(1_000)).toBe(true);
    expect(throttle.ready(1_999)).toBe(false);
    expect(throttle.ready(2_000)).toBe(true);
  });

  it("throws the final failure after exhausting attempts", async () => {
    vi.useFakeTimers();
    const operation = vi.fn<() => Promise<never>>().mockRejectedValue(new Error("still limited"));
    const result = retryWithBackoff(operation, { attempts: 2, baseDelayMs: 10 });
    const rejected = expect(result).rejects.toThrow("still limited");
    await vi.advanceTimersByTimeAsync(10);
    await rejected;
    expect(operation).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it("stops immediately when already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const operation = vi.fn<() => Promise<never>>().mockRejectedValue("cancelled");
    await expect(retryWithBackoff(operation, { signal: controller.signal })).rejects.toBe("cancelled");
    expect(operation).toHaveBeenCalledOnce();
  });

  it("cancels a pending backoff and supports default timing", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(5_000);
    const controller = new AbortController();
    const operation = vi.fn<() => Promise<string>>().mockRejectedValue(new Error("limited"));
    const result = retryWithBackoff(operation, { signal: controller.signal });
    await Promise.resolve();
    controller.abort();
    await expect(result).rejects.toMatchObject({ name: "AbortError" });

    const throttle = new UpdateThrottle(1_000);
    expect(throttle.ready()).toBe(true);
    vi.useRealTimers();
  });
});
