import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { installHttpTelemetry } from "../src/httpTelemetry.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("HTTP telemetry", () => {
  it("continues a valid W3C trace and rejects malformed parent identifiers", async () => {
    const root = await mkdtemp(join(tmpdir(), "uma-http-telemetry-"));
    roots.push(root);
    const app = Fastify();
    const telemetry = installHttpTelemetry(app, root);
    app.get("/context", async (request) => telemetry.contextFor(request));
    app.get("/finish", async (request) => {
      telemetry.finishRequest(request);
      return { finished: true };
    });
    app.get("/local-child", async (request) => {
      const child = telemetry.startSpan("local-child", telemetry.contextFor(request));
      child.finish({ status: "ok" });
      return { finished: true };
    });

    const valid = await app.inject({
      method: "GET",
      url: "/context?credential=must-not-be-traced",
      headers: { traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-00" },
    });
    expect(valid.json()).toMatchObject({
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      traceFlags: 0,
    });
    expect(valid.json<{ spanId: string }>().spanId).toMatch(/^[0-9a-f]{16}$/);

    const invalid = await app.inject({
      method: "GET",
      url: "/context",
      headers: { traceparent: "00-00000000000000000000000000000000-0000000000000000-01" },
    });
    expect(invalid.json<{ traceId: string }>().traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(invalid.json<{ traceId: string }>().traceId).not.toBe("00000000000000000000000000000000");

    const finished = await app.inject({ method: "GET", url: "/finish" });
    expect(finished.json()).toEqual({ finished: true });
    const localChild = await app.inject({
      method: "GET",
      url: "/local-child",
      headers: { traceparent: "00-4bf92f3577b34da6a3ce929d0e0e47ad-00f067aa0ba902b7-01" },
    });
    expect(localChild.json()).toEqual({ finished: true });
    await telemetry.close();
    const telemetryDb = new (await import("node:sqlite")).DatabaseSync(join(root, "telemetry.db"));
    const finishedSpan = telemetryDb
      .prepare("SELECT status,error_type FROM spans WHERE name='GET /finish'")
      .get();
    expect(finishedSpan).toEqual({ status: "ok", error_type: null });
    const localChildAttributes = telemetryDb
      .prepare(
        "SELECT json_extract(attributes_json,'$.\"trace.parent_remote\"') AS remote FROM spans WHERE name='local-child'",
      )
      .get();
    telemetryDb.close();
    expect(localChildAttributes).toEqual({ remote: 0 });

    await app.close();
  });
});
