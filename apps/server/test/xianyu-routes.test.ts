import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { type UmaConfig, UmaRuntime } from "@uma-agent/core";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer } from "../src/app.js";
import { AuthService } from "../src/auth.js";

describe("Xianyu delivery boundary", () => {
  let root: string;
  let runtime: UmaRuntime;
  let app: FastifyInstance;
  let adminHeaders: { authorization: string };
  let userHeaders: { authorization: string };
  const internalHeaders = { authorization: "Bearer isolated-channel-token" };
  const parent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";

  beforeEach(async () => {
    vi.stubEnv("UMA_LOG_LEVEL", "silent");
    vi.stubEnv("UMA_CHANNEL_ROUTE_TEST_TOKEN", "isolated-channel-token");
    root = await mkdtemp(join(tmpdir(), "uma-channel-routes-"));
    const model = { provider: "faux", id: "model" };
    const config: UmaConfig = {
      server: {
        host: "127.0.0.1",
        port: 0,
        stateDir: join(root, "state"),
        workspaceRoots: [root],
        webOrigins: [],
        maxUploadBytes: 1024,
      },
      auth: { webSessionHours: 1 },
      models: [
        {
          ...model,
          name: "Faux",
          api: "openai-responses",
          baseUrl: "http://127.0.0.1:9/v1",
          apiKeyEnv: "UMA_FAUX_KEY",
          reasoning: false,
          tools: true,
          vision: false,
          structuredOutput: true,
          contextWindow: 100000,
          maxTokens: 4096,
        },
      ],
      defaultModel: model,
      defaultThinkingLevel: "off",
      skillsDirs: [],
      mcpServers: [],
      runtime: { maxParallelSessions: 1, approvalTimeoutMs: 1000, toolTimeoutMs: 1000 },
      roles: { default: model, fast: model, reasoning: model, vision: model },
      xianyu: { adapterUrl: "http://127.0.0.1:9", controlTokenEnv: "UMA_CHANNEL_ROUTE_TEST_TOKEN" },
    };
    runtime = new UmaRuntime(config);
    const faux = fauxProvider({
      provider: "faux",
      models: [{ id: "model", contextWindow: 100000, maxTokens: 4096 }],
      tokensPerSecond: 100000,
    });
    faux.setResponses([fauxAssistantMessage("隔离测试回复")]);
    runtime.models.models.setProvider(faux.provider);
    await runtime.start();
    const auth = new AuthService(runtime);
    adminHeaders = {
      authorization: `Bearer ${auth.issueToken(runtime.database.createUser("admin").id).token}`,
    };
    userHeaders = { authorization: `Bearer ${auth.register().token}` };
    app = await createServer(runtime, { webRoot: false });
  });

  afterEach(async () => {
    await app?.close();
    await runtime?.stop();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    if (root) await rm(root, { recursive: true, force: true });
  });

  const internal = (path: string, payload: Record<string, unknown>, headers = internalHeaders) =>
    app.inject({ method: "POST", url: `/api/v15/xianyu/internal/${path}`, headers, payload });
  const buyer = async (conversationId = "buyer-1") => {
    const response = await internal("session", { tenantId: "xianyu", conversationId });
    expect(response.statusCode, response.body).toBe(200);
    return response.json<{ sessionId: string }>().sessionId;
  };

  it("rejects invalid mappings and separates internal credentials from user PATs", async () => {
    expect((await internal("session", {}, userHeaders)).statusCode).toBe(403);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v15/xianyu/internal/session",
          remoteAddress: "203.0.113.1",
          headers: internalHeaders,
          payload: {},
        })
      ).statusCode,
    ).toBe(403);
    expect((await internal("session", {})).statusCode).toBe(400);
    const sessionId = await buyer();
    expect(await buyer()).toBe(sessionId);
    const updated = await internal("session", {
      sessionId,
      tenantId: "xianyu",
      conversationId: "buyer-1",
      displayName: "买家",
      externalUserId: "external-1",
      itemId: "item-1",
    });
    expect(updated.json()).toEqual({ sessionId });
    expect(
      (await internal("session", { sessionId, tenantId: "xianyu", conversationId: "other" })).statusCode,
    ).toBe(400);
    expect(
      (await internal("session", { sessionId: "missing", tenantId: "xianyu", conversationId: "other" }))
        .statusCode,
    ).toBe(404);
    expect((await internal("inbound", {})).statusCode).toBe(400);
    expect(
      (await internal("inbound", { sessionId: "missing", externalMessageId: "m", text: "text" })).statusCode,
    ).toBe(404);
    expect((await internal("outbound", {})).statusCode).toBe(400);
    expect((await internal("outbound/result", {})).statusCode).toBe(400);
    for (const headers of [userHeaders, adminHeaders]) {
      const result = await app.inject({
        method: "POST",
        url: `/api/v15/xianyu/sessions/${sessionId}/read`,
        headers,
      });
      expect(result.statusCode).toBe(headers === userHeaders ? 403 : 200);
    }
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v15/xianyu/sessions/missing/read",
          headers: adminHeaders,
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: "PUT",
          url: "/api/v15/xianyu/settings/auto-reply",
          headers: adminHeaders,
          payload: { enabled: "yes" },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/api/v15/sessions/${sessionId}/snapshot`,
          headers: userHeaders,
        })
      ).statusCode,
    ).toBe(404);
  });

  it("keeps inbound, run and draft in one trace; deduplicates delivery and preserves the background account", async () => {
    const sessionId = await buyer();
    runtime.database.setXianyuAutoReply(false);
    const inbound = await internal(
      "inbound",
      { sessionId, externalMessageId: "external-m1", senderId: "buyer", text: "你好" },
      { ...internalHeaders, traceparent: parent },
    );
    expect(inbound.statusCode, inbound.body).toBe(200);
    const { runId } = inbound.json<{ runId: string }>();
    await vi.waitFor(() => expect(runtime.getRun(runId).status).toBe("completed"));
    const runTrace = runtime.listTrace({ runId });
    expect(runTrace.traceId).toBe(parent.split("-")[1]);
    expect(runTrace.spans).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "run", status: "ok" }),
        expect.objectContaining({ name: "queue.wait" }),
      ]),
    );
    const duplicate = await internal("inbound", {
      sessionId,
      externalMessageId: "external-m1",
      text: "你好",
    });
    expect(duplicate.json()).toEqual({ accepted: false, duplicate: true });
    expect(runtime.database.listRuns(sessionId)).toHaveLength(1);
    const reply = runtime.database.listMessages(sessionId).find((message) => message.role === "assistant");
    expect(reply).toBeDefined();
    if (!reply) throw new Error("faux run did not produce assistant reply");
    const payload = { sessionId, messageId: reply.id, text: reply.content };
    expect((await internal("outbound", payload)).json()).toMatchObject({ send: false, status: "draft" });
    expect((await internal("outbound", payload)).json()).toMatchObject({ duplicate: true, status: "draft" });
    const otherSessionId = await buyer("buyer-2");
    expect((await internal("outbound", { ...payload, sessionId: otherSessionId })).statusCode).toBe(400);

    // 只替换外部网络边界；草稿状态、鉴权与 Run 都经过真实 Core/Server 实现。
    const adapterFetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const send = () =>
      app.inject({
        method: "POST",
        url: `/api/v15/xianyu/sessions/${sessionId}/drafts/${reply.id}/send`,
        headers: { ...adminHeaders, traceparent: parent },
      });
    expect((await send()).statusCode).toBe(200);
    expect((await send()).statusCode).toBe(200);
    expect(adapterFetch).toHaveBeenCalledTimes(1);
    const propagated = new Headers(adapterFetch.mock.calls[0]?.[1]?.headers).get("traceparent");
    expect(propagated?.split("-")[1]).toBe(parent.split("-")[1]);
    expect(runtime.database.channelDeliveryForMessage(reply.id)?.status).toBe("delivered");
    const logout = await app.inject({ method: "POST", url: "/api/v15/auth/logout", headers: adminHeaders });
    expect(logout.statusCode).toBe(204);
    expect(adapterFetch).toHaveBeenCalledTimes(1);
    expect(runtime.database.isChannelSession(sessionId)).toBe(true);
    expect(runtime.database.xianyuAutoReplyEnabled()).toBe(false);
  });
});
