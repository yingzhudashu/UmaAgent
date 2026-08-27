import {
  parseTraceparent,
  TelemetryStore,
  type TraceParent,
  TraceService,
  type TraceSpanContext,
  telemetryDirectory,
} from "@uma-agent/telemetry";
import type { FastifyInstance, FastifyRequest } from "fastify";

export type HttpTelemetry = {
  contextFor(request: FastifyRequest): TraceParent | undefined;
  close(): Promise<void>;
};

export function installHttpTelemetry(app: FastifyInstance, stateDir: string): HttpTelemetry {
  const telemetry = new TelemetryStore(telemetryDirectory(stateDir), "server");
  const trace = new TraceService(telemetry, "server");
  const spans = new WeakMap<FastifyRequest, TraceSpanContext>();
  const traceFlags = new WeakMap<FastifyRequest, number>();
  app.addHook("onRequest", async (request) => {
    const path = request.url.split("?")[0] as string;
    const parent = parseTraceparent(
      typeof request.headers.traceparent === "string" ? request.headers.traceparent : undefined,
    );
    traceFlags.set(request, parent?.traceFlags ?? 1);
    spans.set(
      request,
      trace.startRoot(
        undefined,
        undefined,
        `${request.method} ${path}`,
        {
          method: request.method,
          path,
        },
        parent,
        "server.http",
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
  return {
    contextFor(request) {
      const span = spans.get(request);
      return span
        ? { traceId: span.traceId, spanId: span.spanId, traceFlags: traceFlags.get(request) ?? 1 }
        : undefined;
    },
    close: () => telemetry.close(),
  };
}
