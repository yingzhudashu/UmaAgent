import { describe, expect, it } from "vitest";
import { RunOrchestrator } from "../src/run-orchestrator.js";

describe("RunOrchestrator", () => {
  it("pauses a session and resumes a continuation before queued work", async () => {
    const orchestrator = new RunOrchestrator(2);
    const order: string[] = [];
    const operation = (name: string) => async () => {
      order.push(name);
    };

    orchestrator.pause("session");
    orchestrator.enqueue("session", operation("queued"));
    await Promise.resolve();
    expect(order).toEqual([]);

    orchestrator.enqueueFirst("session", operation("continuation"));
    orchestrator.resume("session");
    await orchestrator.drain();
    expect(order).toEqual(["continuation", "queued"]);
  });

  it("does not let one paused session block another session", async () => {
    const orchestrator = new RunOrchestrator(2);
    const order: string[] = [];
    orchestrator.pause("paused");
    orchestrator.enqueue("paused", async () => order.push("paused"));
    orchestrator.enqueue("active", async () => order.push("active"));
    await Promise.resolve();
    expect(order).toEqual(["active"]);
    await orchestrator.drain();
    expect(order).toEqual(["active", "paused"]);
  });
});
