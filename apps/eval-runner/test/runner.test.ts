import type { Run, SessionSnapshot } from "@uma-agent/protocol";
import { describe, expect, it } from "vitest";
import { type EvalClient, evaluateSuite, junitReport } from "../src/runner.js";

describe("evaluation runner", () => {
  it("evaluates only public terminal state and transcript output", async () => {
    const run = { id: "run", status: "completed" } as Run;
    const client: EvalClient = {
      async createSession() {
        return { id: "session" };
      },
      async sendMessage() {
        return { runId: run.id };
      },
      async waitForRun() {
        return run;
      },
      async getSession() {
        return {
          transcript: [{ runId: run.id, role: "assistant", content: "expected answer" }],
        } as SessionSnapshot;
      },
      async listAudit() {
        return [];
      },
      async listRunActions() {
        return [];
      },
      async getSessionEvents() {
        return { events: [] } as never;
      },
    };
    await expect(
      evaluateSuite(client, [
        {
          name: "direct",
          prompt: "answer",
          mode: "ask",
          expectedStatus: "completed",
          expectedIncludes: "expected",
        },
      ]),
    ).resolves.toEqual([expect.objectContaining({ name: "direct", passed: true, status: "completed" })]);
  });

  it("checks route, tool, approval, durable events, and mismatched outcomes", async () => {
    const run = { id: "run-rich", status: "completed", route: "plan" } as Run;
    const client: EvalClient = {
      async createSession() {
        return { id: "session" };
      },
      async sendMessage() {
        return { runId: run.id };
      },
      async waitForRun() {
        return run;
      },
      async getSession() {
        return {
          transcript: [{ runId: run.id, role: "assistant", content: "tool result" }],
        } as SessionSnapshot;
      },
      async listAudit() {
        return [{ kind: "tool", name: "web_search" }] as never;
      },
      async listRunActions() {
        return [{ status: "completed" }] as never;
      },
      async getSessionEvents() {
        return { events: [{ type: "run.completed" }] } as never;
      },
    };

    await expect(
      evaluateSuite(client, [
        {
          name: "rich pass",
          prompt: "research",
          mode: "plan",
          expectedStatus: "completed",
          expectedIncludes: "tool",
          expectedRoute: "plan",
          expectedTool: "web_search",
          expectedApproval: true,
          expectedDurableEvent: "run.completed",
        },
        {
          name: "expected mismatch",
          prompt: "research",
          expectedStatus: "failed",
          expectedApproval: false,
        },
      ]),
    ).resolves.toEqual([
      expect.objectContaining({ name: "rich pass", passed: true }),
      expect.objectContaining({
        name: "expected mismatch",
        passed: false,
        error: "Observed result did not match the expected public outcome",
      }),
    ]);
  });

  it("records Error and non-Error client failures without aborting the suite", async () => {
    let calls = 0;
    const client = {
      async createSession() {
        calls++;
        if (calls === 1) throw new Error("core unavailable");
        throw "connection lost";
      },
    } as unknown as EvalClient;
    await expect(
      evaluateSuite(client, [
        { name: "error", prompt: "one", mode: "ask", expectedStatus: "completed" },
        { name: "string", prompt: "two", mode: "ask", expectedStatus: "completed" },
      ]),
    ).resolves.toEqual([
      expect.objectContaining({
        name: "error",
        category: "regression",
        passed: false,
        error: "core unavailable",
      }),
      expect.objectContaining({
        name: "string",
        category: "regression",
        passed: false,
        error: "connection lost",
      }),
    ]);
  });

  it("renders escaped JUnit with a single failure count", () => {
    expect(
      junitReport([
        { name: 'pass & "quote"', category: "regression", durationMs: 1, passed: true },
        { name: "fail <case>", category: "security", durationMs: 1, passed: false, error: 'bad > "value"' },
      ]),
    ).toContain('<testsuite name="UmaAgent Faux" tests="2" failures="1">');
    expect(
      junitReport([
        { name: "fail <case>", category: "security", durationMs: 1, passed: false, error: 'bad > "value"' },
      ]),
    ).toContain(
      '<testcase name="fail &lt;case&gt;"><failure message="bad &gt; &quot;value&quot;"/></testcase>',
    );
  });
});
