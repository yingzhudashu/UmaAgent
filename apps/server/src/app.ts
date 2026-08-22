import { existsSync } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import staticPlugin from "@fastify/static";
import websocket from "@fastify/websocket";
import type { UmaConfig, UmaRuntime } from "@uma-agent/core";
import {
  CommandRequestSchema,
  CreateEvaluationReportSchema,
  CreateScheduledTaskRequestSchema,
  CreateSessionRequestSchema,
  ImproveMessageRequestSchema,
  PROTOCOL_VERSION,
  ReviewMessageRequestSchema,
  type Run,
  RunActionDecisionSchema,
  SendMessageRequestSchema,
  SkillInstallRequestSchema,
  UpdateScheduledTaskRequestSchema,
  UpdateSessionRequestSchema,
} from "@uma-agent/protocol";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import Value from "typebox/value";
import type { RawData } from "ws";
import { type AuthPrincipal, AuthService } from "./auth.js";

type SocketMessage = {
  type?: string;
  token?: string;
  sessions?: Array<{ id?: string; lastSequence?: number }>;
};

function userPrincipal(auth: AuthService, request: FastifyRequest): AuthPrincipal {
  const principal = auth.principalFromRequest(request);
  if (!principal) throw new Error("Authentication required");
  return principal;
}

function allowedOrigin(origin: string, configured: string[]): boolean {
  return configured.includes(origin);
}

export function crossOrigin(origin: string | undefined, host: string | undefined): boolean {
  if (!origin || !host) return false;
  try {
    return new URL(origin).host !== host;
  } catch {
    return true;
  }
}

export function secureOrigin(origin: string | undefined): boolean {
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

export function shouldCloseForBufferedAmount(bufferedAmount: number, maxBufferedBytes: number): boolean {
  return bufferedAmount > maxBufferedBytes;
}

export async function createServer(
  runtime: UmaRuntime,
  options: { webRoot?: string | false; configLoader?: () => Promise<UmaConfig> } = {},
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
      !request.url.startsWith("/api/v10/") ||
      request.url === "/api/v10/health/live" ||
      request.url === "/api/v10/health/ready" ||
      request.url === "/api/v10/auth/login" ||
      request.url === "/api/v10/auth/register" ||
      request.url === "/api/v10/auth/authorize" ||
      request.url === "/api/v10/auth/token" ||
      request.url === "/api/v10/events"
    )
      return;
    if (!auth.requestAuthenticated(request))
      return reply.code(401).send(errorBody(request.id, "auth_required", "Authentication required"));
    const principal = auth.principalFromRequest(request);
    if (
      principal?.method === "break_glass" &&
      process.env.NODE_ENV !== "test" &&
      !request.url.startsWith("/api/v10/admin/")
    )
      return reply.code(403).send(errorBody(request.id, "forbidden", "Break-glass access is restricted"));
  });

  const health = (ready: boolean) => ({
    status: ready ? ("ok" as const) : ("degraded" as const),
    version: "1.2.0",
    protocolVersion: PROTOCOL_VERSION,
    activeRuns: runtime.health().activeRuns,
  });
  app.get("/api/v10/health/live", async () => health(true));
  app.get("/api/v10/health/ready", async (_request, reply) => {
    const runtimeHealth = runtime.health();
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
      runtimeHealth.started && runtimeHealth.databaseReady && workspacesReady && modelsReady && mcpReady,
    );
    return reply.code(value.status === "ok" ? 200 : 503).send(value);
  });
  app.post<{ Body: { token?: string } }>("/api/v10/auth/login", async (request, reply) => {
    if (!auth.loginAllowed(request.ip))
      return reply.code(429).send(errorBody(request.id, "rate_limited", "Too many login attempts", true));
    const personal = request.body?.token
      ? auth.principalFromRequest({
          headers: { authorization: `Bearer ${request.body.token}` },
          cookies: {},
        } as FastifyRequest)
      : undefined;
    const principal = personal?.method === "break_glass" ? auth.testBreakGlassPrincipal() : personal;
    if (!principal) {
      auth.recordFailure(request.ip);
      return reply.code(401).send(errorBody(request.id, "auth_required", "Invalid token"));
    }
    const origin = request.headers.origin;
    auth.createWebSession(reply, principal.userId, {
      crossOrigin: crossOrigin(origin, request.headers.host),
      secure: secureOrigin(origin),
    });
    runtime.database.touchUserLogin(principal.userId);
    return { ok: true };
  });
  app.post<{ Body: { label?: string } }>("/api/v10/auth/register", async (request, reply) => {
    if (!auth.registrationAllowed(request.ip))
      return reply
        .code(429)
        .send(errorBody(request.id, "rate_limited", "Too many registration attempts", true));
    const issued = auth.register(request.body?.label);
    auth.recordRegistration(request.ip);
    const origin = request.headers.origin;
    auth.createWebSession(reply, issued.userId, {
      crossOrigin: crossOrigin(origin, request.headers.host),
      secure: secureOrigin(origin),
    });
    return reply
      .code(201)
      .send({ userId: issued.userId, token: issued.token, tokenId: issued.id, expiresAt: issued.expiresAt });
  });
  app.get("/api/v10/auth/me", async (request) => {
    const principal = userPrincipal(auth, request);
    return {
      userId: principal.userId,
      role: principal.role,
      method: principal.method,
      scopes: principal.scopes,
      tokens: runtime.database.listAuthTokens(principal.userId),
    };
  });
  app.post<{ Body: { label?: string; expiresInDays?: number } }>("/api/v10/auth/tokens", async (request) => {
    const principal = userPrincipal(auth, request);
    if (principal.method === "break_glass") throw new Error("Break-glass cannot create user tokens");
    const issued = auth.issueToken(principal.userId, request.body?.label, request.body?.expiresInDays);
    return { token: issued.token, tokenId: issued.id, expiresAt: issued.expiresAt };
  });
  app.delete<{ Params: { id: string } }>("/api/v10/auth/tokens/:id", async (request, reply) => {
    const principal = userPrincipal(auth, request);
    if (!runtime.database.revokeAuthToken(principal.userId, request.params.id))
      return reply.code(404).send(errorBody(request.id, "not_found", "Token not found"));
    return reply.code(204).send();
  });
  app.post<{
    Body: { token?: string; clientId?: string; redirectUri?: string; codeChallenge?: string };
  }>("/api/v10/auth/authorize", async (request) => {
    if (
      !request.body?.token ||
      !request.body.clientId ||
      !request.body.redirectUri ||
      !request.body.codeChallenge
    )
      throw new Error("token, clientId, redirectUri and codeChallenge are required");
    return auth.authorize(request.body.token, {
      clientId: request.body.clientId,
      redirectUri: request.body.redirectUri,
      codeChallenge: request.body.codeChallenge,
    });
  });
  app.post<{
    Body: { code?: string; clientId?: string; redirectUri?: string; codeVerifier?: string };
  }>("/api/v10/auth/token", async (request) => {
    if (
      !request.body?.code ||
      !request.body.clientId ||
      !request.body.redirectUri ||
      !request.body.codeVerifier
    )
      throw new Error("code, clientId, redirectUri and codeVerifier are required");
    return auth.exchangeAuthorizationCode(
      request.body as {
        code: string;
        clientId: string;
        redirectUri: string;
        codeVerifier: string;
      },
    );
  });
  const requireSessionOwner = (request: FastifyRequest, sessionId: string): AuthPrincipal => {
    const principal = userPrincipal(auth, request);
    if (principal.method !== "break_glass" && runtime.database.sessionOwner(sessionId) !== principal.userId)
      throw new Error("Session not found");
    return principal;
  };
  const requireOwned = (request: FastifyRequest, ownerId: string | undefined): AuthPrincipal => {
    const principal = userPrincipal(auth, request);
    if (principal.method !== "break_glass" && ownerId !== principal.userId)
      throw new Error("Resource not found");
    return principal;
  };
  const requireAdmin = (request: FastifyRequest): AuthPrincipal => {
    const principal = userPrincipal(auth, request);
    if (principal.role !== "admin") throw new Error("Administrator access required");
    return principal;
  };
  const ownedResult = <T>(request: FastifyRequest, ownerId: string | undefined, action: () => T): T => {
    requireOwned(request, ownerId);
    return action();
  };
  const adminResult = <T>(request: FastifyRequest, action: () => T): T => {
    requireAdmin(request);
    return action();
  };
  app.post("/api/v10/auth/logout", async (request, reply) => {
    const origin = request.headers.origin;
    auth.logout(request, reply, {
      crossOrigin: crossOrigin(origin, request.headers.host),
      secure: secureOrigin(origin),
    });
    return reply.code(204).send();
  });

  app.get("/api/v10/sessions", async (request) => {
    const principal = userPrincipal(auth, request);
    return principal.method === "break_glass"
      ? runtime.listSessions()
      : runtime.listSessions(principal.userId);
  });
  app.post("/api/v10/sessions", async (request) => {
    const body = request.body ?? {};
    if (!Value.Check(CreateSessionRequestSchema, body)) throw new Error("Invalid create-session request");
    const principal = userPrincipal(auth, request);
    return runtime.createSession(body, principal.method === "break_glass" ? undefined : principal.userId);
  });
  app.get<{ Params: { id: string } }>("/api/v10/sessions/:id/snapshot", async (request) =>
    ownedResult(request, runtime.database.sessionOwner(request.params.id), () =>
      runtime.getSnapshot(request.params.id),
    ),
  );
  app.get<{ Params: { id: string }; Querystring: { after?: string; limit?: string } }>(
    "/api/v10/sessions/:id/events",
    async (request) =>
      ownedResult(request, runtime.database.sessionOwner(request.params.id), () =>
        runtime.listSessionEvents(
          request.params.id,
          Math.max(0, Number(request.query.after ?? 0)),
          Math.max(1, Math.min(1000, Number(request.query.limit ?? 500))),
        ),
      ),
  );
  app.get<{ Params: { id: string }; Querystring: { before?: string; limit?: string } }>(
    "/api/v10/sessions/:id/history",
    async (request) =>
      ownedResult(request, runtime.database.sessionOwner(request.params.id), () =>
        runtime.listSessionHistory(
          request.params.id,
          request.query.before === undefined ? undefined : Math.max(1, Number(request.query.before)),
          Math.max(1, Math.min(500, Number(request.query.limit ?? 100))),
        ),
      ),
  );
  app.post<{ Params: { id: string } }>("/api/v10/sessions/:id/compact", async (request) =>
    ownedResult(request, runtime.database.sessionOwner(request.params.id), () =>
      runtime.compactSession(request.params.id),
    ),
  );
  app.patch<{ Params: { id: string } }>("/api/v10/sessions/:id", async (request) => {
    if (!Value.Check(UpdateSessionRequestSchema, request.body))
      throw new Error("Invalid update-session request");
    requireSessionOwner(request, request.params.id);
    return runtime.updateSession(request.params.id, request.body);
  });
  app.delete<{ Params: { id: string } }>("/api/v10/sessions/:id", async (request, reply) => {
    requireSessionOwner(request, request.params.id);
    runtime.deleteSession(request.params.id);
    return reply.code(204).send();
  });
  app.post<{ Params: { id: string } }>("/api/v10/sessions/:id/messages", async (request, reply) => {
    if (!Value.Check(SendMessageRequestSchema, request.body)) throw new Error("Invalid message request");
    requireSessionOwner(request, request.params.id);
    const run = runtime.sendMessage(request.params.id, request.body);
    return reply.code(202).send({ runId: run.id, status: run.status });
  });
  app.post<{ Params: { id: string }; Body: { command?: string; messageId?: string } }>(
    "/api/v10/sessions/:id/commands",
    async (request, reply) => {
      if (!Value.Check(CommandRequestSchema, request.body)) throw new Error("Invalid command request");
      requireSessionOwner(request, request.params.id);
      const run = runtime.sendCommand(request.params.id, request.body.command, request.body.messageId);
      return reply.code(202).send({ runId: run.id, status: run.status });
    },
  );
  app.get<{ Params: { id: string }; Querystring: { q?: string; limit?: string } }>(
    "/api/v10/sessions/:id/history/search",
    async (request) =>
      ownedResult(request, runtime.database.sessionOwner(request.params.id), () =>
        runtime.searchHistory(request.params.id, request.query.q ?? "", Number(request.query.limit ?? 20)),
      ),
  );
  app.get<{ Params: { id: string }; Querystring: { limit?: string } }>(
    "/api/v10/sessions/:id/activity",
    async (request) =>
      ownedResult(request, runtime.database.sessionOwner(request.params.id), () =>
        runtime.listActivity(request.params.id, Number(request.query.limit ?? 200)),
      ),
  );
  app.post<{ Params: { id: string } }>("/api/v10/sessions/:id/cancel", async (request, reply) => {
    requireSessionOwner(request, request.params.id);
    runtime.cancel(request.params.id);
    return reply.code(204).send();
  });
  app.post<{ Params: { id: string }; Body: { approved?: boolean } }>(
    "/api/v10/approvals/:id",
    async (request) =>
      ownedResult(request, runtime.database.approvalOwner(request.params.id), () =>
        runtime.resolveApproval(request.params.id, request.body?.approved === true),
      ),
  );
  app.get("/api/v10/models", async () => runtime.listModels());
  app.get("/api/v10/skills", async () => ({
    available: runtime.listSkills(),
    packages: runtime.listSkillPackages(),
  }));
  app.post("/api/v10/skills/refresh", async (request) => adminResult(request, () => runtime.refreshSkills()));
  app.post("/api/v10/admin/reload", async (request) => {
    requireAdmin(request);
    if (!options.configLoader) throw new Error("Configuration reload is unavailable");
    return runtime.reloadConfig(await options.configLoader());
  });
  app.get("/api/v10/admin/config", async (request) => adminResult(request, () => runtime.publicConfig()));
  app.get<{ Querystring: { q?: string } }>("/api/v10/skills/search", async (request) =>
    runtime.searchSkills(request.query.q ?? ""),
  );
  app.post("/api/v10/skills/install", async (request) => {
    requireAdmin(request);
    if (!Value.Check(SkillInstallRequestSchema, request.body))
      throw new Error("Invalid skill install request");
    return runtime.installSkill(request.body);
  });
  for (const status of ["enable", "disable", "reject"] as const)
    app.post<{ Params: { id: string } }>(`/api/v10/skills/:id/${status}`, async (request) =>
      adminResult(request, () =>
        runtime.setSkillStatus(
          request.params.id,
          status === "enable" ? "enabled" : status === "disable" ? "disabled" : "rejected",
        ),
      ),
    );
  app.get("/api/v10/profile", async (request) => adminResult(request, () => runtime.getAgentProfile()));
  app.put<{ Body: { content?: string } }>("/api/v10/profile", async (request) => {
    requireAdmin(request);
    if (typeof request.body?.content !== "string") throw new Error("Profile content is required");
    return runtime.updateAgentProfile(request.body.content);
  });
  app.get("/api/v10/mcp", async (request) => adminResult(request, () => runtime.mcp.status()));
  app.get("/api/v10/knowledge", async (request) => adminResult(request, () => runtime.knowledge.list()));
  app.get<{ Querystring: { q?: string; sourceId?: string; limit?: string } }>(
    "/api/v10/knowledge/search",
    async (request) =>
      adminResult(request, () =>
        runtime.knowledge.search(
          request.query.q ?? "",
          Math.max(1, Math.min(100, Number(request.query.limit ?? 20))),
          request.query.sourceId,
        ),
      ),
  );
  app.post<{ Body: { name?: string; path?: string; attachmentId?: string; sessionId?: string } }>(
    "/api/v10/knowledge",
    async (request) => {
      requireAdmin(request);
      if (!request.body?.name || (!request.body.path && !request.body.attachmentId))
        throw new Error("name and either path or attachmentId are required");
      if (request.body.attachmentId && !request.body.sessionId)
        throw new Error("sessionId is required when indexing an attachment");
      const path = request.body.attachmentId
        ? runtime.database.getAttachmentPath(request.body.attachmentId, request.body.sessionId)
        : await runtime.workspacePolicy.resolvePath(
            runtime.config.server.workspaceRoots[0] as string,
            request.body.path as string,
          );
      const source = await runtime.knowledge.enqueue(request.body.name, path);
      runtime.invalidateResource("knowledge");
      return source;
    },
  );
  app.delete<{ Params: { id: string } }>("/api/v10/knowledge/:id", async (request, reply) => {
    requireAdmin(request);
    runtime.knowledge.delete(request.params.id);
    runtime.invalidateResource("knowledge");
    return reply.code(204).send();
  });
  app.post<{ Params: { id: string } }>("/api/v10/knowledge/:id/reindex", async (request) =>
    adminResult(request, () => runtime.knowledge.reindex(request.params.id)),
  );
  app.get("/api/v10/tasks", async (request) => {
    const principal = userPrincipal(auth, request);
    return runtime.listTasks(principal.method === "break_glass" ? undefined : principal.userId);
  });
  app.post<{ Body: { prompt?: string; parentSessionId?: string } }>("/api/v10/tasks", async (request) => {
    if (!request.body?.prompt || typeof request.body.prompt !== "string")
      throw new Error("prompt is required");
    if (request.body.parentSessionId) requireSessionOwner(request, request.body.parentSessionId);
    const principal = userPrincipal(auth, request);
    return runtime.createTask(
      request.body.prompt,
      request.body.parentSessionId,
      undefined,
      undefined,
      principal.method === "break_glass" ? undefined : principal.userId,
    );
  });
  app.get<{ Params: { id: string } }>("/api/v10/tasks/:id", async (request) =>
    ownedResult(request, runtime.database.taskOwner(request.params.id), () =>
      runtime.getTask(request.params.id),
    ),
  );
  app.get<{ Params: { id: string } }>("/api/v10/tasks/:id/snapshot", async (request) =>
    ownedResult(request, runtime.database.taskOwner(request.params.id), () =>
      runtime.getSnapshot(runtime.getTask(request.params.id).sessionId),
    ),
  );
  app.post<{ Params: { id: string } }>("/api/v10/tasks/:id/cancel", async (request) =>
    ownedResult(request, runtime.database.taskOwner(request.params.id), () =>
      runtime.cancelTask(request.params.id),
    ),
  );
  app.delete<{ Params: { id: string } }>("/api/v10/tasks/:id", async (request, reply) => {
    requireOwned(request, runtime.database.taskOwner(request.params.id));
    runtime.deleteTask(request.params.id);
    return reply.code(204).send();
  });
  app.get("/api/v10/schedules", async (request) => adminResult(request, () => runtime.listScheduledTasks()));
  app.post("/api/v10/schedules", async (request) => {
    requireAdmin(request);
    if (!Value.Check(CreateScheduledTaskRequestSchema, request.body))
      throw new Error("Invalid scheduled task request");
    return runtime.createScheduledTask(request.body);
  });
  app.patch<{ Params: { id: string } }>("/api/v10/schedules/:id", async (request) => {
    requireAdmin(request);
    if (!Value.Check(UpdateScheduledTaskRequestSchema, request.body))
      throw new Error("Invalid scheduled task update");
    return runtime.updateScheduledTask(request.params.id, request.body);
  });
  app.delete<{ Params: { id: string } }>("/api/v10/schedules/:id", async (request, reply) => {
    requireAdmin(request);
    runtime.deleteScheduledTask(request.params.id);
    return reply.code(204).send();
  });
  app.post<{ Params: { id: string } }>("/api/v10/schedules/:id/run", async (request) =>
    adminResult(request, () => runtime.runScheduledTask(request.params.id)),
  );
  app.get<{ Params: { id: string } }>("/api/v10/schedules/:id/runs", async (request) =>
    adminResult(request, () => runtime.listScheduledTaskRuns(request.params.id)),
  );
  app.get<{ Params: { id: string } }>("/api/v10/schedule-runs/:id", async (request) =>
    adminResult(request, () => runtime.getScheduledTaskRun(request.params.id)),
  );
  app.post<{ Params: { id: string } }>("/api/v10/schedule-runs/:id/cancel", async (request) =>
    adminResult(request, () => runtime.cancelScheduledTaskRun(request.params.id)),
  );
  app.get<{ Querystring: { status?: "active" | "candidate" | "superseded" | "rejected" } }>(
    "/api/v10/memory",
    async (request) => adminResult(request, () => runtime.listMemoryFacts(request.query.status)),
  );
  app.post<{ Body: { sessionId?: string; scope?: "global" | "session"; content?: string } }>(
    "/api/v10/memory",
    async (request) => {
      requireAdmin(request);
      if (!request.body?.sessionId || !request.body.content)
        throw new Error("sessionId and content are required");
      return runtime.createMemoryFact(
        request.body.sessionId,
        request.body.scope ?? "session",
        request.body.content,
      );
    },
  );
  app.post<{ Params: { id: string }; Body: { status?: "active" | "candidate" | "superseded" | "rejected" } }>(
    "/api/v10/memory/:id",
    async (request) => {
      requireAdmin(request);
      const status = request.body?.status;
      if (!status || !["active", "candidate", "superseded", "rejected"].includes(status))
        throw new Error("Invalid memory status");
      return runtime.reviewMemoryFact(request.params.id, status);
    },
  );
  app.delete<{ Params: { id: string } }>("/api/v10/memory/:id", async (request, reply) => {
    requireAdmin(request);
    runtime.deleteMemoryFact(request.params.id);
    return reply.code(204).send();
  });
  app.get<{ Params: { runId: string } }>("/api/v10/audit/runs/:runId", async (request) =>
    runtime.audit(request.params.runId),
  );
  app.get<{ Querystring: { from?: string; to?: string } }>("/api/v10/reports/operations", async (request) => {
    requireAdmin(request);
    const to = request.query.to ? Number(request.query.to) : Date.now();
    const from = request.query.from ? Number(request.query.from) : to - 7 * 24 * 60 * 60_000;
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to < from)
      throw new Error("Invalid report time range");
    return runtime.database.operationsReport(from, to);
  });
  app.get<{ Querystring: { from?: string; to?: string } }>(
    "/api/v10/reports/diagnostics",
    async (request) => {
      requireAdmin(request);
      const from = Number(request.query.from ?? 0);
      const to = Number(request.query.to ?? Date.now());
      if (!Number.isFinite(from) || !Number.isFinite(to) || from < 0 || to < from)
        throw new Error("Invalid diagnostics report range");
      return runtime.database.diagnosticsReport(from, to);
    },
  );
  app.get("/api/v10/optimization-proposals", async (request) =>
    adminResult(request, () => runtime.listOptimizationProposals()),
  );
  app.get<{ Querystring: { limit?: string } }>("/api/v10/evaluations", async (request) =>
    adminResult(request, () => runtime.listEvaluationReports(Number(request.query.limit ?? 100))),
  );
  app.get<{ Params: { id: string } }>("/api/v10/evaluations/:id", async (request) =>
    adminResult(request, () => runtime.getEvaluationReport(request.params.id)),
  );
  app.post("/api/v10/evaluations", async (request) => {
    requireAdmin(request);
    if (!Value.Check(CreateEvaluationReportSchema, request.body))
      throw new Error("Invalid evaluation report");
    return runtime.createEvaluationReport(request.body);
  });
  app.post<{ Body: { from?: number; to?: number } }>(
    "/api/v10/optimization-proposals/generate",
    async (request) => {
      requireAdmin(request);
      const from = request.body?.from ?? 0;
      const to = request.body?.to ?? Date.now();
      if (!Number.isFinite(from) || !Number.isFinite(to) || from < 0 || to < from)
        throw new Error("Invalid optimization report range");
      return runtime.generateOptimizationProposals(from, to);
    },
  );
  app.post<{ Params: { id: string }; Body: { status?: "accepted" | "rejected" } }>(
    "/api/v10/optimization-proposals/:id/decision",
    async (request) => {
      requireAdmin(request);
      if (request.body?.status !== "accepted" && request.body?.status !== "rejected")
        throw new Error("Invalid optimization proposal decision");
      return runtime.decideOptimizationProposal(request.params.id, request.body.status);
    },
  );
  app.get<{ Params: { id: string } }>("/api/v10/runs/:id", async (request) =>
    ownedResult(request, runtime.database.runOwner(request.params.id), () =>
      runtime.getRun(request.params.id),
    ),
  );
  app.get<{ Params: { id: string } }>("/api/v10/runs/:id/quality", async (request) =>
    ownedResult(request, runtime.database.runOwner(request.params.id), () =>
      runtime.listQualityAssessments(request.params.id),
    ),
  );
  app.post<{ Params: { id: string }; Body: { feedback?: string } }>(
    "/api/v10/messages/:id/review",
    async (request, reply) => {
      if (!Value.Check(ReviewMessageRequestSchema, request.body ?? {}))
        throw new Error("Invalid review request");
      requireOwned(request, runtime.database.messageOwner(request.params.id));
      const run = runtime.reviewMessage(request.params.id, request.body?.feedback ?? "");
      return reply.code(202).send({ runId: run.id, status: run.status });
    },
  );
  app.post<{ Params: { id: string }; Body: { force?: boolean; reset?: boolean } }>(
    "/api/v10/messages/:id/improve",
    async (request, reply) => {
      if (!Value.Check(ImproveMessageRequestSchema, request.body ?? {}))
        throw new Error("Invalid improve request");
      requireOwned(request, runtime.database.messageOwner(request.params.id));
      const run = runtime.improveMessage(request.params.id, request.body ?? {});
      return reply.code(202).send({ runId: run.id, status: run.status });
    },
  );
  app.get<{ Params: { id: string } }>("/api/v10/runs/:id/checkpoints", async (request) =>
    ownedResult(request, runtime.database.runOwner(request.params.id), () =>
      runtime.listRunCheckpoints(request.params.id),
    ),
  );
  app.get<{ Params: { id: string } }>("/api/v10/runs/:id/actions", async (request) =>
    ownedResult(request, runtime.database.runOwner(request.params.id), () =>
      runtime.listRunActions(request.params.id),
    ),
  );
  app.post<{ Params: { id: string } }>("/api/v10/runs/:id/resume", async (request) =>
    ownedResult(request, runtime.database.runOwner(request.params.id), () =>
      runtime.resumeRun(request.params.id),
    ),
  );
  app.post<{ Params: { id: string; actionId: string }; Body: { decision?: string } }>(
    "/api/v10/runs/:id/actions/:actionId/decide",
    async (request) => {
      if (!Value.Check(RunActionDecisionSchema, request.body)) throw new Error("Invalid action decision");
      requireOwned(request, runtime.database.runOwner(request.params.id));
      return runtime.decideRunAction(request.params.id, request.params.actionId, request.body.decision);
    },
  );
  app.post<{ Params: { id: string } }>("/api/v10/runs/:id/cancel", async (request) => {
    requireOwned(request, runtime.database.runOwner(request.params.id));
    return runtime.cancelRun(request.params.id);
  });
  app.post("/api/v10/uploads", async (request) => {
    const parts = request.parts();
    let sessionId: string | undefined;
    let upload: { name: string; mimeType: string; data: Buffer } | undefined;
    for await (const part of parts) {
      if (part.type === "file")
        upload = { name: part.filename, mimeType: part.mimetype, data: await part.toBuffer() };
      else if (part.fieldname === "sessionId") sessionId = String(part.value);
    }
    if (!upload) throw new Error("file is required");
    const principal = userPrincipal(auth, request);
    if (!sessionId && principal.method !== "break_glass")
      throw new Error("sessionId is required for user uploads");
    if (sessionId) requireSessionOwner(request, sessionId);
    return runtime.addAttachment({ ...(sessionId ? { sessionId } : {}), ...upload });
  });
  app.get<{ Params: { id: string } }>("/api/v10/attachments/:id/content", async (request, reply) => {
    requireOwned(request, runtime.database.attachmentOwner(request.params.id));
    const attachment = runtime.getAttachment(request.params.id);
    if (!attachment) throw new Error(`Attachment not found: ${request.params.id}`);
    const data = await readFile(runtime.getAttachmentPath(request.params.id));
    return reply
      .type(attachment.mimeType)
      .header("content-disposition", `inline; filename*=UTF-8''${encodeURIComponent(attachment.name)}`)
      .send(data);
  });

  app.get("/api/v10/events", { websocket: true }, (socket, request) => {
    const origin = request.headers.origin;
    if (origin && !allowedOrigin(origin, runtime.config.server.webOrigins)) {
      socket.close(1008, "Origin is not allowed");
      return;
    }
    let principal = auth.principalFromRequest(request);
    let authenticated = Boolean(principal);
    let resourceResyncSent = false;
    const sessions = new Set<string>();
    const maxBufferedBytes = 4 * 1024 * 1024;
    const send = (payload: unknown): boolean => {
      if (socket.readyState !== socket.OPEN) return false;
      if (shouldCloseForBufferedAmount(socket.bufferedAmount, maxBufferedBytes)) {
        socket.close(1013, "WebSocket send buffer exceeded limit; resync required");
        return false;
      }
      socket.send(JSON.stringify(payload));
      return true;
    };
    const unsubscribe = runtime.subscribe((event) => {
      if (authenticated && sessions.has(event.sessionId)) send(event);
    });
    const unsubscribeResources = runtime.subscribeResources((event) => {
      // Resource invalidations currently describe global/admin-owned state. Do not
      // broadcast them to regular users until each resource has an owner filter.
      if (authenticated && principal?.role === "admin") send(event);
    });
    const sendResourceResync = () => {
      if (
        !authenticated ||
        principal?.role !== "admin" ||
        resourceResyncSent ||
        socket.readyState !== socket.OPEN
      )
        return;
      resourceResyncSent = true;
      send({
        type: "resource.resync_required",
        protocolVersion: PROTOCOL_VERSION,
        resources: [
          "tasks",
          "schedules",
          "memory",
          "knowledge",
          "skills",
          "profile",
          "quality",
          "config",
          "evaluations",
          "optimization",
        ],
        timestamp: Date.now(),
      });
    };
    sendResourceResync();
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
      if (message.type === "auth") {
        const synthetic = {
          headers: { authorization: message.token ? `Bearer ${message.token}` : "" },
          cookies: {},
        } as FastifyRequest;
        principal = auth.principalFromRequest(synthetic);
        authenticated = Boolean(principal);
      }
      if (!authenticated) {
        socket.close(1008, "Authentication required");
        return;
      }
      sendResourceResync();
      if (message.type === "subscribe" && Array.isArray(message.sessions)) {
        sessions.clear();
        for (const subscription of message.sessions.slice(0, 100)) {
          const id = subscription.id;
          if (!id) continue;
          if (principal?.method !== "break_glass" && runtime.database.sessionOwner(id) !== principal?.userId)
            continue;
          sessions.add(id);
          send({ type: "sync.started", sessionId: id });
          let after = Math.max(0, subscription.lastSequence ?? 0);
          let page = runtime.listSessionEvents(id, after, 1000);
          while (true) {
            for (const event of page.events) {
              if (!send(event)) return;
            }
            after = page.nextSequence;
            if (!page.hasMore) break;
            page = runtime.listSessionEvents(id, after, 1000);
          }
          send({ type: "sync.completed", sessionId: id, sequence: page.snapshotSequence });
        }
      }
    });
    socket.on("close", () => {
      clearTimeout(timer);
      unsubscribe();
      unsubscribeResources();
    });
  });

  app.all("/api/v10/*", async (request, reply) =>
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
