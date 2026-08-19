import type { AgentEventEnvelope, SessionSnapshot } from "@uma-agent/protocol";
import { describe, expect, it, vi } from "vitest";
import { UmaClient } from "../src/index.js";

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
    title: "Test",
    workspace: "C:/workspace",
    model: { provider: "test", id: "model" },
    thinkingLevel: "off",
    createdAt: 1,
    updatedAt: 1,
  },
  transcript: [],
  runs: [],
  revision: 0,
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
      protocolVersion: 1,
      sessionId: "session-1",
      sequence: 1,
      timestamp: 2,
      type: "run.updated",
      payload: {},
    });
    socket.message({
      protocolVersion: 1,
      sessionId: "session-1",
      sequence: 3,
      timestamp: 3,
      type: "run.updated",
      payload: {},
    });
    await tick();
    expect(fetchMock).toHaveBeenCalledTimes(2);
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
});
