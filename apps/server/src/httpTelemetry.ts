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
  finishRequest(request: FastifyRequest, statusCode?: number): void;
  startSpan(name: string, parent?: TraceParent): TraceSpanContext;
  close(): Promise<void>;
};

export function installHttpTelemetry(app: FastifyInstance, stateDir: string): HttpTelemetry {
  const telemetry = new TelemetryStore(telemetryDirectory(stateDir), "server");
  const trace = new TraceService(telemetry, "server");
  const spans = new WeakMap<FastifyRequest, TraceSpanContext>();
  const traceFlags = new WeakMap<FastifyRequest, number>();
  app.addHook("onRequest", async (request) => {
    // 仅记录路由模板，避免用户提供的路径片段或未知 URL 将凭据带入 Span 名称。
    const path = request.routeOptions.url ?? "<unmatched>";
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
          ...(parent ? { "trace.parent_remote": true } : {}),
        },
        parent,
        "server.http",
      ),
    );
  });
  const finishRequest = (request: FastifyRequest, statusCode = 200) => {
    const failed = statusCode >= 500;
    spans.get(request)?.finish({
      status: failed ? "error" : "ok",
      ...(failed ? { error: { name: `HTTP${statusCode}`, message: "HTTP request failed" } } : {}),
    });
  };
  app.addHook("onResponse", async (request, reply) => {
    finishRequest(request, reply.statusCode);
  });
  app.addHook("onTimeout", async (request) => {
    spans
      .get(request)
      ?.finish({ status: "error", error: { name: "RequestTimeout", message: "HTTP request timed out" } });
  });
  app.addHook("onRequestAbort", async (request) => {
    spans.get(request)?.finish({ status: "cancelled" });
  });
  return {
    contextFor(request) {
      const span = spans.get(request);
      return span
        ? { traceId: span.traceId, spanId: span.spanId, traceFlags: traceFlags.get(request) ?? 1 }
        : undefined;
    },
    finishRequest,
    startSpan(name, parent) {
      return trace.startRoot(
        undefined,
        undefined,
        name,
        { "trace.parent_remote": false },
        parent,
        "server.websocket",
      );
    },
    close: () => telemetry.close(),
  };
}
