import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { UmaRuntime } from "@uma-agent/core";
import {
  XianyuAutoReplyRequestSchema,
  XianyuInternalInboundRequestSchema,
  XianyuInternalSessionRequestSchema,
} from "@uma-agent/protocol";
import type { TraceParent } from "@uma-agent/telemetry";
import type { FastifyInstance, FastifyRequest } from "fastify";
import Value from "typebox/value";
import type { AuthPrincipal } from "./auth.js";
import { validateXianyuChatBody, validateXianyuPublishBody, XianyuControlClient } from "./xianyu.js";

// 渠道路由集中处理管理员权限、内部回环鉴权和消息投递；普通会话路由不参与渠道状态转换。
export function registerXianyuRoutes(
  app: FastifyInstance,
  runtime: UmaRuntime,
  xianyu: XianyuControlClient | undefined,
  requireAdmin: (request: FastifyRequest, message?: string) => AuthPrincipal,
  requestTrace: (request: FastifyRequest) => TraceParent | undefined,
): void {
  const requireXianyu = (request: FastifyRequest): AuthPrincipal => {
    const principal = requireAdmin(request, "Xianyu administrator access required");
    if (!xianyu) throw new Error("Xianyu service is not configured");
    return principal;
  };
  const requireInternalXianyu = (request: FastifyRequest): void => {
    const remote = request.socket.remoteAddress ?? "";
    if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(remote))
      throw new Error("Xianyu internal access forbidden: loopback required");
    const controlToken = runtime.config.xianyu
      ? process.env[runtime.config.xianyu.controlTokenEnv]?.trim()
      : undefined;
    if (!controlToken || request.headers.authorization !== `Bearer ${controlToken}`)
      throw new Error("Xianyu internal access forbidden: invalid control token");
  };
  const xianyuClient = (request: FastifyRequest): XianyuControlClient => {
    const config = runtime.config.xianyu;
    if (!config) throw new Error("Xianyu service is not configured");
    // 请求上下文按实例隔离，避免并发管理员操作串用 Trace；底层 fetch 仍复用连接池。
    return new XianyuControlClient(
      config.adapterUrl,
      process.env[config.controlTokenEnv]?.trim() ?? "",
      requestTrace(request),
    );
  };
  const channelWorkspace = join(runtime.config.server.workspaceRoots[0] as string, "channels", "xianyu");
  const ensureXianyuSession = async (input: {
    tenantId: string;
    conversationId: string;
    threadId?: string;
    kind: "control" | "buyer";
    displayName?: string;
    externalUserId?: string;
    itemId?: string;
  }) => {
    await mkdir(channelWorkspace, { recursive: true });
    return runtime.database.withTransaction(() => {
      const existing = runtime.database.findChannelSession(
        input.tenantId,
        input.conversationId,
        input.threadId ?? "",
      );
      if (existing) {
        runtime.database.updateChannelSession({
          sessionId: existing,
          ...(input.displayName ? { displayName: input.displayName } : {}),
          ...(input.externalUserId ? { externalUserId: input.externalUserId } : {}),
          ...(input.itemId ? { itemId: input.itemId } : {}),
        });
        return runtime.database.getSession(existing);
      }
      const session = runtime.database.createSession({
        userId: "system",
        title:
          input.kind === "control"
            ? "咸鱼总控"
            : input.displayName?.trim() || `咸鱼买家 ${input.conversationId}`,
        assistantName: "UmaAgent · 咸鱼",
        workspace: channelWorkspace,
        model: runtime.config.defaultModel,
        thinkingLevel: runtime.config.defaultThinkingLevel,
      });
      runtime.database.attachChannelSession({ sessionId: session.id, ...input });
      return session;
    });
  };

  app.get("/api/v15/xianyu/workspace", async (request) => {
    requireXianyu(request);
    await ensureXianyuSession({
      tenantId: "xianyu",
      conversationId: "__control__",
      kind: "control",
      displayName: "咸鱼总控",
    });
    const [serviceResult, loginResult] = await Promise.allSettled([
      xianyuClient(request).health(),
      xianyuClient(request).loginStatus(),
    ]);
    const unavailable = (result: PromiseRejectedResult) => ({
      status: "degraded",
      message: result.reason instanceof Error ? result.reason.message : "咸鱼 Adapter 不可用",
    });
    return {
      workspace: "xianyu",
      autoReplyEnabled: runtime.database.xianyuAutoReplyEnabled(),
      service: serviceResult.status === "fulfilled" ? serviceResult.value : unavailable(serviceResult),
      login: loginResult.status === "fulfilled" ? loginResult.value : unavailable(loginResult),
      sessions: runtime.database.listChannelSessions("xianyu").map(({ session, metadata }) => ({
        session,
        metadata,
        lastSequence: runtime.listSessionEvents(session.id, 0, 1).snapshotSequence,
        draftMessageIds: runtime.database.listChannelDraftMessageIds(session.id),
      })),
      serverTime: Date.now(),
    };
  });
  app.put<{ Body: { enabled?: boolean } }>("/api/v15/xianyu/settings/auto-reply", async (request) => {
    requireXianyu(request);
    if (!Value.Check(XianyuAutoReplyRequestSchema, request.body))
      throw new Error("Invalid Xianyu auto-reply request");
    return { enabled: runtime.database.setXianyuAutoReply(request.body.enabled) };
  });
  app.post<{ Params: { id: string } }>("/api/v15/xianyu/sessions/:id/read", async (request) => {
    requireXianyu(request);
    if (!runtime.database.isChannelSession(request.params.id)) throw new Error("Session not found");
    runtime.database.markChannelSessionRead(request.params.id);
    return { ok: true };
  });
  app.post<{ Body: Record<string, unknown> }>("/api/v15/xianyu/internal/session", async (request) => {
    requireInternalXianyu(request);
    if (!Value.Check(XianyuInternalSessionRequestSchema, request.body))
      throw new Error("Invalid Xianyu internal session request");
    const body = request.body as {
      sessionId?: string;
      tenantId: string;
      conversationId: string;
      threadId?: string;
      displayName?: string;
      externalUserId?: string;
      itemId?: string;
    };
    if (body.sessionId) {
      if (!runtime.database.isChannelSession(body.sessionId, "xianyu"))
        throw new Error("Xianyu channel session not found");
      const metadata = runtime.database.channelSession(body.sessionId);
      if (
        !metadata ||
        metadata.tenantId !== body.tenantId ||
        metadata.conversationId !== body.conversationId ||
        (metadata.threadId ?? "") !== (body.threadId ?? "")
      )
        throw new Error("Invalid Xianyu session mapping");
      runtime.database.updateChannelSession({
        sessionId: body.sessionId,
        ...(body.displayName ? { displayName: body.displayName } : {}),
        ...(body.externalUserId ? { externalUserId: body.externalUserId } : {}),
        ...(body.itemId ? { itemId: body.itemId } : {}),
      });
      return { sessionId: body.sessionId };
    }
    const session = await ensureXianyuSession({ ...body, kind: "buyer" });
    return { sessionId: session.id };
  });
  app.post<{ Body: Record<string, unknown> }>("/api/v15/xianyu/internal/inbound", async (request) => {
    requireInternalXianyu(request);
    if (!Value.Check(XianyuInternalInboundRequestSchema, request.body))
      throw new Error("Invalid Xianyu internal inbound request");
    const body = request.body as {
      sessionId: string;
      externalMessageId: string;
      senderId?: string;
      text: string;
      attachmentIds?: string[];
    };
    if (!runtime.database.isChannelSession(body.sessionId)) throw new Error("Session not found");
    const key = `inbound:${body.sessionId}:${body.externalMessageId}`;
    const delivery = runtime.database.createChannelDelivery({
      direction: "inbound",
      idempotencyKey: key,
      sessionId: body.sessionId,
      status: "pending",
    });
    if (!delivery.created) return { accepted: false, duplicate: true };
    try {
      const messageId = randomUUID();
      const run = runtime.sendMessage(
        body.sessionId,
        {
          messageId,
          text: body.text,
          mode: "agent",
          source: {
            adapter: "xianyu",
            conversationId: runtime.database.channelSession(body.sessionId)?.conversationId ?? body.sessionId,
            externalMessageId: body.externalMessageId,
            ...(body.senderId ? { senderId: body.senderId } : {}),
          },
          ...(body.attachmentIds?.length ? { attachmentIds: body.attachmentIds } : {}),
        },
        requestTrace(request),
      );
      runtime.database.attachChannelDeliveryMessage(key, messageId);
      runtime.database.updateChannelSession({
        sessionId: body.sessionId,
        inbound: true,
        ...(body.senderId ? { externalUserId: body.senderId } : {}),
      });
      runtime.database.updateChannelDeliveryByKey(key, "delivered");
      return { accepted: true, duplicate: false, runId: run.id, messageId };
    } catch (error) {
      runtime.database.updateChannelDeliveryByKey(
        key,
        "failed",
        error instanceof Error ? error.message : String(error),
      );
      throw error;
    }
  });
  app.post<{ Body: { sessionId?: string; messageId?: string; externalMessageId?: string; text?: string } }>(
    "/api/v15/xianyu/internal/outbound",
    async (request) => {
      requireInternalXianyu(request);
      const body = request.body ?? {};
      if (!body.sessionId || !body.messageId || typeof body.text !== "string")
        throw new Error("sessionId, messageId and text are required");
      if (!runtime.database.isChannelSession(body.sessionId)) throw new Error("Session not found");
      const message = runtime.database.getMessage(body.messageId);
      // 内部令牌允许渠道操作，但不能把另一会话的回复登记到当前买家名下。
      if (runtime.database.findMessageOwner(body.messageId)?.sessionId !== body.sessionId)
        throw new Error("Message belongs to another session");
      if (message.role !== "assistant" || message.status !== "complete")
        throw new Error("Message is not a completed assistant reply");
      const userMessage = runtime.database
        .listMessages(body.sessionId)
        .find((item) => item.runId === message.runId && item.role === "user");
      if (!userMessage?.source || userMessage.source.adapter !== "xianyu")
        return { send: false, ignored: true };
      const key = `outbound:${body.sessionId}:${body.messageId}`;
      const delivery = runtime.database.createChannelDelivery({
        direction: "outbound",
        idempotencyKey: key,
        sessionId: body.sessionId,
        messageId: body.messageId,
        status: runtime.database.xianyuAutoReplyEnabled() ? "pending" : "draft",
      });
      if (!delivery.created) return { send: false, duplicate: true, status: delivery.status };
      return {
        send: runtime.database.xianyuAutoReplyEnabled(),
        duplicate: false,
        status: delivery.status,
        idempotencyKey: key,
      };
    },
  );
  app.post<{ Body: { idempotencyKey?: string; ok?: boolean; error?: string } }>(
    "/api/v15/xianyu/internal/outbound/result",
    async (request) => {
      requireInternalXianyu(request);
      const body = request.body ?? {};
      if (!body.idempotencyKey || typeof body.ok !== "boolean")
        throw new Error("idempotencyKey and ok are required");
      runtime.database.updateChannelDeliveryByKey(
        body.idempotencyKey,
        body.ok ? "delivered" : "failed",
        body.error,
      );
      return { ok: true };
    },
  );
  app.post<{ Params: { id: string; messageId: string } }>(
    "/api/v15/xianyu/sessions/:id/drafts/:messageId/send",
    async (request) => {
      requireXianyu(request);
      const { id: sessionId, messageId } = request.params;
      if (!runtime.database.isChannelSession(sessionId, "xianyu")) throw new Error("Session not found");
      const message = runtime.database.getMessage(messageId);
      const messageOwner = runtime.database.findMessageOwner(messageId);
      if (
        messageOwner?.sessionId !== sessionId ||
        message.role !== "assistant" ||
        message.status !== "complete"
      )
        throw new Error("Message is not a completed draft reply");
      const delivery = runtime.database.channelDeliveryForMessage(messageId);
      if (!delivery || delivery.sessionId !== sessionId) throw new Error("Draft delivery not found");
      if (delivery.status === "delivered") return { ok: true, messageId };
      if (delivery.status !== "draft") throw new Error("Draft is already being delivered");
      runtime.database.updateChannelDelivery(messageId, "pending");
      try {
        await xianyuClient(request).send({ sessionId, messageId, text: message.content });
        runtime.database.updateChannelDelivery(messageId, "delivered");
        return { ok: true, messageId };
      } catch (error) {
        runtime.database.updateChannelDelivery(
          messageId,
          "failed",
          error instanceof Error ? error.message : String(error),
        );
        throw error;
      }
    },
  );
  app.get("/api/v15/xianyu/status", async (request) => {
    const principal = requireXianyu(request);
    const result = await xianyuClient(request).health();
    request.log.info({
      requestId: request.id,
      userId: principal.userId,
      action: "xianyu.status",
      result: "ok",
    });
    return result;
  });
  app.post("/api/v15/xianyu/login/start", async (request) => {
    const principal = requireXianyu(request);
    const result = await xianyuClient(request).loginStart();
    request.log.info({
      requestId: request.id,
      userId: principal.userId,
      action: "xianyu.login.start",
      result: "ok",
    });
    return result;
  });
  app.get("/api/v15/xianyu/login/status", async (request) => {
    const principal = requireXianyu(request);
    const result = await xianyuClient(request).loginStatus();
    request.log.info({
      requestId: request.id,
      userId: principal.userId,
      action: "xianyu.login.status",
      result: "ok",
    });
    return result;
  });
  app.get("/api/v15/xianyu/conversations", async (request) => {
    const principal = requireXianyu(request);
    const result = await xianyuClient(request).conversations();
    request.log.info({
      requestId: request.id,
      userId: principal.userId,
      action: "xianyu.conversations",
      result: "ok",
    });
    return result;
  });
  const xianyuAction = (path: "/start" | "/stop" | "/pause" | "/resume", action: string) =>
    app.post(`/api/v15/xianyu${path}`, async (request) => {
      const principal = requireXianyu(request);
      await xianyuClient(request).request<void>(path, { method: "POST" });
      request.log.info({ requestId: request.id, userId: principal.userId, action, result: "ok" });
      return { ok: true };
    });
  xianyuAction("/start", "xianyu.start");
  xianyuAction("/stop", "xianyu.stop");
  xianyuAction("/pause", "xianyu.pause");
  xianyuAction("/resume", "xianyu.resume");
  app.get<{ Params: { conversationId: string } }>(
    "/api/v15/xianyu/history/:conversationId",
    async (request) => {
      const principal = requireXianyu(request);
      const result = await xianyuClient(request).history(request.params.conversationId);
      request.log.info({
        requestId: request.id,
        userId: principal.userId,
        action: "xianyu.history",
        result: "ok",
      });
      return result;
    },
  );
  app.get<{ Params: { itemId: string } }>("/api/v15/xianyu/item/:itemId", async (request) => {
    const principal = requireXianyu(request);
    const result = await xianyuClient(request).item(request.params.itemId);
    request.log.info({
      requestId: request.id,
      userId: principal.userId,
      action: "xianyu.item",
      result: "ok",
    });
    return result;
  });
  app.post<{ Body: Record<string, unknown> }>("/api/v15/xianyu/chat", async (request) => {
    const principal = requireXianyu(request);
    const result = await xianyuClient(request).chat(validateXianyuChatBody(request.body ?? {}));
    request.log.info({
      requestId: request.id,
      userId: principal.userId,
      action: "xianyu.chat",
      result: "ok",
    });
    return result;
  });
  app.post<{ Body: Record<string, unknown> }>("/api/v15/xianyu/publish", async (request) => {
    const principal = requireXianyu(request);
    const result = await xianyuClient(request).publish(validateXianyuPublishBody(request.body ?? {}));
    request.log.info({
      requestId: request.id,
      userId: principal.userId,
      action: "xianyu.publish",
      result: "ok",
    });
    return result;
  });
}
