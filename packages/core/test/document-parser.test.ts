import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ workers: [] as Array<{ emit: (event: string, value: unknown) => void }> }));

vi.mock("node:worker_threads", () => {
  class Worker {
    private listeners = new Map<string, (value: unknown) => void>();
    terminate = vi.fn().mockResolvedValue(0);

    constructor() {
      mocks.workers.push(this);
    }

    once(event: string, listener: (value: unknown) => void) {
      this.listeners.set(event, listener);
      return this;
    }

    emit(event: string, value: unknown) {
      this.listeners.get(event)?.(value);
    }
  }
  return { Worker };
});

import { parseDocument } from "../src/document-parser.js";

describe("parseDocument", () => {
  beforeEach(() => mocks.workers.splice(0));

  const worker = () => mocks.workers.at(-1);

  it("resolves worker text and reports parser messages", async () => {
    const success = parseDocument("document.pdf");
    worker()?.emit("message", { ok: true, text: "parsed" });
    await expect(success).resolves.toBe("parsed");

    const failure = parseDocument("document.pdf");
    worker()?.emit("message", { ok: false, error: "unsupported" });
    await expect(failure).rejects.toThrow("unsupported");

    const generic = parseDocument("document.pdf");
    worker()?.emit("message", {});
    await expect(generic).rejects.toThrow("Document parsing failed");
  });

  it("reports worker errors and abnormal exits", async () => {
    const errored = parseDocument("document.pdf");
    worker()?.emit("error", new Error("worker failed"));
    await expect(errored).rejects.toThrow("worker failed");

    const exited = parseDocument("document.pdf");
    worker()?.emit("exit", 2);
    await expect(exited).rejects.toThrow("exited with code 2");

    const clean = parseDocument("document.pdf", 100);
    worker()?.emit("exit", 0);
    worker()?.emit("message", { ok: true, text: "done" });
    await expect(clean).resolves.toBe("done");
  });

  it("terminates workers that exceed the timeout", async () => {
    vi.useFakeTimers();
    const pending = parseDocument("document.pdf", 10);
    const rejection = expect(pending).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(10);
    await rejection;
    vi.useRealTimers();
  });
});
