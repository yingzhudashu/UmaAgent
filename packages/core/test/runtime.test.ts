import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type FauxResponseStep,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import type { Run, SessionSnapshot } from "@uma-agent/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { UmaRuntime } from "../src/runtime.js";
import type { UmaConfig } from "../src/types.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const action of cleanup.splice(0).reverse()) await action();
});

async function runtimeWith(responses: FauxResponseStep[]): Promise<UmaRuntime> {
  const root = await mkdtemp(join(tmpdir(), "uma-runtime-"));
  const config: UmaConfig = {
    server: {
      host: "127.0.0.1",
      port: 3210,
      stateDir: join(root, "state"),
      workspaceRoots: [root],
      webOrigins: [],
      maxUploadBytes: 1024,
    },
    auth: { tokenEnv: "UMA_FAUX_TOKEN", webSessionHours: 1 },
    models: [
      {
        provider: "faux",
        id: "model",
        name: "Faux",
        api: "openai-responses",
        baseUrl: "http://127.0.0.1:9/v1",
        apiKeyEnv: "UMA_FAUX_KEY",
        reasoning: false,
        tools: true,
        vision: false,
        structuredOutput: true,
        contextWindow: 100_000,
        maxTokens: 4_096,
      },
      {
        provider: "faux",
        id: "model-2",
        name: "Faux 2",
        api: "openai-responses",
        baseUrl: "http://127.0.0.1:9/v1",
        apiKeyEnv: "UMA_FAUX_KEY",
        reasoning: false,
        tools: true,
        vision: false,
        structuredOutput: true,
        contextWindow: 100_000,
        maxTokens: 4_096,
      },
    ],
    defaultModel: { provider: "faux", id: "model" },
    defaultThinkingLevel: "off",
    skillsDirs: [],
    mcpServers: [],
    runtime: { maxParallelSessions: 2, approvalTimeoutMs: 2_000, toolTimeoutMs: 2_000 },
    roles: {
      default: { provider: "faux", id: "model" },
      reasoning: { provider: "faux", id: "model" },
      fast: { provider: "faux", id: "model" },
      vision: { provider: "faux", id: "model" },
    },
  };
  const runtime = new UmaRuntime(config);
  const faux = fauxProvider({
    provider: "faux",
    models: [
      { id: "model", contextWindow: 100_000, maxTokens: 4_096 },
      { id: "model-2", contextWindow: 100_000, maxTokens: 4_096 },
    ],
    tokensPerSecond: 100_000,
  });
  faux.setResponses(responses);
  runtime.models.models.setProvider(faux.provider);
  await runtime.start();
  cleanup.push(async () => {
    await runtime.stop();
    await rm(root, { recursive: true, force: true });
  });
  return runtime;
}

function waitForTerminal(runtime: UmaRuntime, sessionId: string, timeoutMs = 5_000): Promise<Run> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("run timed out")), timeoutMs);
    const unsubscribe = runtime.subscribe((event) => {
      if (event.sessionId !== sessionId || event.type !== "run.updated") return;
      const run = event.payload as Run;
      if (!["completed", "failed", "cancelled", "awaiting_input"].includes(run.status)) return;
      clearTimeout(timer);
      unsubscribe();
      resolve(run);
    });
  });
}

function waitForRunTerminal(runtime: UmaRuntime, runId: string): Promise<Run> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("run timed out")), 5_000);
    const unsubscribe = runtime.subscribe((event) => {
      if (event.runId !== runId || event.type !== "run.updated") return;
      const run = event.payload as Run;
      if (!["completed", "failed", "cancelled", "awaiting_input"].includes(run.status)) return;
      clearTimeout(timer);
      unsubscribe();
      resolve(run);
    });
  });
}

const decision = (route: "direct" | "clarify" | "plan") =>
  fauxAssistantMessage(
    JSON.stringify({
      taskClass: route === "plan" ? "complex" : route === "clarify" ? "standard" : "simple",
      route,
      goal: "finish the task",
      reasoningSummary: `${route} route`,
      successCriteria: ["done"],
      questions: route === "clarify" ? ["Which target?"] : [],
      steps: route === "plan" ? ["Do work", "Verify work"] : [],
    }),
  );

const classification = (taskClass: "simple" | "standard" | "complex") =>
  fauxAssistantMessage(JSON.stringify({ taskClass }));

async function runOnce(runtime: UmaRuntime): Promise<{ run: Run; snapshot: SessionSnapshot }> {
  const session = await runtime.createSession({ title: "Runtime test" });
  const terminal = waitForTerminal(runtime, session.id);
  runtime.sendMessage(session.id, { messageId: crypto.randomUUID(), text: "do it" });
  return { run: await terminal, snapshot: runtime.getSnapshot(session.id) };
}

describe("UmaRuntime preflight", () => {
  it("runs direct tasks through the Pi agent loop", async () => {
    const runtime = await runtimeWith([classification("simple"), fauxAssistantMessage("finished")]);
    const { run, snapshot } = await runOnce(runtime);
    expect(run.status, run.error).toBe("completed");
    expect(snapshot.transcript.at(-1)?.content).toBe("finished");
  });

  it("persists clarification questions without entering the agent loop", async () => {
    const runtime = await runtimeWith([classification("standard"), decision("clarify")]);
    const { run, snapshot } = await runOnce(runtime);
    expect(run.status).toBe("awaiting_input");
    expect(snapshot.transcript.at(-1)?.content).toContain("Which target?");
  });

  it("deduplicates a retried clarification continuation onto the original Run", async () => {
    const runtime = await runtimeWith([
      classification("standard"),
      decision("clarify"),
      classification("simple"),
      fauxAssistantMessage("continued"),
    ]);
    const session = await runtime.createSession({ title: "Clarification retry" });
    const firstTerminal = waitForTerminal(runtime, session.id);
    const original = runtime.sendMessage(session.id, { messageId: "question", text: "do it" });
    await firstTerminal;
    const continued = runtime.sendMessage(session.id, { messageId: "answer", text: "target A" });
    const retried = runtime.sendMessage(session.id, { messageId: "answer", text: "target A" });
    expect(continued.id).toBe(original.id);
    expect(retried.id).toBe(original.id);
    expect(runtime.getSnapshot(session.id).transcript.filter((item) => item.id === "answer")).toHaveLength(1);
  });

  it("verifies planned work and completes persisted plan steps", async () => {
    const runtime = await runtimeWith([
      classification("complex"),
      decision("plan"),
      fauxAssistantMessage("first step complete"),
      fauxAssistantMessage("planned result"),
      fauxAssistantMessage(JSON.stringify({ accepted: true, feedback: "" })),
    ]);
    const { run } = await runOnce(runtime);
    expect(run.status).toBe("completed");
    expect(run.plan.every((step) => step.status === "completed")).toBe(true);
  });

  it("waits for shell approval and resumes the same run", async () => {
    const runtime = await runtimeWith([
      classification("simple"),
      fauxAssistantMessage([fauxToolCall("shell", { command: "echo ok" })]),
      fauxAssistantMessage("approved result"),
    ]);
    const session = await runtime.createSession();
    const approval = new Promise<void>((resolve) => {
      const unsubscribe = runtime.subscribe((event) => {
        if (event.sessionId !== session.id || event.type !== "approval.requested") return;
        runtime.resolveApproval((event.payload as { id: string }).id, true);
        unsubscribe();
        resolve();
      });
    });
    const terminal = waitForTerminal(runtime, session.id);
    runtime.sendMessage(session.id, { messageId: crypto.randomUUID(), text: "run shell" });
    await approval;
    expect((await terminal).status).toBe("completed");
    expect(runtime.getSnapshot(session.id).transcript.at(-1)?.content).toBe("approved result");
  });

  it("marks the Action rejected when a tool approval is denied", async () => {
    const runtime = await runtimeWith([
      classification("simple"),
      fauxAssistantMessage([fauxToolCall("shell", { command: "echo denied" })]),
      fauxAssistantMessage("denial handled"),
    ]);
    const session = await runtime.createSession();
    const terminal = waitForTerminal(runtime, session.id);
    runtime.subscribe((event) => {
      if (event.sessionId === session.id && event.type === "approval.requested")
        runtime.resolveApproval((event.payload as { id: string }).id, false);
    });
    const run = runtime.sendMessage(session.id, { messageId: "deny-action", text: "run shell" });
    expect((await terminal).status).toBe("completed");
    expect(runtime.database.listRunActions(run.id)).toEqual([
      expect.objectContaining({ toolName: "shell", status: "rejected" }),
    ]);
  });

  it("denies pending approvals and cancels the run during shutdown", async () => {
    const runtime = await runtimeWith([
      classification("simple"),
      fauxAssistantMessage([fauxToolCall("shell", { command: "echo ok" })]),
    ]);
    const session = await runtime.createSession();
    let approvalStatus: string | undefined;
    const requested = new Promise<void>((resolve) => {
      runtime.subscribe((event) => {
        if (event.sessionId !== session.id) return;
        if (event.type === "approval.requested") resolve();
        if (event.type === "approval.resolved") approvalStatus = (event.payload as { status: string }).status;
      });
    });
    const terminal = waitForTerminal(runtime, session.id);
    runtime.sendMessage(session.id, { messageId: crypto.randomUUID(), text: "run shell" });
    await requested;
    await runtime.stop();
    expect((await terminal).status).toBe("cancelled");
    expect(approvalStatus).toBe("denied");
  });

  it("replays a prepared read Action before resuming an interrupted Run", async () => {
    const runtime = await runtimeWith([fauxAssistantMessage("resumed")]);
    const session = await runtime.createSession();
    await writeFile(join(session.workspace as string, "resume.txt"), "safe replay", "utf8");
    const messageId = crypto.randomUUID();
    const run = runtime.database.createRun(
      session.id,
      messageId,
      runtime.models.snapshot(session.model),
      session.thinkingLevel,
    ).run;
    runtime.database.insertMessage({
      id: messageId,
      sessionId: session.id,
      runId: run.id,
      role: "user",
      status: "complete",
      content: "continue",
      payload: { role: "user", content: "continue", timestamp: Date.now() },
    });
    runtime.database.updateRun(run.id, { status: "interrupted", route: "direct" });
    runtime.database.createToolCall({
      id: "read-recovery",
      runId: run.id,
      name: "read",
      args: { path: "resume.txt" },
    });
    const action = runtime.database.createRunAction({
      runId: run.id,
      toolCallId: "read-recovery",
      toolName: "read",
      toolClass: "read",
      idempotencyKey: "read-recovery-once",
      input: { path: "resume.txt" },
    });
    const replayed = new Promise<void>((resolve) => {
      const unsubscribe = runtime.subscribe((event) => {
        if (event.runId !== run.id || event.type !== "tool.completed") return;
        unsubscribe();
        resolve();
      });
    });
    runtime.resumeRun(run.id);
    await replayed;
    expect(runtime.database.getRunAction(action.id).status).toBe("completed");
    expect(runtime.getSnapshot(session.id).transcript.some((item) => item.content === "safe replay")).toBe(
      true,
    );
  });

  it("freezes the execution model when the Run is accepted", async () => {
    const runtime = await runtimeWith([classification("simple"), fauxAssistantMessage("frozen")]);
    const session = await runtime.createSession({ model: { provider: "faux", id: "model" } });
    const terminal = waitForTerminal(runtime, session.id);
    const accepted = runtime.sendMessage(session.id, { messageId: "frozen-model", text: "do it" });
    runtime.updateSession(session.id, { model: { provider: "faux", id: "model-2" } });
    expect(accepted.model.ref.id).toBe("model");
    expect((await terminal).model.ref.id).toBe("model");
    expect(runtime.database.getSession(session.id).model.id).toBe("model-2");
  });

  it("repairs invalid structured output once and then fails the provider contract", async () => {
    const runtime = await runtimeWith([
      fauxAssistantMessage("not json"),
      fauxAssistantMessage("still invalid"),
    ]);
    const { run } = await runOnce(runtime);
    expect(run.status).toBe("failed");
    expect(run.error).toContain("Provider contract error");
  });

  it("fails a plan step that reaches forty-eight Agent turns", async () => {
    const toolTurns = Array.from({ length: 48 }, () =>
      fauxAssistantMessage([fauxToolCall("list", { path: "." })]),
    );
    const runtime = await runtimeWith([classification("complex"), decision("plan"), ...toolTurns]);
    const { run } = await runOnce(runtime);
    expect(run.status).toBe("failed");
    expect(run.turnCount).toBe(48);
    expect(run.error).toContain("Plan step turn limit exceeded (48)");
  });

  it("fails a direct Run at the global four-hundred-turn limit", async () => {
    const toolTurns = Array.from({ length: 400 }, () =>
      fauxAssistantMessage([fauxToolCall("list", { path: "." })]),
    );
    const runtime = await runtimeWith(toolTurns);
    const session = await runtime.createSession();
    const terminal = waitForTerminal(runtime, session.id, 15_000);
    runtime.sendMessage(session.id, {
      messageId: "global-turn-limit",
      text: "keep listing",
      mode: "direct",
    });
    const run = await terminal;
    expect(run.status).toBe("failed");
    expect(run.turnCount).toBe(400);
    expect(run.error).toContain("Run turn limit exceeded (400)");
  }, 20_000);

  it("corrects a rejected verification once without creating a new Run", async () => {
    const runtime = await runtimeWith([
      classification("complex"),
      decision("plan"),
      fauxAssistantMessage("first step"),
      fauxAssistantMessage("initial result"),
      fauxAssistantMessage(JSON.stringify({ accepted: false, feedback: "fix it" })),
      fauxAssistantMessage("corrected result"),
    ]);
    const { run, snapshot } = await runOnce(runtime);
    expect(run.status, run.error).toBe("completed");
    expect(run.correctionCount).toBe(1);
    expect(snapshot.recentRuns.filter((item) => item.id === run.id)).toHaveLength(1);
    expect(snapshot.transcript.at(-1)?.content).toBe("corrected result");
  });

  it("cancels a queued Run by id without cancelling the active Run", async () => {
    const runtime = await runtimeWith([
      classification("simple"),
      fauxAssistantMessage([fauxToolCall("shell", { command: "echo active" })]),
      fauxAssistantMessage("active finished"),
    ]);
    const session = await runtime.createSession();
    const approvalId = new Promise<string>((resolve) => {
      const unsubscribe = runtime.subscribe((event) => {
        if (event.sessionId !== session.id || event.type !== "approval.requested") return;
        unsubscribe();
        resolve((event.payload as { id: string }).id);
      });
    });
    const active = runtime.sendMessage(session.id, { messageId: "active", text: "run shell" });
    const activeTerminal = waitForRunTerminal(runtime, active.id);
    const approval = await approvalId;
    const queued = runtime.sendMessage(session.id, { messageId: "queued", text: "later" });
    expect(runtime.cancelRun(queued.id).status).toBe("cancelled");
    runtime.resolveApproval(approval, true);
    expect(await activeTerminal).toMatchObject({ id: active.id, status: "completed" });
    expect(runtime.database.getRun(queued.id).status).toBe("cancelled");
  });

  it("acknowledges an uncertain side effect with read-only reconciliation", async () => {
    const runtime = await runtimeWith([fauxAssistantMessage("reconciliation complete")]);
    const session = await runtime.createSession();
    const messageId = "uncertain-message";
    const run = runtime.database.createRun(
      session.id,
      messageId,
      runtime.models.snapshot(session.model),
      session.thinkingLevel,
    ).run;
    runtime.database.insertMessage({
      id: messageId,
      sessionId: session.id,
      runId: run.id,
      role: "user",
      status: "complete",
      content: "perform side effect",
    });
    runtime.database.updateRun(run.id, { status: "interrupted", route: "direct" });
    runtime.database.createCheckpoint({
      runId: run.id,
      phase: "tool",
      turnCount: 1,
      lastMessageSequence: 1,
      safeToResume: true,
    });
    const action = runtime.database.createRunAction({
      runId: run.id,
      toolCallId: "shell-uncertain",
      toolName: "shell",
      toolClass: "shell",
      idempotencyKey: "shell-uncertain-once",
      input: { command: "external-effect" },
    });
    runtime.database.updateRunAction(action.id, { status: "uncertain" });
    const decided = await runtime.decideRunAction(run.id, action.id, "acknowledge");
    expect(decided.status).toBe("acknowledged");
    expect(runtime.database.getRun(run.id).resume?.state).toBe("available");
    expect(runtime.getSnapshot(session.id).transcript.at(-1)?.content).toBe("reconciliation complete");
  });
});
