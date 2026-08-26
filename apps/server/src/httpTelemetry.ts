import { randomUUID } from "node:crypto";
import { TelemetryStore, TraceSpanContext } from "@uma-agent/telemetry";
import type { FastifyInstance, FastifyRequest } from "fastify";

export function installHttpTelemetry(app: FastifyInstance, stateDir: string): () => void {
  const telemetry = new TelemetryStore(stateDir, "server");
  const spans = new WeakMap<FastifyRequest, TraceSpanContext>();
  app.addHook("onRequest", async (request) => {
    const parts =
      typeof request.headers.traceparent === "string" ? request.headers.traceparent.split("-") : [];
    const traceCandidate = parts[1];
    const traceId =
      traceCandidate && /^[0-9a-f]{32}$/i.test(traceCandidate)
        ? traceCandidate
        : randomUUID().replaceAll("-", "");
    const parent = /^[0-9a-f]{16}$/i.test(parts[2] ?? "") ? parts[2] : undefined;
    spans.set(
      request,
      new TraceSpanContext(
        telemetry,
        traceId,
        randomUUID().replaceAll("-", ""),
        parent,
        undefined,
        undefined,
        `${request.method} ${request.url.split("?")[0]}`,
        "server.http",
        "server",
        { method: request.method, path: request.url.split("?")[0] },
      ),
    );
  });
  app.addHook("onResponse", async (request, reply) => {
    const failed = reply.statusCode >= 500;
    spans.get(request)?.finish({
      status: failed ? "error" : "ok",
      ...(failed ? { error: { name: `HTTP${reply.statusCode}`, message: "HTTP request failed" } } : {}),
    });
  });
  return () => telemetry.close();
}
