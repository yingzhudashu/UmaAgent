import type { AgentEventEnvelope, SessionSnapshot } from "@uma-agent/protocol";
import { describe, expect, it, vi } from "vitest";
import { UmaClient, UmaClientError } from "../src/index.js";

class FakeSocket {
  readyState = 0;
  readonly sent: string[] = [];
  readonly listeners = new Map<string, Array<(event: { data?: string }) => void>>();

  addEventListener(type: string, listener: (event: { data?: string }) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  send(value: string): void {
    this.sent.push(value);
  }
  close(): void {
    this.readyState = 3;
    this.emit("close");
  }
  open(): void {
    this.readyState = 1;
    this.emit("open");
  }
  message(event: unknown): void {
    this.emit("message", JSON.stringify(event));
  }
  private emit(type: string, data?: string): void {
    for (const listener of this.listeners.get(type) ?? []) listener({ data });
  }
}

const snapshot: SessionSnapshot = {
  session: {
    id: "session-1",
    mode: "workspace",
    title: "Test",
    workspace: "C:/workspace",
    model: { provider: "test", id: "model" },
    thinkingLevel: "off",
    createdAt: 1,
    updatedAt: 1,
  },
  transcript: [],
  recentRuns: [],
  pendingApprovals: [],
  snapshotSequence: 0,
  history: { oldestMessageSequence: 0, hasMoreBefore: false },
};

const response = (body: unknown) =>
  Promise.resolve(
    new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }),
  );
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("UmaClient", () => {
  it("recovers an authoritative snapshot when an event sequence has a gap", async () => {
    const fetchMock = vi.fn(() => response(snapshot));
    const socket = new FakeSocket();
    const client = new UmaClient({
      baseUrl: "http://localhost:3210",
      fetch: fetchMock as typeof fetch,
      webSocketFactory: () => socket as unknown as WebSocket,
    });
    const received: AgentEventEnvelope[] = [];
    client.subscribe("session-1", (event) => received.push(event));
    client.connectEvents();
    socket.open();
    await tick();
    socket.message({
      protocolVersion: 10,
      sessionId: "session-1",
      sequence: 1,
      timestamp: 2,
      type: "run.updated",
      payload: {},
    });
    socket.message({
      protocolVersion: 10,
      sessionId: "session-1",
      sequence: 3,
      timestamp: 3,
      type: "run.updated",
      payload: {},
    });
    await tick();
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(received.at(-1)?.type).toBe("session.snapshot");
    client.close();
  });

  it("restarts the event socket after cookie login", async () => {
    const sockets: FakeSocket[] = [];
    const client = new UmaClient({
      baseUrl: "http://localhost:3210",
      fetch: (() => response({ ok: true })) as typeof fetch,
      webSocketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket as unknown as WebSocket;
      },
    });
    client.connectEvents();
    await client.login("secret");
    expect(sockets).toHaveLength(2);
    expect(sockets[0]?.readyState).toBe(3);
    client.close();
  });

  it("sends the v5 Action decision contract", async () => {
    const fetchMock = vi.fn(() =>
      response({
        id: "action-1",
        runId: "run-1",
        toolCallId: "tool-1",
        toolName: "shell",
        toolClass: "shell",
        idempotencyKey: "once",
        status: "acknowledged",
      }),
    );
    const client = new UmaClient({
      baseUrl: "http://localhost:3210",
      fetch: fetchMock as typeof fetch,
    });
    await client.decideRunAction("run-1", "action-1", "acknowledge");
    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:3210/api/v10/runs/run-1/actions/action-1/decide",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ decision: "acknowledge" }) }),
    );
  });

  it("subscribes from a durable cursor supplied by a persisted client projection", () => {
    const socket = new FakeSocket();
    const client = new UmaClient({
      baseUrl: "http://localhost:3210",
      fetch: (() => response(snapshot)) as typeof fetch,
      webSocketFactory: () => socket as unknown as WebSocket,
    });
    client.subscribeSessions([{ id: "session-1", lastSequence: 42 }], () => {});
    client.connectEvents();
    socket.open();
    expect(socket.sent.map((value) => JSON.parse(value))).toContainEqual({
      type: "subscribe",
      sessions: [{ id: "session-1", lastSequence: 42 }],
    });
    client.close();
  });

  it("delivers resource invalidation and reconnect resync frames outside session cursors", () => {
    const socket = new FakeSocket();
    const client = new UmaClient({
      baseUrl: "http://localhost:3210",
      fetch: (() => response(snapshot)) as typeof fetch,
      webSocketFactory: () => socket as unknown as WebSocket,
    });
    const received: string[] = [];
    client.subscribeResources((event) => received.push(event.type));
    client.connectEvents();
    socket.open();
    socket.message({
      type: "resource.resync_required",
      protocolVersion: 10,
      resources: ["tasks", "schedules"],
      timestamp: 1,
    });
    socket.message({
      type: "resource.invalidated",
      protocolVersion: 10,
      resource: "tasks",
      timestamp: 2,
    });
    expect(received).toEqual(["resource.resync_required", "resource.invalidated"]);
    client.close();
  });

  it("fetches every durable event page when a gap exceeds one thousand events", async () => {
    const event = (sequence: number): AgentEventEnvelope => ({
      protocolVersion: 10,
      sessionId: "session-1",
      sequence,
      timestamp: sequence,
      type: "run.updated",
      payload: { sequence },
    });
    const fetchMock = vi.fn((input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("after=0"))
        return response({
          sessionId: "session-1",
          fromSequence: 1,
          toSequence: 1_000,
          nextSequence: 1_000,
          hasMore: true,
          snapshotSequence: 1_002,
          events: Array.from({ length: 1_000 }, (_, index) => event(index + 1)),
        });
      if (url.includes("after=1000"))
        return response({
          sessionId: "session-1",
          fromSequence: 1_001,
          toSequence: 1_002,
          nextSequence: 1_002,
          hasMore: false,
          snapshotSequence: 1_002,
          events: [event(1_001), event(1_002)],
        });
      return response(snapshot);
    });
    const socket = new FakeSocket();
    const client = new UmaClient({
      baseUrl: "http://localhost:3210",
      fetch: fetchMock as typeof fetch,
      webSocketFactory: () => socket as unknown as WebSocket,
    });
    const received: AgentEventEnvelope[] = [];
    client.subscribeSessions([{ id: "session-1", lastSequence: 0 }], (value) => received.push(value));
    client.connectEvents();
    socket.open();
    socket.message(event(1_002));
    await tick();
    await tick();
    expect(received).toHaveLength(1_002);
    expect(received.at(-1)?.sequence).toBe(1_002);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes("/events?"))).toHaveLength(2);
    client.close();
  });

  it("surfaces the stable server error code, retryability, and request id", async () => {
    const client = new UmaClient({
      baseUrl: "http://localhost:3210",
      fetch: (() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              error: {
                code: "rate_limited",
                message: "try later",
                retryable: true,
                requestId: "req-stable",
              },
            }),
            { status: 429, headers: { "content-type": "application/json" } },
          ),
        )) as typeof fetch,
    });
    const error = await client.health().catch((cause) => cause);
    expect(error).toBeInstanceOf(UmaClientError);
    expect(error).toMatchObject({
      status: 429,
      code: "rate_limited",
      retryable: true,
      requestId: "req-stable",
      message: "try later",
    });
  });

  it("uses the v7 schedule, knowledge, and operations report contracts", async () => {
    const fetchMock = vi.fn(() => response({ ok: true }));
    const client = new UmaClient({ baseUrl: "http://localhost:3210/", fetch: fetchMock as typeof fetch });
    await client.createSchedule({
      name: "daily",
      prompt: "summarize",
      schedule: { kind: "cron", expression: "0 9 * * *", timezone: "UTC" },
    });
    await client.updateSchedule("schedule/id", { enabled: false });
    await client.runSchedule("schedule/id");
    await client.listScheduleRuns("schedule/id");
    await client.getScheduleRun("schedule-run/id");
    await client.cancelScheduleRun("schedule-run/id");
    await client.deleteSchedule("schedule/id");
    await client.indexKnowledgeAttachment("notes", "attachment/id", "session/id");
    await client.deleteKnowledge("knowledge/id");
    await client.operationsReport(10, 20);
    await client.diagnosticsReport(10, 20);
    const requests = fetchMock.mock.calls.map(([url, init]) => ({ url: String(url), init }));
    expect(requests.map((item) => item.url)).toEqual([
      "http://localhost:3210/api/v10/schedules",
      "http://localhost:3210/api/v10/schedules/schedule%2Fid",
      "http://localhost:3210/api/v10/schedules/schedule%2Fid/run",
      "http://localhost:3210/api/v10/schedules/schedule%2Fid/runs",
      "http://localhost:3210/api/v10/schedule-runs/schedule-run%2Fid",
      "http://localhost:3210/api/v10/schedule-runs/schedule-run%2Fid/cancel",
      "http://localhost:3210/api/v10/schedules/schedule%2Fid",
      "http://localhost:3210/api/v10/knowledge",
      "http://localhost:3210/api/v10/knowledge/knowledge%2Fid",
      "http://localhost:3210/api/v10/reports/operations?from=10&to=20",
      "http://localhost:3210/api/v10/reports/diagnostics?from=10&to=20",
    ]);
    expect(requests[7]?.init?.body).toBe(
      JSON.stringify({ name: "notes", attachmentId: "attachment/id", sessionId: "session/id" }),
    );
  });

  it("covers the complete HTTP facade and optional request shapes", async () => {
    const fetchMock = vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "DELETE" || url.endsWith("/cancel"))
        return Promise.resolve(new Response(null, { status: 204 }));
      return response({ status: "completed", id: "resource-1" });
    });
    const client = new UmaClient({
      baseUrl: "http://localhost:3210/",
      token: "secret",
      fetch: fetchMock as typeof fetch,
    });

    await client.logout();
    await client.listSessions();
    await client.createSession();
    await client.getSession("session/id");
    await client.getSessionHistory("session/id");
    await client.getSessionHistory("session/id", 10, 25);
    await client.getSessionEvents("session/id", 2, 3);
    await client.updateSession("session/id", { title: "renamed" });
    await client.deleteSession("session/id");
    await client.sendMessage("session/id", "hello");
    await client.sendMessage("session/id", "hello", { messageId: "stable" });
    await client.cancel("session/id");
    await client.resolveApproval("approval/id", true);
    await client.listModels();
    await client.listSkills();
    await client.skillState();
    await client.refreshSkills();
    await client.reloadConfig();
    await client.publicConfig();
    await client.searchSkills("safe skill");
    await client.installSkill({ source: "local", reference: "skills/demo" });
    await client.setSkillStatus("skill/id", "enable");
    await client.setSkillStatus("skill/id", "disable");
    await client.setSkillStatus("skill/id", "reject");
    await client.getAgentProfile();
    await client.updateAgentProfile("Be concise.");
    await client.searchHistory("session/id", "old answer");
    await client.searchHistory("session/id", "old answer", 5);
    await client.listActivity("session/id");
    await client.listActivity("session/id", 10);
    await client.mcpStatus();
    await client.listKnowledge();
    await client.indexKnowledge("docs", "docs/readme.md");
    await client.searchKnowledge("needle");
    await client.searchKnowledge("needle", "source/id", 5);
    await client.reindexKnowledge("knowledge/id");
    await client.listTasks();
    await client.createTask("prompt");
    await client.createTask("prompt", "parent/id");
    await client.getTask("task/id");
    await client.deleteTask("task/id");
    await client.listSchedules();
    await client.operationsReport();
    await client.diagnosticsReport();
    await client.listEvaluationReports();
    await client.getEvaluationReport("evaluation/id");
    await client.createEvaluationReport({
      mode: "faux",
      suiteVersion: "test",
      status: "completed",
      totals: { total: 1, passed: 1, failed: 0, skipped: 0 },
      durationMs: 1,
      cases: [{ name: "case", category: "regression", passed: true, durationMs: 1 }],
    });
    await client.listOptimizationProposals();
    await client.generateOptimizationProposals();
    await client.generateOptimizationProposals(10, 20);
    await client.decideOptimizationProposal("proposal/id", "accepted");
    await client.decideOptimizationProposal("proposal/id", "rejected");
    await client.listMemoryFacts();
    await client.listMemoryFacts("candidate");
    await client.createMemoryFact("session/id", "fact");
    await client.createMemoryFact("session/id", "fact", "global");
    await client.reviewMemoryFact("memory/id", "active");
    await client.deleteMemoryFact("memory/id");
    await client.listAudit("run/id");
    await client.reviewMessage("message/id");
    await client.reviewMessage("message/id", "check facts");
    await client.improveMessage("message/id");
    await client.improveMessage("message/id", { force: true, reset: true });
    await client.listRunQuality("run/id");
    await client.sendCommand("session/id", "pwd");
    await client.sendCommand("session/id", "pwd", "message/id");
    await client.listRunActions("run/id");
    await client.listRunCheckpoints("run/id");
    await client.resumeRun("run/id");
    await client.cancelRun("run/id");
    await client.compactSession("session/id");
    await client.upload(new Blob(["body"], { type: "text/plain" }), "note.txt");
    await client.upload(new Blob(["body"], { type: "text/plain" }), "note.txt", "session/id");

    const firstHeaders = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
    expect(firstHeaders.get("authorization")).toBe("Bearer secret");
    expect(fetchMock.mock.calls.some(([, init]) => init?.body instanceof FormData)).toBe(true);
  });

  it("waits through a non-terminal state and supports aborting a wait", async () => {
    const runs = [{ status: "running" }, { status: "completed" }];
    const client = new UmaClient({
      baseUrl: "http://localhost:3210",
      fetch: (() => response(runs.shift() ?? { status: "completed" })) as typeof fetch,
    });
    await expect(client.waitForRun("run-1", { pollMs: 0 })).resolves.toMatchObject({
      status: "completed",
    });

    const controller = new AbortController();
    controller.abort();
    await expect(client.waitForRun("run-2", { signal: controller.signal })).rejects.toMatchObject({
      name: "AbortError",
    });
  });

  it("aborts a wait while the polling timer is active", async () => {
    const controller = new AbortController();
    const client = new UmaClient({
      baseUrl: "http://localhost:3210",
      fetch: (() => response({ status: "running" })) as typeof fetch,
    });
    const waiting = client.waitForRun("run-1", { signal: controller.signal, pollMs: 10_000 });
    await tick();
    controller.abort();
    await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
  });

  it("downloads attachments and normalizes JSON and non-JSON errors", async () => {
    const ok = new UmaClient({
      baseUrl: "http://localhost:3210",
      fetch: (() => Promise.resolve(new Response("contents", { status: 200 }))) as typeof fetch,
    });
    expect(await (await ok.attachmentContent("attachment/id")).text()).toBe("contents");

    const jsonError = new UmaClient({
      baseUrl: "http://localhost:3210",
      fetch: (() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              error: { code: "forbidden", message: "denied", retryable: false, requestId: "req-1" },
            }),
            { status: 403, headers: { "content-type": "application/json" } },
          ),
        )) as typeof fetch,
    });
    await expect(jsonError.attachmentContent("missing")).rejects.toMatchObject({
      status: 403,
      code: "forbidden",
      requestId: "req-1",
    });

    const textError = new UmaClient({
      baseUrl: "http://localhost:3210",
      fetch: (() => Promise.resolve(new Response("bad gateway", { status: 502 }))) as typeof fetch,
    });
    await expect(textError.health()).rejects.toMatchObject({ status: 502, code: "http_error" });
    await expect(textError.attachmentContent("missing")).rejects.toMatchObject({
      status: 502,
      code: "http_error",
    });
  });

  it("authenticates sockets, ignores malformed or duplicate frames, and unsubscribes", async () => {
    const socket = new FakeSocket();
    const client = new UmaClient({
      baseUrl: "https://core.example",
      token: "secret",
      fetch: (() => response(snapshot)) as typeof fetch,
      webSocketFactory: (url) => {
        expect(url).toBe("wss://core.example/api/v10/events");
        return socket as unknown as WebSocket;
      },
    });
    const received: AgentEventEnvelope[] = [];
    const unsubscribe = client.subscribe("session-1", (event) => received.push(event));
    client.connectEvents();
    client.connectEvents();
    socket.open();
    await tick();
    expect(socket.sent.map((value) => JSON.parse(value))).toContainEqual({ type: "auth", token: "secret" });
    socket.message({
      protocolVersion: 10,
      sessionId: "not-subscribed",
      sequence: 1,
      timestamp: 1,
      type: "run.updated",
      payload: {},
    });
    socket.message({
      protocolVersion: 10,
      sessionId: "session-1",
      sequence: 1,
      timestamp: 1,
      type: "run.updated",
      payload: {},
    });
    socket.message({
      protocolVersion: 10,
      sessionId: "session-1",
      sequence: 1,
      timestamp: 1,
      type: "run.updated",
      payload: {},
    });
    for (const listener of socket.listeners.get("message") ?? []) listener({ data: "not json" });
    expect(received.filter((event) => event.type === "run.updated")).toHaveLength(1);
    unsubscribe();
    client.close();
    client.close();
  });

  it("falls back to a snapshot when event recovery cannot make progress", async () => {
    const event: AgentEventEnvelope = {
      protocolVersion: 10,
      sessionId: "session-1",
      sequence: 3,
      timestamp: 3,
      type: "run.updated",
      payload: {},
    };
    const fetchMock = vi.fn((input: string | URL | Request) =>
      String(input).includes("/events?")
        ? response({
            sessionId: "session-1",
            fromSequence: 0,
            toSequence: 0,
            nextSequence: 0,
            hasMore: false,
            snapshotSequence: 3,
            events: [],
          })
        : response({ ...snapshot, snapshotSequence: 3 }),
    );
    const socket = new FakeSocket();
    const client = new UmaClient({
      baseUrl: "http://localhost:3210",
      fetch: fetchMock as typeof fetch,
      webSocketFactory: () => socket as unknown as WebSocket,
    });
    const received: AgentEventEnvelope[] = [];
    client.subscribeSessions([{ id: "session-1", lastSequence: 0 }], (value) => received.push(value));
    client.connectEvents();
    socket.open();
    socket.message(event);
    await tick();
    await tick();
    expect(received.at(-1)?.type).toBe("session.snapshot");
    client.close();
  });
});
