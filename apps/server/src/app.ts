import { existsSync } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import staticPlugin from "@fastify/static";
import websocket from "@fastify/websocket";
import type { UmaRuntime } from "@uma-agent/core";
import {
  CreateSessionRequestSchema,
  PROTOCOL_VERSION,
  type Run,
  RunActionDecisionSchema,
  SendMessageRequestSchema,
  UpdateSessionRequestSchema,
} from "@uma-agent/protocol";
import Fastify, { type FastifyInstance } from "fastify";
import Value from "typebox/value";
import type { RawData } from "ws";
import { AuthService } from "./auth.js";

type SocketMessage = {
  type?: string;
  token?: string;
  sessions?: Array<{ id?: string; lastSequence?: number }>;
};

function allowedOrigin(origin: string, configured: string[]): boolean {
  return configured.includes(origin);
}

function crossOrigin(origin: string | undefined, host: string | undefined): boolean {
  if (!origin || !host) return false;
  try {
    return new URL(origin).host !== host;
  } catch {
    return true;
  }
}

function secureOrigin(origin: string | undefined): boolean {
  if (!origin) return false;
  try {
    return new URL(origin).protocol === "https:";
  } catch {
    return false;
  }
}

function errorBody(requestId: string, code: string, message: string, retryable = false) {
  return { error: { code, message, retryable, requestId } };
}

export async function createServer(
  runtime: UmaRuntime,
  options: { webRoot?: string | false } = {},
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: process.env.UMA_LOG_LEVEL ?? "info",
      redact: ["req.headers.authorization", "req.headers.cookie", "body.token"],
    },
    bodyLimit: runtime.config.server.maxUploadBytes + 1024,
  });
  const stopRuntimeLogging = runtime.subscribe((event) => {
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
      },
      "run state changed",
    );
  });
  app.addHook("onClose", async () => stopRuntimeLogging());
  const auth = new AuthService(runtime, process.env[runtime.config.auth.tokenEnv]);
  await app.register(cookie);
  await app.register(cors, {
    origin: (origin, callback) =>
      callback(null, Boolean(origin && runtime.config.server.webOrigins.includes(origin))),
    credentials: true,
    methods: ["GET", "HEAD", "POST", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Authorization", "Content-Type"],
    maxAge: 600,
    strictPreflight: true,
    preflightContinue: true,
  });
  await app.register(websocket, { options: { maxPayload: 1_000_000 } });
  await app.register(multipart, {
    limits: { fileSize: runtime.config.server.maxUploadBytes, files: 1, fields: 2 },
  });

  app.addHook("onRequest", async (request, reply) => {
    const origin = request.headers.origin;
    if (origin && !allowedOrigin(origin, runtime.config.server.webOrigins))
      return reply.code(403).send(errorBody(request.id, "forbidden", "Origin is not allowed"));
    const mutating = !new Set(["GET", "HEAD", "OPTIONS"]).has(request.method);
    if (mutating && !origin && auth.webSessionAuthenticated(request) && !auth.bearerAuthenticated(request))
      return reply.code(403).send(errorBody(request.id, "forbidden", "Origin is required for Web sessions"));
    if (request.method === "OPTIONS") return reply.code(204).send();
    if (
      !request.url.startsWith("/api/v5/") ||
      request.url === "/api/v5/health/live" ||
      request.url === "/api/v5/health/ready" ||
      request.url === "/api/v5/auth/login" ||
      request.url === "/api/v5/events"
    )
      return;
    if (!auth.requestAuthenticated(request))
      return reply.code(401).send(errorBody(request.id, "auth_required", "Authentication required"));
  });

  const health = (ready: boolean) => ({
    status: ready ? ("ok" as const) : ("degraded" as const),
    version: "0.6.0",
    protocolVersion: PROTOCOL_VERSION,
    activeRuns: runtime.health().activeRuns,
  });
  app.get("/api/v5/health/live", async () => health(true));
  app.get("/api/v5/health/ready", async (_request, reply) => {
    let databaseReady = true;
    try {
      runtime.database.db.prepare("SELECT 1").get();
    } catch {
      databaseReady = false;
    }
    const workspacesReady = (
      await Promise.all(
        runtime.config.server.workspaceRoots.map((root) =>
          access(root).then(
            () => true,
            () => false,
          ),
        ),
      )
    ).every(Boolean);
    const modelsReady = runtime.listModels().length > 0;
    const mcpReady = runtime.mcp.status().every((server) => server.connected);
    const value = health(
      runtime.health().started && databaseReady && workspacesReady && modelsReady && mcpReady,
    );
    return reply.code(value.status === "ok" ? 200 : 503).send(value);
  });
  app.post<{ Body: { token?: string } }>("/api/v5/auth/login", async (request, reply) => {
    if (!auth.loginAllowed(request.ip))
      return reply.code(429).send(errorBody(request.id, "rate_limited", "Too many login attempts", true));
    if (!auth.tokenMatches(request.body?.token)) {
      auth.recordFailure(request.ip);
      return reply.code(401).send(errorBody(request.id, "auth_required", "Invalid token"));
    }
    const origin = request.headers.origin;
    auth.createWebSession(reply, {
      crossOrigin: crossOrigin(origin, request.headers.host),
      secure: secureOrigin(origin),
    });
    return { ok: true };
  });
  app.post("/api/v5/auth/logout", async (request, reply) => {
    const origin = request.headers.origin;
    auth.logout(request, reply, {
      crossOrigin: crossOrigin(origin, request.headers.host),
      secure: secureOrigin(origin),
    });
    return reply.code(204).send();
  });

  app.get("/api/v5/sessions", async () => runtime.listSessions());
  app.post("/api/v5/sessions", async (request) => {
    const body = request.body ?? {};
    if (!Value.Check(CreateSessionRequestSchema, body)) throw new Error("Invalid create-session request");
    return runtime.createSession(body);
  });
  app.get<{ Params: { id: string } }>("/api/v5/sessions/:id/snapshot", async (request) =>
    runtime.getSnapshot(request.params.id),
  );
  app.get<{ Params: { id: string }; Querystring: { after?: string; limit?: string } }>(
    "/api/v5/sessions/:id/events",
    async (request) =>
      runtime.listSessionEvents(
        request.params.id,
        Math.max(0, Number(request.query.after ?? 0)),
        Math.max(1, Math.min(1000, Number(request.query.limit ?? 500))),
      ),
  );
  app.get<{ Params: { id: string }; Querystring: { before?: string; limit?: string } }>(
    "/api/v5/sessions/:id/history",
    async (request) =>
      runtime.listSessionHistory(
        request.params.id,
        request.query.before === undefined ? undefined : Math.max(1, Number(request.query.before)),
        Math.max(1, Math.min(500, Number(request.query.limit ?? 100))),
      ),
  );
  app.post<{ Params: { id: string } }>("/api/v5/sessions/:id/compact", async (request) =>
    runtime.compactSession(request.params.id),
  );
  app.patch<{ Params: { id: string } }>("/api/v5/sessions/:id", async (request) => {
    if (!Value.Check(UpdateSessionRequestSchema, request.body))
      throw new Error("Invalid update-session request");
    return runtime.updateSession(request.params.id, request.body);
  });
  app.delete<{ Params: { id: string } }>("/api/v5/sessions/:id", async (request, reply) => {
    runtime.deleteSession(request.params.id);
    return reply.code(204).send();
  });
  app.post<{ Params: { id: string } }>("/api/v5/sessions/:id/messages", async (request, reply) => {
    if (!Value.Check(SendMessageRequestSchema, request.body)) throw new Error("Invalid message request");
    const run = runtime.sendMessage(request.params.id, request.body);
    return reply.code(202).send({ runId: run.id, status: run.status });
  });
  app.post<{ Params: { id: string } }>("/api/v5/sessions/:id/cancel", async (request, reply) => {
    runtime.cancel(request.params.id);
    return reply.code(204).send();
  });
  app.post<{ Params: { id: string }; Body: { approved?: boolean } }>(
    "/api/v5/approvals/:id",
    async (request) => runtime.resolveApproval(request.params.id, request.body?.approved === true),
  );
  app.get("/api/v5/models", async () => runtime.listModels());
  app.get("/api/v5/skills", async () => runtime.listSkills());
  app.post("/api/v5/skills/refresh", async () => runtime.refreshSkills());
  app.get("/api/v5/mcp", async () => runtime.mcp.status());
  app.get("/api/v5/knowledge", async () => runtime.knowledge.list());
  app.post<{ Body: { name?: string; path?: string; attachmentId?: string } }>(
    "/api/v5/knowledge",
    async (request) => {
      if (!request.body?.name || (!request.body.path && !request.body.attachmentId))
        throw new Error("name and either path or attachmentId are required");
      const path = request.body.attachmentId
        ? runtime.database.getAttachmentPath(request.body.attachmentId)
        : await runtime.workspacePolicy.resolvePath(
            runtime.config.server.workspaceRoots[0] as string,
            request.body.path as string,
          );
      return runtime.knowledge.index(request.body.name, path);
    },
  );
  app.get("/api/v5/tasks", async () => runtime.listTasks());
  app.post<{ Body: { prompt?: string; parentSessionId?: string } }>("/api/v5/tasks", async (request) => {
    if (!request.body?.prompt || typeof request.body.prompt !== "string")
      throw new Error("prompt is required");
    return runtime.createTask(request.body.prompt, request.body.parentSessionId);
  });
  app.get<{ Params: { id: string } }>("/api/v5/tasks/:id", async (request) =>
    runtime.getTask(request.params.id),
  );
  app.get<{ Params: { id: string } }>("/api/v5/tasks/:id/snapshot", async (request) =>
    runtime.getSnapshot(runtime.getTask(request.params.id).sessionId),
  );
  app.post<{ Params: { id: string } }>("/api/v5/tasks/:id/cancel", async (request) =>
    runtime.cancelTask(request.params.id),
  );
  app.get<{ Querystring: { status?: "active" | "candidate" | "rejected" } }>(
    "/api/v5/memory",
    async (request) => runtime.listMemoryFacts(request.query.status),
  );
  app.post<{ Body: { sessionId?: string; scope?: "global" | "session"; content?: string } }>(
    "/api/v5/memory",
    async (request) => {
      if (!request.body?.sessionId || !request.body.content)
        throw new Error("sessionId and content are required");
      return runtime.createMemoryFact(
        request.body.sessionId,
        request.body.scope ?? "session",
        request.body.content,
      );
    },
  );
  app.post<{ Params: { id: string }; Body: { status?: "active" | "candidate" | "rejected" } }>(
    "/api/v5/memory/:id",
    async (request) => {
      const status = request.body?.status;
      if (!status || !["active", "candidate", "rejected"].includes(status))
        throw new Error("Invalid memory status");
      return runtime.reviewMemoryFact(request.params.id, status);
    },
  );
  app.delete<{ Params: { id: string } }>("/api/v5/memory/:id", async (request, reply) => {
    runtime.deleteMemoryFact(request.params.id);
    return reply.code(204).send();
  });
  app.get<{ Params: { runId: string } }>("/api/v5/audit/runs/:runId", async (request) =>
    runtime.audit(request.params.runId),
  );
  app.get<{ Params: { id: string } }>("/api/v5/runs/:id", async (request) =>
    runtime.getRun(request.params.id),
  );
  app.get<{ Params: { id: string } }>("/api/v5/runs/:id/checkpoints", async (request) =>
    runtime.listRunCheckpoints(request.params.id),
  );
  app.get<{ Params: { id: string } }>("/api/v5/runs/:id/actions", async (request) =>
    runtime.listRunActions(request.params.id),
  );
  app.post<{ Params: { id: string } }>("/api/v5/runs/:id/resume", async (request) =>
    runtime.resumeRun(request.params.id),
  );
  app.post<{ Params: { id: string; actionId: string }; Body: { decision?: string } }>(
    "/api/v5/runs/:id/actions/:actionId/decide",
    async (request) => {
      if (!Value.Check(RunActionDecisionSchema, request.body)) throw new Error("Invalid action decision");
      return runtime.decideRunAction(request.params.id, request.params.actionId, request.body.decision);
    },
  );
  app.post<{ Params: { id: string } }>("/api/v5/runs/:id/cancel", async (request) => {
    return runtime.cancelRun(request.params.id);
  });
  app.post("/api/v5/uploads", async (request) => {
    const parts = request.parts();
    let sessionId: string | undefined;
    let upload: { name: string; mimeType: string; data: Buffer } | undefined;
    for await (const part of parts) {
      if (part.type === "file")
        upload = { name: part.filename, mimeType: part.mimetype, data: await part.toBuffer() };
      else if (part.fieldname === "sessionId") sessionId = String(part.value);
    }
    if (!upload) throw new Error("file is required");
    return runtime.addAttachment({ ...(sessionId ? { sessionId } : {}), ...upload });
  });
  app.get<{ Params: { id: string } }>("/api/v5/attachments/:id/content", async (request, reply) => {
    const attachment = runtime.database.getAttachment(request.params.id);
    if (!attachment) throw new Error(`Attachment not found: ${request.params.id}`);
    const data = await readFile(runtime.database.getAttachmentPath(request.params.id));
    return reply
      .type(attachment.mimeType)
      .header("content-disposition", `inline; filename*=UTF-8''${encodeURIComponent(attachment.name)}`)
      .send(data);
  });

  app.get("/api/v5/events", { websocket: true }, (socket, request) => {
    const origin = request.headers.origin;
    if (origin && !allowedOrigin(origin, runtime.config.server.webOrigins)) {
      socket.close(1008, "Origin is not allowed");
      return;
    }
    let authenticated = auth.requestAuthenticated(request);
    const sessions = new Set<string>();
    const unsubscribe = runtime.subscribe((event) => {
      if (authenticated && sessions.has(event.sessionId) && socket.readyState === socket.OPEN)
        socket.send(JSON.stringify(event));
    });
    const timer = setTimeout(() => {
      if (!authenticated) socket.close(1008, "Authentication timeout");
    }, 5_000);
    socket.on("message", (raw: RawData) => {
      let message: SocketMessage;
      try {
        message = JSON.parse(String(raw)) as SocketMessage;
      } catch {
        socket.close(1003, "Invalid JSON");
        return;
      }
      if (message.type === "auth") authenticated = auth.tokenMatches(message.token);
      if (!authenticated) {
        socket.close(1008, "Authentication required");
        return;
      }
      if (message.type === "subscribe" && Array.isArray(message.sessions)) {
        sessions.clear();
        for (const subscription of message.sessions.slice(0, 100)) {
          const id = subscription.id;
          if (!id) continue;
          sessions.add(id);
          socket.send(JSON.stringify({ type: "sync.started", sessionId: id }));
          let after = Math.max(0, subscription.lastSequence ?? 0);
          let page = runtime.listSessionEvents(id, after, 1000);
          while (true) {
            for (const event of page.events) socket.send(JSON.stringify(event));
            after = page.nextSequence;
            if (!page.hasMore) break;
            page = runtime.listSessionEvents(id, after, 1000);
          }
          socket.send(
            JSON.stringify({ type: "sync.completed", sessionId: id, sequence: page.snapshotSequence }),
          );
        }
      }
    });
    socket.on("close", () => {
      clearTimeout(timer);
      unsubscribe();
    });
  });

  app.all("/api/v5/*", async (request, reply) =>
    reply.code(404).send(errorBody(request.id, "not_found", "API route not found")),
  );

  app.setErrorHandler((cause, request, reply) => {
    const error = cause instanceof Error ? cause : new Error(String(cause));
    let message = error.message.replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]");
    const secrets = [
      process.env[runtime.config.auth.tokenEnv],
      ...runtime.config.models.map((model) => process.env[model.apiKeyEnv]),
    ].filter((value): value is string => Boolean(value));
    for (const secret of secrets) message = message.split(secret).join("[REDACTED]");
    app.log.error({ err: { name: error.name, message } }, "request failed");
    const notFound = /not found/i.test(error.message);
    const conflict =
      /(already|not pending|not cancellable|active run|only interrupted|requiring confirmation)/i.test(
        error.message,
      );
    const providerContract = /provider contract/i.test(error.message);
    const provider =
      !providerContract && /(provider|preflight|classification|verification|model)/i.test(error.message);
    const cancelled = /cancel/i.test(error.message);
    const validation =
      /(invalid|required|must |unsupported|outside|escapes|exceeds|unavailable|does not support|belongs to another session)/i.test(
        error.message,
      );
    const code = notFound
      ? "not_found"
      : conflict
        ? "conflict"
        : providerContract
          ? "provider_contract_error"
          : cancelled
            ? "cancelled"
            : provider
              ? "provider_error"
              : validation
                ? "validation_failed"
                : "internal_error";
    const status = notFound
      ? 404
      : conflict || cancelled
        ? 409
        : providerContract || provider
          ? 502
          : validation
            ? 400
            : 500;
    reply.code(status).send(errorBody(request.id, code, message, provider || code === "internal_error"));
  });

  const webRoot =
    options.webRoot === false ? undefined : (options.webRoot ?? resolve(process.cwd(), "apps/web/dist"));
  if (webRoot && existsSync(webRoot)) {
    await app.register(staticPlugin, { root: webRoot, wildcard: false });
    app.get("/*", async (_request, reply) => reply.sendFile("index.html"));
  } else {
    app.get("/", async (_request, reply) =>
      reply.type("text/html").send("<h1>UmaAgent</h1><p>Web application has not been built.</p>"),
    );
  }
  return app;
}
