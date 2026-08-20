import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ lockSync: vi.fn() }));
vi.mock("node:fs", () => ({ mkdirSync: vi.fn() }));
vi.mock("proper-lockfile", () => ({ lockSync: mocks.lockSync }));

import { StateLock } from "../src/state-lock.js";

describe("StateLock errors", () => {
  it("preserves unexpected filesystem errors", () => {
    const failure = Object.assign(new Error("permission denied"), { code: "EACCES" });
    mocks.lockSync.mockImplementation(() => {
      throw failure;
    });
    expect(() => StateLock.acquire("virtual-state")).toThrow(failure);
  });
});
