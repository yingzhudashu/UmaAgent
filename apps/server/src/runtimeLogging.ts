import type { UmaRuntime } from "@uma-agent/core";
import type { Run } from "@uma-agent/protocol";
import type { FastifyInstance } from "fastify";

function redactToolSummary(value: string): string {
  return value.replace(/https?:\/\/[^\s]+/gi, (raw) => {
    try {
      const url = new URL(raw);
      return `${url.origin}${url.pathname}`;
    } catch {
      return "[url]";
    }
  });
}

export function installRuntimeLogging(runtime: UmaRuntime, app: FastifyInstance): () => void {
  return runtime.subscribe((event) => {
    if (event.type === "tool.completed") {
      const payload = event.payload as {
        toolName?: unknown;
        isError?: unknown;
        item?: { content?: unknown; name?: unknown };
      };
      if (payload.isError === true) {
        const summary =
          typeof payload.item?.content === "string"
            ? redactToolSummary(payload.item.content.slice(0, 512))
            : "tool execution failed";
        app.log.warn(
          {
            sessionId: event.sessionId,
            runId: event.runId,
            toolName:
              typeof payload.toolName === "string"
                ? payload.toolName
                : typeof payload.item?.name === "string"
                  ? payload.item.name
                  : undefined,
            error: summary,
          },
          "tool execution failed",
        );
      }
      return;
    }
    if (event.type !== "run.updated") return;
    const run = event.payload as Run;
    app.log.info(
      {
        sessionId: event.sessionId,
        runId: run.id,
        provider: run.model.ref.provider,
        model: run.model.ref.id,
        status: run.status,
        phase: run.phase,
        durationMs: Math.max(0, run.updatedAt - run.createdAt),
        ...(run.error ? { error: run.error } : {}),
      },
      "run state changed",
    );
  });
}
