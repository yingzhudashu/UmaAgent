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
});
