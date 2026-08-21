import { describe, expect, it } from "vitest";
import { ToolLoopGuard } from "../src/tool-loop-guard.js";

describe("ToolLoopGuard", () => {
  it("warns on repeated calls and fails the sixth unique attempt", () => {
    const guard = new ToolLoopGuard();
    expect(guard.check("read", { path: "a" }, "1")).toBeUndefined();
    expect(guard.check("read", { path: "a" }, "2")).toBeUndefined();
    expect(guard.check("read", { path: "a" }, "3")).toMatchObject({
      level: "warning",
      pattern: "repeat",
      count: 3,
    });
    guard.check("read", { path: "a" }, "4");
    guard.check("read", { path: "a" }, "5");
    expect(guard.check("read", { path: "a" }, "6")).toMatchObject({
      level: "critical",
      pattern: "repeat",
      count: 6,
    });
    expect(guard.check("read", { path: "a" }, "6")).toBeUndefined();
  });

  it("detects no-progress polling and ping-pong sequences", () => {
    const polling = new ToolLoopGuard();
    for (const key of ["1", "2", "3"]) {
      polling.check("status", { id: "job" }, key);
      polling.recordResult(key, { status: "pending" });
    }
    expect(polling.check("status", { id: "job" }, "4")).toMatchObject({
      level: "warning",
      pattern: "no_progress",
    });

    const pingPong = new ToolLoopGuard();
    let decision: ReturnType<ToolLoopGuard["check"]>;
    for (let index = 0; index < 6; index++)
      decision = pingPong.check(index % 2 ? "second" : "first", {}, String(index));
    expect(decision).toMatchObject({ level: "warning", pattern: "ping_pong", count: 3 });
  });
});
