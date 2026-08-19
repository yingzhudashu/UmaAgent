import { existsSync } from "node:fs";
import { resolve } from "node:path";
import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import staticPlugin from "@fastify/static";
import websocket from "@fastify/websocket";
import type { UmaRuntime } from "@uma-agent/core";
import {
  CreateSessionRequestSchema,
  SendMessageRequestSchema,
  UpdateSessionRequestSchema,
} from "@uma-agent/protocol";
import Fastify, { type FastifyInstance } from "fastify";
import Value from "typebox/value";
import type { RawData } from "ws";
import { AuthService } from "./auth.js";

type SocketMessage = { type?: string; token?: string; sessionIds?: string[] };

function sameHost(origin: string, host: string | undefined): boolean {
  try {
    return Boolean(host && new URL(origin).host === host);
  } catch {
    return false;
  }
}

export async function createServer(runtime: UmaRuntime): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: process.env.UMA_LOG_LEVEL ?? "info",
      redact: ["req.headers.authorization", "req.headers.cookie", "body.token"],
    },
    bodyLimit: runtime.config.server.maxUploadBytes + 1024,
  });
  const auth = new AuthService(runtime, process.env[runtime.config.auth.tokenEnv]);
  await app.register(cookie);
  await app.register(websocket, { options: { maxPayload: 1_000_000 } });
  await app.register(multipart, {
    limits: { fileSize: runtime.config.server.maxUploadBytes, files: 1, fields: 2 },
  });

  app.addHook("onRequest", async (request, reply) => {
    const origin = request.headers.origin;
    if (origin && !request.headers.authorization) {
      const sameOrigin = sameHost(origin, request.headers.host);
      if (!sameOrigin && !runtime.config.server.webOrigins.includes(origin))
        return reply.code(403).send({ error: { code: "origin_denied", message: "Origin is not allowed" } });
    }
    if (
      !request.url.startsWith("/api/v1/") ||
      request.url === "/api/v1/health" ||
      request.url === "/api/v1/auth/login" ||
      request.url === "/api/v1/events"
    )
      return;
    if (!auth.requestAuthenticated(request))
      return reply.code(401).send({ error: { code: "unauthorized", message: "Authentication required" } });
  });

  app.get("/api/v1/health", async () => ({
    status: runtime.health().started ? "ok" : "degraded",
    version: "0.1.0",
    protocolVersion: 1,
    activeRuns: runtime.health().activeRuns,
  }));
  app.post<{ Body: { token?: string } }>("/api/v1/auth/login", async (request, reply) => {
    if (!auth.loginAllowed(request.ip))
      return reply.code(429).send({ error: { code: "rate_limited", message: "Too many login attempts" } });
    if (!auth.tokenMatches(request.body?.token)) {
      auth.recordFailure(request.ip);
      return reply.code(401).send({ error: { code: "invalid_token", message: "Invalid token" } });
    }
    auth.createWebSession(reply);
    return { ok: true };
  });
  app.post("/api/v1/auth/logout", async (request, reply) => {
    auth.logout(request, reply);
    return reply.code(204).send();
  });

  app.get("/api/v1/sessions", async () => runtime.listSessions());
  app.post("/api/v1/sessions", async (request) => {
    const body = request.body ?? {};
    if (!Value.Check(CreateSessionRequestSchema, body)) throw new Error("Invalid create-session request");
    return runtime.createSession(body);
  });
  app.get<{ Params: { id: string } }>("/api/v1/sessions/:id", async (request) =>
    runtime.getSnapshot(request.params.id),
  );
  app.patch<{ Params: { id: string } }>("/api/v1/sessions/:id", async (request) => {
    if (!Value.Check(UpdateSessionRequestSchema, request.body))
      throw new Error("Invalid update-session request");
    return runtime.updateSession(request.params.id, request.body);
  });
  app.delete<{ Params: { id: string } }>("/api/v1/sessions/:id", async (request, reply) => {
    runtime.deleteSession(request.params.id);
    return reply.code(204).send();
  });
  app.post<{ Params: { id: string } }>("/api/v1/sessions/:id/messages", async (request, reply) => {
    if (!Value.Check(SendMessageRequestSchema, request.body)) throw new Error("Invalid message request");
    const run = runtime.sendMessage(request.params.id, request.body);
    return reply.code(202).send({ runId: run.id, status: run.status });
  });
  app.post<{ Params: { id: string } }>("/api/v1/sessions/:id/cancel", async (request, reply) => {
    runtime.cancel(request.params.id);
    return reply.code(204).send();
  });
  app.post<{ Params: { id: string }; Body: { approved?: boolean } }>(
    "/api/v1/approvals/:id",
    async (request) => runtime.resolveApproval(request.params.id, request.body?.approved === true),
  );
  app.get("/api/v1/models", async () => runtime.listModels());
  app.get("/api/v1/skills", async () => runtime.listSkills());
  app.post("/api/v1/skills/refresh", async () => runtime.refreshSkills());
  app.get("/api/v1/mcp", async () => runtime.mcp.status());
  app.get("/api/v1/knowledge", async () => runtime.knowledge.list());
  app.post<{ Body: { name?: string; path?: string } }>("/api/v1/knowledge", async (request) => {
    if (!request.body?.name || !request.body.path) throw new Error("name and path are required");
    const path = await runtime.workspacePolicy.resolvePath(
      runtime.config.server.workspaceRoots[0] as string,
      request.body.path,
    );
    return runtime.knowledge.index(request.body.name, path);
  });
  app.post("/api/v1/uploads", async (request) => {
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

  app.get("/api/v1/events", { websocket: true }, (socket, request) => {
    const origin = request.headers.origin;
    const sameOrigin =
      !origin || sameHost(origin, request.headers.host) || runtime.config.server.webOrigins.includes(origin);
    if (!sameOrigin) {
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
      if (message.type === "subscribe" && Array.isArray(message.sessionIds)) {
        sessions.clear();
        for (const id of message.sessionIds.slice(0, 100)) sessions.add(id);
      }
    });
    socket.on("close", () => {
      clearTimeout(timer);
      unsubscribe();
    });
  });

  app.all("/api/v1/*", async (_request, reply) =>
    reply.code(404).send({ error: { code: "not_found", message: "API route not found" } }),
  );

  app.setErrorHandler((cause, _request, reply) => {
    const error = cause instanceof Error ? cause : new Error(String(cause));
    let message = error.message.replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]");
    const secrets = [
      process.env[runtime.config.auth.tokenEnv],
      ...runtime.config.models.map((model) => process.env[model.apiKeyEnv]),
    ].filter((value): value is string => Boolean(value));
    for (const secret of secrets) message = message.split(secret).join("[REDACTED]");
    app.log.error({ err: { name: error.name, message } }, "request failed");
    const notFound = /not found/i.test(error.message);
    reply.code(notFound ? 404 : 400).send({
      error: {
        code: notFound ? "not_found" : "invalid_request",
        message,
      },
    });
  });

  const webRoot = resolve(process.cwd(), "apps/web/dist");
  if (existsSync(webRoot)) {
    await app.register(staticPlugin, { root: webRoot, wildcard: false });
    app.get("/*", async (_request, reply) => reply.sendFile("index.html"));
  } else {
    app.get("/", async (_request, reply) =>
      reply.type("text/html").send("<h1>UmaAgent</h1><p>Web application has not been built.</p>"),
    );
  }
  return app;
}
