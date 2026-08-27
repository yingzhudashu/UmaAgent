import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
    auth: { webSessionHours: 1 },
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
  const now = Date.now();
  runtime.database.db
    .prepare("INSERT OR IGNORE INTO users(id,role,status,created_at,updated_at) VALUES(?,?,?,?,?)")
    .run("test-user", "user", "active", now, now);
  const createSession = runtime.createSession.bind(runtime);
  runtime.createSession = ((input = {}) => createSession(input, "test-user")) as UmaRuntime["createSession"];
  cleanup.push(async () => {
    await runtime.stop();
    await rm(root, { recursive: true, force: true });
  });
  return runtime;
}

function waitForTerminal(runtime: UmaRuntime, sessionId: string, timeoutMs = 15_000): Promise<Run> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("run timed out")), timeoutMs);
    const unsubscribe = runtime.subscribe((event) => {
      if (event.sessionId !== sessionId || event.type !== "run.updated") return;
      const run = event.payload as Run;
      if (run.status === "awaiting_confirmation") {
        runtime.confirmPlan(run.id);
        return;
      }
      if (!["completed", "failed", "cancelled", "awaiting_input"].includes(run.status)) return;
      clearTimeout(timer);
      unsubscribe();
      resolve(run);
    });
  });
}

function waitForRunTerminal(runtime: UmaRuntime, runId: string): Promise<Run> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("run timed out")), 15_000);
    const unsubscribe = runtime.subscribe((event) => {
      if (event.runId !== runId || event.type !== "run.updated") return;
      const run = event.payload as Run;
      if (run.status === "awaiting_confirmation") {
        runtime.confirmPlan(run.id);
        return;
      }
      if (!["completed", "failed", "cancelled", "awaiting_input"].includes(run.status)) return;
      clearTimeout(timer);
      unsubscribe();
      resolve(run);
    });
  });
}

const decision = (kind: "clarify" | "plan" = "plan", assumptions: string[] = []) =>
  fauxAssistantMessage(
    JSON.stringify({
      taskClass: kind === "plan" ? "complex" : "standard",
      goal: "finish the task",
      reasoningSummary: `${kind} preflight`,
      successCriteria: ["done"],
      assumptions,
      questions: kind === "clarify" ? ["Which target?"] : [],
      steps: kind === "plan" ? ["Do work", "Verify work"] : [],
    }),
  );

const classification = (taskClass: "simple" | "standard" | "complex") =>
  fauxAssistantMessage(JSON.stringify({ taskClass }));

async function runOnce(
  runtime: UmaRuntime,
  mode: "agent" | "plan" = "agent",
): Promise<{ run: Run; snapshot: SessionSnapshot }> {
  const session = await runtime.createSession({ title: "Runtime test" });
  const terminal = waitForTerminal(runtime, session.id);
  runtime.sendMessage(session.id, { messageId: crypto.randomUUID(), text: "do it", mode });
  return { run: await terminal, snapshot: runtime.getSnapshot(session.id) };
}

describe("UmaRuntime preflight", () => {
  it("runs direct tasks through the Pi agent loop", async () => {
    const runtime = await runtimeWith([classification("simple"), fauxAssistantMessage("finished")]);
    const { run, snapshot } = await runOnce(runtime);
    expect(run.status, run.error).toBe("completed");
    expect(snapshot.transcript.at(-1)?.content).toBe("finished");
  });

  it("continues the HTTP trace and records queue wait before execution", async () => {
    const runtime = await runtimeWith([classification("simple"), fauxAssistantMessage("finished")]);
    const session = await runtime.createSession();
    const terminal = waitForTerminal(runtime, session.id);
    const run = runtime.sendMessage(
      session.id,
      { messageId: "traced-message", text: "do it", mode: "agent" },
      {
        traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
        spanId: "00f067aa0ba902b7",
        traceFlags: 1,
      },
    );
    expect((await terminal).status).toBe("completed");
    expect(runtime.listTrace({ runId: run.id }).spans).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
          parentSpanId: "00f067aa0ba902b7",
          name: "run",
        }),
        expect.objectContaining({
          traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
          name: "queue.wait",
          kind: "queue",
          status: "ok",
        }),
      ]),
    );
  });

  it("persists and discloses non-sensitive execution assumptions", async () => {
    const runtime = await runtimeWith([
      classification("standard"),
      decision("plan", ["Use the existing workspace as the target"]),
      fauxAssistantMessage("finished with the selected target"),
      fauxAssistantMessage("[]"),
    ]);
    const { run, snapshot } = await runOnce(runtime);
    expect(run.status, run.error).toBe("completed");
    expect(run.assumptions).toEqual(["Use the existing workspace as the target"]);
    expect(snapshot.transcript.at(-1)?.content).toContain("执行假设：");
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
    const original = runtime.sendMessage(session.id, { messageId: "question", text: "do it", mode: "agent" });
    await firstTerminal;
    const continued = runtime.sendMessage(session.id, {
      messageId: "answer",
      text: "target A",
      mode: "agent",
    });
    const retried = runtime.sendMessage(session.id, { messageId: "answer", text: "target A", mode: "agent" });
    expect(continued.id).toBe(original.id);
    expect(retried.id).toBe(original.id);
    expect(runtime.getSnapshot(session.id).transcript.filter((item) => item.id === "answer")).toHaveLength(1);
  });

  it("shares prior file context with clarification continuation without duplicating the answer", async () => {
    let continuationContext = "";
    const runtime = await runtimeWith([
      classification("standard"),
      decision("clarify"),
      (context) => {
        continuationContext = JSON.stringify(context.messages);
        return classification("simple");
      },
      fauxAssistantMessage("The title in report.docx is Quarterly Results"),
    ]);
    const session = await runtime.createSession({ title: "File clarification" });
    const firstTerminal = waitForTerminal(runtime, session.id);
    const original = runtime.sendMessage(session.id, {
      messageId: "file-question",
      text: "请查看 report.docx，之后我还会问这个文件",
      mode: "agent",
    });
    expect((await firstTerminal).status).toBe("awaiting_input");

    const continuedTerminal = waitForRunTerminal(runtime, original.id);
    const continued = runtime.sendMessage(session.id, {
      messageId: "file-answer",
      text: "就是刚才提到的那个文件",
      mode: "agent",
    });
    expect(continued.id).toBe(original.id);
    expect((await continuedTerminal).status).toBe("completed");
    expect(continuationContext).toContain("report.docx");
    expect(continuationContext).toContain("Which target?");
    expect(continuationContext.match(/就是刚才提到的那个文件/g)).toHaveLength(1);
  });

  it("verifies planned work and completes persisted plan steps", async () => {
    const runtime = await runtimeWith([
      classification("complex"),
      decision("plan"),
      fauxAssistantMessage("first step complete"),
      fauxAssistantMessage("planned result"),
      fauxAssistantMessage(JSON.stringify({ accepted: true, feedback: "" })),
    ]);
    const { run } = await runOnce(runtime, "plan");
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
    runtime.sendMessage(session.id, { messageId: crypto.randomUUID(), text: "run shell", mode: "agent" });
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
    const run = runtime.sendMessage(session.id, {
      messageId: "deny-action",
      text: "run shell",
      mode: "agent",
    });
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
    runtime.sendMessage(session.id, { messageId: crypto.randomUUID(), text: "run shell", mode: "agent" });
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
      "agent",
      "agent",
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
    const accepted = runtime.sendMessage(session.id, {
      messageId: "frozen-model",
      text: "do it",
      mode: "agent",
    });
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
    const toolTurns = Array.from({ length: 48 }, (_, index) =>
      fauxAssistantMessage([fauxToolCall("list", { path: String(index) })]),
    );
    const runtime = await runtimeWith([classification("complex"), decision("plan"), ...toolTurns]);
    const { run } = await runOnce(runtime, "plan");
    expect(run.status).toBe("failed");
    expect(run.turnCount).toBe(48);
    expect(run.error).toContain("Plan step turn limit exceeded (48)");
  });

  it("fails a direct Run at the global four-hundred-turn limit", async () => {
    const toolTurns = Array.from({ length: 400 }, (_, index) =>
      fauxAssistantMessage([fauxToolCall("list", { path: String(index) })]),
    );
    const runtime = await runtimeWith([classification("simple"), ...toolTurns]);
    const session = await runtime.createSession();
    const terminal = waitForTerminal(runtime, session.id, 60_000);
    runtime.sendMessage(session.id, {
      messageId: "global-turn-limit",
      text: "keep listing",
      mode: "agent",
    });
    const run = await terminal;
    expect(run.status).toBe("failed");
    expect(run.turnCount).toBe(400);
    expect(run.error).toContain("Run turn limit exceeded (400)");
  }, 60_000);

  it("persists a warning and fails a Run after six repeated tool calls", async () => {
    const runtime = await runtimeWith([
      classification("simple"),
      ...Array.from({ length: 6 }, () => fauxAssistantMessage([fauxToolCall("list", { path: "." })])),
    ]);
    const session = await runtime.createSession();
    const terminal = waitForTerminal(runtime, session.id);
    runtime.sendMessage(session.id, {
      messageId: "repeated-tool-loop",
      text: "keep polling the same directory",
      mode: "agent",
    });
    const result = await terminal;
    expect(result.status).toBe("failed");
    expect(result.error).toBe("tool_loop_detected");
    const warnings = runtime
      .listSessionEvents(session.id, 0, 1_000)
      .events.filter((event) => event.type === "run.loop_warning");
    expect(warnings).toEqual([
      expect.objectContaining({ payload: expect.objectContaining({ level: "warning" }) }),
      expect.objectContaining({ payload: expect.objectContaining({ level: "critical" }) }),
    ]);
  });

  it("corrects a rejected verification once without creating a new Run", async () => {
    const runtime = await runtimeWith([
      classification("complex"),
      decision("plan"),
      fauxAssistantMessage("first step"),
      fauxAssistantMessage("initial result"),
      fauxAssistantMessage(JSON.stringify({ accepted: false, feedback: "fix it" })),
      fauxAssistantMessage("corrected result"),
    ]);
    const { run, snapshot } = await runOnce(runtime, "plan");
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
    const active = runtime.sendMessage(session.id, { messageId: "active", text: "run shell", mode: "agent" });
    const activeTerminal = waitForRunTerminal(runtime, active.id);
    const approval = await approvalId;
    const queued = runtime.sendMessage(session.id, { messageId: "queued", text: "later", mode: "agent" });
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
      "agent",
      "agent",
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

  it("enforces lifecycle, session mode, model, and new-run validation", async () => {
    const runtime = await runtimeWith([]);
    await expect(runtime.start()).rejects.toThrow("already started");
    await expect(
      runtime.createSession({ workspace: runtime.config.server.workspaceRoots[0] }),
    ).resolves.toBeDefined();
    await expect(runtime.createSession({ model: { provider: "missing", id: "missing" } })).rejects.toThrow();
    const session = await runtime.createSession();
    const workspace = await runtime.createSession();
    expect(runtime.health()).toMatchObject({ started: true, activeRuns: 0 });
    await expect(runtime.createTask("   ", undefined, undefined, "test-user")).rejects.toThrow("prompt");
    const task = await runtime.createTask(
      "background work",
      workspace.id,
      {
        type: "schedule",
        scheduleId: crypto.randomUUID(),
        scheduleRunId: crypto.randomUUID(),
      },
      "test-user",
    );
    expect(task).toMatchObject({
      parentSessionId: workspace.id,
      source: { type: "schedule" },
    });
    expect(runtime.database.getSession(task.sessionId)).toMatchObject({
      workspace: workspace.workspace,
      model: workspace.model,
    });
    expect(() => runtime.cancel(session.id)).toThrow("no active run");
    await runtime.stop();
    expect(() =>
      runtime.sendMessage(session.id, { messageId: "stopped", text: "no", mode: "agent" }),
    ).toThrow("not accepting");
    expect(() => runtime.sendCommand(workspace.id, "pwd")).toThrow("not accepting");
    expect(() => runtime.reviewMessage("missing")).toThrow("not accepting");
    await expect(runtime.start()).rejects.toThrow("cannot restart");
  });

  it("validates attachments, sanitizes names, and selects the vision role", async () => {
    const runtime = await runtimeWith([]);
    const session = await runtime.createSession();
    await expect(
      runtime.addAttachment({ name: "large.txt", mimeType: "text/plain", data: new Uint8Array(1_025) }),
    ).rejects.toThrow("size limit");
    await expect(
      runtime.addAttachment({
        sessionId: "missing",
        name: "note.txt",
        mimeType: "text/plain",
        data: new Uint8Array(),
      }),
    ).rejects.toThrow("not found");
    const attachment = await runtime.addAttachment({
      sessionId: session.id,
      name: "../../unsafe name.txt",
      mimeType: "image/png",
      data: new Uint8Array([1]),
    });
    expect(attachment.name).toBe(".._.._unsafe_name.txt");
    expect(() =>
      runtime.sendMessage(session.id, {
        messageId: "image",
        text: "inspect",
        mode: "agent",
        attachmentIds: [attachment.id],
      }),
    ).toThrow("does not support image");
  });

  it("rejects duplicate message ownership and invalid clarification continuations", async () => {
    const runtime = await runtimeWith([]);
    const first = await runtime.createSession();
    const second = await runtime.createSession();
    runtime.database.insertMessage({
      id: "standalone",
      sessionId: first.id,
      role: "user",
      status: "complete",
      content: "standalone",
    });
    expect(() =>
      runtime.sendMessage(first.id, { messageId: "standalone", text: "again", mode: "agent" }),
    ).toThrow("non-run");
    const created = runtime.database.createRun(
      first.id,
      "owned",
      runtime.models.snapshot(first.model),
      first.thinkingLevel,
      "agent",
      "agent",
    ).run;
    runtime.database.insertMessage({
      id: "owned",
      sessionId: first.id,
      runId: created.id,
      role: "user",
      status: "complete",
      content: "owned",
    });
    expect(() =>
      runtime.sendMessage(second.id, { messageId: "owned", text: "again", mode: "agent" }),
    ).toThrow("another session");
    runtime.database.updateRun(created.id, { status: "awaiting_input", clarificationCount: 3 });
    expect(() =>
      runtime.sendMessage(first.id, { messageId: "fourth", text: "answer", mode: "agent" }),
    ).toThrow("Clarification limit");
    expect(runtime.database.getRun(created.id)).toMatchObject({ status: "failed" });
  });

  it("validates memory writes and handles global facts without session events", async () => {
    const runtime = await runtimeWith([]);
    const session = await runtime.createSession();
    expect(() => runtime.createMemoryFact(session.id, "session", "   ")).toThrow("required");
    expect(() =>
      runtime.createMemoryFact(session.id, "session", "OPENAI_API_KEY=super-secret-value"),
    ).toThrow("secret");
    const global = runtime.database.addMemoryFact({
      scope: "global",
      key: "preference.global",
      value: "global preference",
      category: "preference",
      confidence: 0.8,
      status: "candidate",
    });
    expect(runtime.reviewMemoryFact(global.id, "active")).toMatchObject({ status: "active" });
    runtime.deleteMemoryFact(global.id);
    expect(() => runtime.database.getMemoryFact(global.id)).toThrow("not found");
    expect(runtime.listMemoryFacts()).toEqual([]);
  });

  it("makes cancellation, approval and Action decisions idempotent and validates ownership", async () => {
    const runtime = await runtimeWith([]);
    const session = await runtime.createSession();
    const other = await runtime.createSession();
    const createRun = (owner: typeof session, messageId: string) => {
      const run = runtime.database.createRun(
        owner.id,
        messageId,
        runtime.models.snapshot(owner.model),
        owner.thinkingLevel,
        "agent",
        "agent",
      ).run;
      runtime.database.insertMessage({
        id: messageId,
        sessionId: owner.id,
        runId: run.id,
        role: "user",
        status: "complete",
        content: messageId,
      });
      return run;
    };
    const run = createRun(session, "action-run");
    const otherRun = createRun(other, "other-run");
    runtime.database.updateRun(run.id, { status: "interrupted" });
    expect(runtime.resumeRun(run.id).status).toBe("queued");
    const action = runtime.database.createRunAction({
      runId: run.id,
      toolCallId: "call",
      toolName: "shell",
      toolClass: "shell",
      idempotencyKey: "once",
    });
    runtime.database.updateRun(run.id, { status: "interrupted" });
    expect(() => runtime.resumeRun(run.id)).toThrow("requiring confirmation");
    await expect(runtime.decideRunAction(otherRun.id, action.id, "reject")).rejects.toThrow(
      "does not belong",
    );
    await expect(runtime.decideRunAction(run.id, action.id, "acknowledge")).rejects.toThrow("Only uncertain");
    runtime.database.updateRunAction(action.id, { status: "uncertain" });
    await expect(runtime.decideRunAction(run.id, action.id, "approve")).rejects.toThrow("Only prepared");
    expect(await runtime.decideRunAction(run.id, action.id, "reject")).toMatchObject({
      status: "rejected",
    });
    expect(await runtime.decideRunAction(run.id, action.id, "reject")).toMatchObject({
      status: "rejected",
    });
    expect(runtime.cancelRun(run.id).status).toBe("failed");

    const approval = runtime.database.createApproval({
      sessionId: other.id,
      runId: otherRun.id,
      toolCallId: "approval-call",
      toolName: "shell",
      args: {},
    });
    expect(runtime.resolveApproval(approval.id, true)).toMatchObject({ status: "approved" });
    expect(runtime.resolveApproval(approval.id, false)).toMatchObject({ status: "approved" });
  });

  it("covers public resource facades and terminal background-task cancellation", async () => {
    const runtime = await runtimeWith([]);
    const session = await runtime.createSession();
    const run = runtime.database.createRun(
      session.id,
      "resource-run",
      runtime.models.snapshot(session.model),
      session.thinkingLevel,
      "agent",
      "agent",
    ).run;
    runtime.database.insertMessage({
      id: "resource-run",
      sessionId: session.id,
      runId: run.id,
      role: "user",
      status: "complete",
      content: "resource",
    });
    runtime.database.createCheckpoint({
      runId: run.id,
      phase: "preflight",
      turnCount: 0,
      lastMessageSequence: 1,
      safeToResume: true,
    });
    runtime.database.createBackgroundTask({ id: "done-task", sessionId: session.id, prompt: "done" });
    runtime.database.updateBackgroundTask("done-task", { status: "completed", result: "done" });
    expect(runtime.cancelTask("done-task")).toMatchObject({ status: "completed" });
    expect(runtime.getTask("done-task")).toMatchObject({ id: "done-task" });
    expect(runtime.listTasks()).toHaveLength(1);
    expect(runtime.listSessions()).toHaveLength(1);
    expect(runtime.listModels()).toHaveLength(2);
    expect(runtime.getRun(run.id)).toMatchObject({ id: run.id });
    expect(runtime.listRunActions(run.id)).toEqual([]);
    expect(runtime.listRunCheckpoints(run.id)).toHaveLength(1);
    expect(runtime.listSessionEvents(session.id, 0).sessionId).toBe(session.id);
    expect(runtime.listSessionHistory(session.id).sessionId).toBe(session.id);
    expect(runtime.audit(run.id)).toEqual([]);
    await expect(runtime.compactSession(session.id)).rejects.toThrow("insufficient history");
    runtime.updateSession(session.id, { title: "updated", thinkingLevel: "high" });
    expect(runtime.getSnapshot(session.id).session).toMatchObject({
      title: "updated",
      thinkingLevel: "high",
    });
    runtime.deleteSession(session.id);
    expect(runtime.listSessions()).toEqual([]);
  });

  it("extracts high-confidence active memories, lower-confidence candidates, and skips secrets", async () => {
    const runtime = await runtimeWith([
      classification("simple"),
      fauxAssistantMessage("finished with preferences"),
      fauxAssistantMessage(
        JSON.stringify([
          {
            key: "preference.language",
            value: "Prefers TypeScript",
            category: "preference",
            evidence: "Prefers TypeScript",
            confidence: 0.99,
            scope: "global",
          },
          {
            key: "preference.concise",
            value: "May prefer concise output",
            category: "preference",
            evidence: "May prefer concise output",
            confidence: 0.7,
            scope: "session",
          },
          {
            key: "secret.api",
            value: "OPENAI_API_KEY=secret-value",
            category: "secret",
            evidence: "secret",
            confidence: 1,
            scope: "global",
          },
          {
            key: "empty",
            value: "   ",
            category: "other",
            evidence: "empty",
            confidence: 1,
            scope: "session",
          },
        ]),
      ),
    ]);
    const { run } = await runOnce(runtime);
    expect(run.status, run.error).toBe("completed");
    expect(runtime.listMemoryFacts()).toEqual([
      expect.objectContaining({ value: "May prefer concise output", status: "candidate" }),
      expect.objectContaining({ value: "Prefers TypeScript", status: "active" }),
    ]);
  });

  it("repairs malformed memory extraction once and preserves provider-contract failures", async () => {
    const repaired = await runtimeWith([
      classification("simple"),
      fauxAssistantMessage("finished"),
      fauxAssistantMessage("not-json"),
      fauxAssistantMessage(
        JSON.stringify([
          {
            key: "environment.os",
            value: "Uses Windows",
            category: "environment",
            evidence: "Uses Windows",
            confidence: 1,
            scope: "global",
          },
        ]),
      ),
    ]);
    expect((await runOnce(repaired)).run.status).toBe("completed");
    expect(repaired.listMemoryFacts()).toEqual([
      expect.objectContaining({ value: "Uses Windows", status: "active" }),
    ]);

    const failed = await runtimeWith([
      classification("simple"),
      fauxAssistantMessage("finished"),
      fauxAssistantMessage("not-json"),
      fauxAssistantMessage("still-not-json"),
    ]);
    const terminal = (await runOnce(failed)).run;
    expect(terminal.status).toBe("failed");
    expect(terminal.error).toContain("memory extraction");
  });

  it("covers explicit direct and plan routing contract guards", async () => {
    const direct = await runtimeWith([
      classification("simple"),
      fauxAssistantMessage("direct result"),
      fauxAssistantMessage("[]"),
    ]);
    const directSession = await direct.createSession();
    const directTerminal = waitForTerminal(direct, directSession.id);
    direct.sendMessage(directSession.id, { messageId: "direct-mode", text: "answer", mode: "agent" });
    expect((await directTerminal).status).toBe("completed");

    const complexDirect = await runtimeWith([
      fauxAssistantMessage(
        JSON.stringify({
          taskClass: "complex",
          goal: "complex",
          reasoningSummary: "mode decides route",
          successCriteria: ["done"],
          assumptions: [],
          questions: [],
          steps: ["complete the task"],
        }),
      ),
      fauxAssistantMessage("planned result"),
      fauxAssistantMessage(JSON.stringify({ accepted: true, feedback: "" })),
    ]);
    const complexSession = await complexDirect.createSession();
    const complexTerminal = waitForTerminal(complexDirect, complexSession.id);
    complexDirect.sendMessage(complexSession.id, {
      messageId: "complex-direct",
      text: "complex",
      mode: "plan",
    });
    expect(await complexTerminal).toMatchObject({ status: "completed", route: "plan" });

    const clarifyWithoutQuestions = await runtimeWith([
      classification("standard"),
      fauxAssistantMessage(
        JSON.stringify({
          taskClass: "standard",
          goal: "goal",
          reasoningSummary: "missing question",
          successCriteria: ["done"],
          assumptions: [],
          questions: [],
          steps: [],
        }),
      ),
      fauxAssistantMessage("completed"),
      fauxAssistantMessage("[]"),
    ]);
    const clarifySession = await clarifyWithoutQuestions.createSession();
    const clarifyTerminal = waitForTerminal(clarifyWithoutQuestions, clarifySession.id);
    clarifyWithoutQuestions.sendMessage(clarifySession.id, {
      messageId: "bad-clarify",
      text: "question",
      mode: "agent",
    });
    expect(await clarifyTerminal).toMatchObject({ status: "completed", route: "direct" });
  });

  it("surfaces provider response errors without adding a second retry loop", async () => {
    const transient = fauxAssistantMessage("");
    transient.stopReason = "error";
    transient.errorMessage = "HTTP 429 rate limit";
    const runtime = await runtimeWith([transient]);
    const result = (await runOnce(runtime)).run;
    expect(result.status).toBe("failed");
    expect(result.error).toContain("HTTP 429 rate limit");
  });

  it("implements every internal schedule-manage operation and validates required fields", async () => {
    const runtime = await runtimeWith([]);
    const manage = (params: Record<string, unknown>) =>
      (
        runtime as unknown as {
          manageScheduleTool(value: Record<string, unknown>, ownerId: string): unknown;
        }
      ).manageScheduleTool(params, "test-user");
    expect(manage({ operation: "list" })).toEqual([]);
    for (const input of [
      { kind: "once", at: Date.now() + 60_000 },
      { kind: "interval", everyMs: 60_000 },
      { kind: "cron", expression: "0 * * * *", timezone: "UTC" },
    ]) {
      const created = manage({ operation: "create", name: "job", prompt: "do it", ...input }) as {
        id: string;
      };
      expect(manage({ operation: "update", id: created.id, name: "updated", enabled: false })).toMatchObject({
        id: created.id,
        name: "updated",
        enabled: false,
      });
      expect(manage({ operation: "delete", id: created.id })).toEqual({ deleted: created.id });
    }
    const runnable = manage({
      operation: "create",
      name: "runnable",
      prompt: "do it",
      kind: "once",
      at: Date.now() + 60_000,
    }) as { id: string };
    const running = manage({ operation: "run", id: runnable.id }) as { id: string; scheduledTaskId: string };
    expect(running).toMatchObject({
      scheduledTaskId: runnable.id,
    });
    for (let attempt = 0; attempt < 100; attempt++) {
      const status = runtime.database.getScheduledTaskRun(running.id).status;
      if (["completed", "failed", "cancelled"].includes(status)) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(() => manage({ operation: "run" })).toThrow("requires id");
    expect(() => manage({ operation: "delete" })).toThrow("requires id");
    expect(() => manage({ operation: "create", name: "bad", prompt: "bad" })).toThrow("complete schedule");
    expect(() => manage({ operation: "update" })).toThrow("requires id");
    expect(() => manage({ operation: "unknown" })).toThrow("Unsupported");
  });

  it("executes an exact Core shell command only after approval", async () => {
    const runtime = await runtimeWith([]);
    const session = await runtime.createSession({ title: "Command" });
    const approval = new Promise<string>((resolve) => {
      const unsubscribe = runtime.subscribe((event) => {
        if (event.sessionId !== session.id || event.type !== "approval.requested") return;
        unsubscribe();
        resolve((event.payload as { id: string }).id);
      });
    });
    const run = runtime.sendCommand(
      session.id,
      `node -e "process.stdout.write('exact-command-output')"`,
      "command-message",
    );
    const id = await approval;
    expect(runtime.database.getRun(run.id).kind).toBe("command");
    runtime.resolveApproval(id, true);
    const terminal = await waitForRunTerminal(runtime, run.id);
    expect(terminal.status, terminal.error).toBe("completed");
    expect(runtime.getSnapshot(session.id).transcript.at(-1)?.content).toContain("exact-command-output");
    expect(runtime.listRunActions(run.id)).toEqual([
      expect.objectContaining({ toolName: "shell", status: "completed" }),
    ]);
  });

  it("reviews and improves an immutable answer through tool-free quality Runs", async () => {
    const runtime = await runtimeWith([
      fauxAssistantMessage(
        JSON.stringify({
          passed: false,
          issues: [{ type: "omission", description: "Missing one detail" }],
          suggestions: ["Add the missing detail"],
        }),
      ),
      fauxAssistantMessage(JSON.stringify({ improvedAnswer: "Answer with the missing detail" })),
      fauxAssistantMessage(JSON.stringify({ improvedAnswer: "Reset improvement from original" })),
      fauxAssistantMessage(JSON.stringify({ passed: true, issues: [], suggestions: [] })),
    ]);
    const session = await runtime.createSession();
    const source = runtime.database.createRun(
      session.id,
      "quality-question",
      runtime.models.snapshot(session.model),
      session.thinkingLevel,
      "agent",
      "agent",
    ).run;
    runtime.database.insertMessage({
      id: "quality-question",
      sessionId: session.id,
      runId: source.id,
      role: "user",
      status: "complete",
      content: "What is the answer?",
    });
    runtime.database.insertMessage({
      id: "quality-answer",
      sessionId: session.id,
      runId: source.id,
      role: "assistant",
      status: "complete",
      content: "Original answer",
    });
    runtime.database.updateRun(source.id, { status: "completed" });
    const review = runtime.reviewMessage("quality-answer", "Check completeness");
    expect((await waitForRunTerminal(runtime, review.id)).status).toBe("completed");
    expect(runtime.listTrace({ runId: review.id }).spans).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "review", kind: "run", status: "ok", runId: review.id }),
        expect.objectContaining({ name: "model.review", kind: "model", status: "ok", runId: review.id }),
      ]),
    );
    expect(runtime.listQualityAssessments(review.id)[0]).toMatchObject({
      targetMessageId: "quality-answer",
      passed: false,
      iteration: 1,
    });
    const improve = runtime.improveMessage("quality-answer");
    expect((await waitForRunTerminal(runtime, improve.id)).status).toBe("completed");
    expect(runtime.listTrace({ runId: improve.id }).spans).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "improve", kind: "run", status: "ok", runId: improve.id }),
        expect.objectContaining({ name: "model.improve", kind: "model", status: "ok", runId: improve.id }),
      ]),
    );
    const revision = runtime
      .getSnapshot(session.id)
      .transcript.find((item) => item.runId === improve.id && item.role === "assistant");
    expect(revision).toMatchObject({
      content: "Answer with the missing detail",
      revisionOfMessageId: "quality-answer",
    });
    expect(runtime.database.getMessage("quality-answer").content).toBe("Original answer");
    expect(() => runtime.reviewMessage("quality-question")).toThrow("assistant message");
    const reset = runtime.improveMessage(revision?.id as string, { reset: true });
    expect((await waitForRunTerminal(runtime, reset.id)).status).toBe("completed");
    expect(
      runtime
        .getSnapshot(session.id)
        .transcript.find((item) => item.runId === reset.id && item.role === "assistant"),
    ).toMatchObject({
      content: "Reset improvement from original",
      revisionOfMessageId: "quality-answer",
    });
    const noFeedbackReview = runtime.reviewMessage("quality-answer");
    expect((await waitForRunTerminal(runtime, noFeedbackReview.id)).status).toBe("completed");
  });

  it("reloads validated dynamic configuration atomically and defers unsafe active changes", async () => {
    const runtime = await runtimeWith([]);
    const next = structuredClone(runtime.config);
    next.server.port++;
    next.defaultThinkingLevel = "high";
    next.skillsDirs = [runtime.config.server.workspaceRoots[0] as string];
    const result = await runtime.reloadConfig(next);
    expect(result.applied).toEqual(expect.arrayContaining(["models", "roles", "skills"]));
    expect(result.restartRequired).toContain("server");
    expect(runtime.config.defaultThinkingLevel).toBe("high");

    const session = await runtime.createSession();
    const active = runtime.database.createRun(
      session.id,
      "reload-active",
      runtime.models.snapshot(session.model),
      session.thinkingLevel,
      "agent",
      "agent",
    ).run;
    runtime.database.insertMessage({
      id: "reload-active",
      sessionId: session.id,
      runId: active.id,
      role: "user",
      status: "complete",
      content: "waiting",
    });
    runtime.database.updateRun(active.id, { status: "awaiting_input" });
    const deferred = structuredClone(runtime.config);
    deferred.roles.reasoning = { provider: "faux", id: "model-2" };
    deferred.mcpServers = [{ name: "deferred", transport: "http", url: "http://worker/mcp" }];
    const blocked = await runtime.reloadConfig(deferred);
    expect(blocked.restartRequired).toEqual(expect.arrayContaining(["models", "roles", "mcpServers"]));
    expect(runtime.config.roles.reasoning.id).toBe("model");
  });

  it("creates evidence-only optimization proposals with no apply operation", async () => {
    const runtime = await runtimeWith([]);
    const database = runtime.database as typeof runtime.database & {
      diagnosticsReport: typeof runtime.database.diagnosticsReport;
    };
    database.diagnosticsReport = () =>
      ({
        slowModels: [{ provider: "faux", model: "slow", calls: 3, averageDurationMs: 6_000 }],
        toolFailures: [{ tool: "shell", failures: 2, latestError: "exit 1" }],
        recoveryFrequency: 0.1,
      }) as ReturnType<typeof runtime.database.diagnosticsReport>;
    const proposals = runtime.generateOptimizationProposals();
    expect(proposals).toHaveLength(3);
    expect(runtime.decideOptimizationProposal(proposals[0]?.id as string, "accepted").status).toBe(
      "accepted",
    );
    expect(runtime.listOptimizationProposals()).toHaveLength(3);
    database.diagnosticsReport = () =>
      ({
        slowModels: [{ provider: "faux", model: "fast", calls: 1, averageDurationMs: 4_999 }],
        toolFailures: [],
        recoveryFrequency: 0.05,
      }) as ReturnType<typeof runtime.database.diagnosticsReport>;
    expect(runtime.generateOptimizationProposals()).toEqual([]);
  });

  it("requires an accepted proposal and explicit approval before optimization writes", async () => {
    const runtime = await runtimeWith([]);
    const session = await runtime.createSession({ title: "Optimization" });
    await writeFile(
      join(session.workspace as string, "package.json"),
      JSON.stringify({ scripts: { check: 'node -e "process.exit(0)"' } }),
    );
    const proposal = runtime.database.addOptimizationProposal({
      title: "Test change",
      evidence: ["fixture"],
      risk: "low",
      recommendation: "Apply fixture",
      validation: ["check"],
      status: "pending",
    });
    const change = [{ path: "safe.txt", content: "safe" }];
    const pending = await runtime.optimizationExecution.apply(
      proposal.id,
      session.workspace as string,
      change,
      "check",
      true,
    );
    expect(pending.applied).toBe(false);
    runtime.decideOptimizationProposal(proposal.id, "accepted");
    const unapproved = await runtime.optimizationExecution.apply(
      proposal.id,
      session.workspace as string,
      change,
      "check",
    );
    expect(unapproved.applied).toBe(false);
    const applied = await runtime.optimizationExecution.apply(
      proposal.id,
      session.workspace as string,
      change,
      "check",
      true,
    );
    expect(applied.applied).toBe(true);
    expect(await readFile(join(session.workspace as string, "safe.txt"), "utf8")).toBe("safe");
    const rolledBack = await runtime.optimizationExecution.rollback(applied.application?.id as string);
    expect(rolledBack.rolledBack).toBe(true);
    await expect(readFile(join(session.workspace as string, "safe.txt"), "utf8")).rejects.toThrow();
    await writeFile(
      join(session.workspace as string, "package.json"),
      JSON.stringify({ scripts: { check: 'node -e "process.exit(1)"' } }),
    );
    const failingProposal = runtime.database.addOptimizationProposal({
      title: "Failing validation",
      evidence: ["fixture"],
      risk: "low",
      recommendation: "Exercise rollback",
      validation: ["check"],
      status: "accepted",
    });
    await expect(
      runtime.optimizationExecution.apply(
        failingProposal.id,
        session.workspace as string,
        [{ path: "failed.txt", content: "must be removed" }],
        "check",
        true,
      ),
    ).rejects.toMatchObject({ application: { status: "rolled_back", rollbackStatus: "completed" } });
    await expect(readFile(join(session.workspace as string, "failed.txt"), "utf8")).rejects.toThrow();
    const git = await runtime.optimizationExecution.preview(
      proposal.id,
      session.workspace as string,
      [{ path: ".git/config", content: "x" }],
      "check",
      true,
    );
    expect(git.writable).toBe(false);
  });

  it("enforces command, attachment, profile, message-id, and memory safety edges", async () => {
    const runtime = await runtimeWith([]);
    const workspace = await runtime.createSession({ title: "Edges" });
    const assistant = await runtime.createSession();
    await expect(runtime.createSession({ workspace: workspace.workspace })).resolves.toBeDefined();

    expect(
      runtime.updateSession(workspace.id, {
        title: "Updated edges",
        model: { provider: "faux", id: "model-2" },
        thinkingLevel: "high",
        queueMode: "queue",
      }),
    ).toMatchObject({ title: "Updated edges", thinkingLevel: "high", model: { id: "model-2" } });
    await expect(runtime.reloadConfig(structuredClone(runtime.config))).resolves.toEqual({
      applied: [],
      restartRequired: [],
    });
    const staticChanges = structuredClone(runtime.config);
    staticChanges.auth.webSessionHours++;
    staticChanges.runtime.toolTimeoutMs++;
    await expect(runtime.reloadConfig(staticChanges)).resolves.toMatchObject({
      restartRequired: expect.arrayContaining(["auth", "runtime"]),
    });

    expect(runtime.updateAgentProfile("Prefer tests.").content).toBe("Prefer tests.");
    await expect(() => runtime.updateAgentProfile("x".repeat(50_001))).toThrow("too large");
    await expect(
      runtime.addAttachment({ name: "huge.txt", mimeType: "text/plain", data: new Uint8Array(1_025) }),
    ).rejects.toThrow("exceeds");
    const attachment = await runtime.addAttachment({
      sessionId: workspace.id,
      name: "unsafe name?.txt",
      mimeType: "text/plain",
      data: new TextEncoder().encode("safe"),
    });
    expect(attachment.name).toBe("unsafe_name_.txt");
    expect(
      (
        await runtime.addAttachment({
          name: "",
          mimeType: "text/plain",
          data: new TextEncoder().encode("anonymous"),
        })
      ).name,
    ).toBe("upload");

    expect(() => runtime.sendCommand(workspace.id, "   ")).toThrow("required");
    expect(runtime.sendCommand(assistant.id, "pwd")).toMatchObject({
      sessionId: assistant.id,
      interactionMode: "agent",
    });
    runtime.database.insertMessage({
      id: "non-run-message",
      sessionId: workspace.id,
      role: "user",
      status: "complete",
      content: "already used",
    });
    expect(() => runtime.sendCommand(workspace.id, "pwd", "non-run-message")).toThrow("already used");
    expect(() =>
      runtime.sendMessage(assistant.id, { messageId: "non-run-message", text: "duplicate", mode: "agent" }),
    ).toThrow("another session");
    const existingRun = runtime.database.createRun(
      workspace.id,
      "existing-run-message",
      runtime.models.snapshot(workspace.model),
      workspace.thinkingLevel,
      "agent",
      "agent",
    ).run;
    runtime.database.insertMessage({
      id: "existing-run-message",
      sessionId: workspace.id,
      runId: existingRun.id,
      role: "user",
      status: "complete",
      content: "existing",
    });
    expect(
      runtime.sendMessage(workspace.id, { messageId: "existing-run-message", text: "retry", mode: "agent" })
        .id,
    ).toBe(existingRun.id);
    const image = await runtime.addAttachment({
      sessionId: workspace.id,
      name: "image.png",
      mimeType: "image/png",
      data: new Uint8Array([1, 2, 3]),
    });
    expect(() =>
      runtime.sendMessage(workspace.id, {
        messageId: "unsupported-image",
        text: "inspect",
        mode: "agent",
        attachmentIds: [image.id],
      }),
    ).toThrow("does not support image");

    const clarification = runtime.database.createRun(
      assistant.id,
      "clarification-original",
      runtime.models.snapshot(assistant.model),
      assistant.thinkingLevel,
      "agent",
      "agent",
    ).run;
    runtime.database.insertMessage({
      id: "clarification-original",
      sessionId: assistant.id,
      runId: clarification.id,
      role: "user",
      status: "complete",
      content: "original",
    });
    runtime.database.updateRun(clarification.id, { status: "awaiting_input", clarificationCount: 3 });
    expect(() =>
      runtime.sendMessage(assistant.id, { messageId: "fourth-clarification", text: "more", mode: "agent" }),
    ).toThrow("Clarification limit exceeded");
    expect(runtime.database.getRun(clarification.id).status).toBe("failed");

    const global = runtime.createMemoryFact(workspace.id, "global", "Global preference");
    expect(() => runtime.createMemoryFact(workspace.id, "session", "   ")).toThrow("required");
    expect(() =>
      runtime.createMemoryFact(workspace.id, "session", "service_token = 'test-value-1234567890'"),
    ).toThrow("secret");
    runtime.deleteMemoryFact(global.id);
    const sessionFact = runtime.createMemoryFact(workspace.id, "session", "Session preference");
    runtime.deleteMemoryFact(sessionFact.id);
    expect(runtime.listMemoryFacts()).toEqual([]);
  });

  it("preempts queued work, makes running side effects uncertain, and replays only reads", async () => {
    const runtime = await runtimeWith([]);
    const session = await runtime.createSession({ queueMode: "preemptive" });
    const active = runtime.database.createRun(
      session.id,
      "active-message",
      runtime.models.snapshot(session.model),
      session.thinkingLevel,
      "agent",
      "agent",
    ).run;
    runtime.database.insertMessage({
      id: "active-message",
      sessionId: session.id,
      runId: active.id,
      role: "user",
      status: "complete",
      content: "active",
    });
    runtime.database.updateRun(active.id, { status: "running" });
    const read = runtime.database.createRunAction({
      runId: active.id,
      toolCallId: "preempt-read",
      toolName: "read",
      toolClass: "read",
      idempotencyKey: "preempt-read-once",
      input: {},
    });
    runtime.database.updateRunAction(read.id, { status: "running" });
    const shell = runtime.database.createRunAction({
      runId: active.id,
      toolCallId: "preempt-shell",
      toolName: "shell",
      toolClass: "shell",
      idempotencyKey: "preempt-shell-once",
      input: {},
    });
    runtime.database.updateRunAction(shell.id, { status: "running" });
    const queued = runtime.database.createRun(
      session.id,
      "old-queued",
      runtime.models.snapshot(session.model),
      session.thinkingLevel,
      "agent",
      "agent",
    ).run;
    runtime.database.insertMessage({
      id: "old-queued",
      sessionId: session.id,
      runId: queued.id,
      role: "user",
      status: "complete",
      content: "old",
    });

    const replacement = runtime.sendMessage(session.id, {
      messageId: "replacement",
      text: "new work",
      mode: "agent",
    });
    expect(runtime.database.getRunAction(read.id).status).toBe("prepared");
    expect(runtime.database.getRunAction(shell.id).status).toBe("uncertain");
    expect(runtime.database.getRun(queued.id).status).toBe("cancelled");
    expect(runtime.database.getRun(replacement.id).status).toBe("queued");
    expect((await runtime.decideRunAction(active.id, shell.id, "reject")).status).toBe("rejected");
    expect((await waitForRunTerminal(runtime, replacement.id)).status).toBe("failed");
  });
});
