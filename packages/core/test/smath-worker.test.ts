import { afterEach, describe, expect, it, vi } from "vitest";
import { SmathWorkerClient } from "../src/smath-worker.js";

describe("SmathWorkerClient trace propagation", () => {
  afterEach(() => vi.restoreAllMocks());

  it("forwards the W3C parent context without exposing it in the body", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ result: { operation: "list", output: "No SMath worksheets" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const client = new SmathWorkerClient("http://127.0.0.1:3260", "worker-token");
    await client.execute("owner-1", { operation: "list" }, undefined, {
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      spanId: "00f067aa0ba902b7",
      traceFlags: 1,
    });
    const [, init] = fetchMock.mock.calls[0] ?? [];
    expect((init?.headers as Record<string, string>).traceparent).toBe(
      "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
    );
    expect(JSON.parse(String(init?.body))).toEqual({ ownerId: "owner-1", operation: "list" });
  });
});
