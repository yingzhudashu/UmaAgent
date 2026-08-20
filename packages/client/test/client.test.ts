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
  message(event: AgentEventEnvelope): void {
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
      protocolVersion: 5,
      sessionId: "session-1",
      sequence: 1,
      timestamp: 2,
      type: "run.updated",
      payload: {},
    });
    socket.message({
      protocolVersion: 5,
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
      "http://localhost:3210/api/v5/runs/run-1/actions/action-1/decide",
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

  it("fetches every durable event page when a gap exceeds one thousand events", async () => {
    const event = (sequence: number): AgentEventEnvelope => ({
      protocolVersion: 5,
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
});
