import { randomBytes, scryptSync } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type UmaConfig, UmaRuntime } from "@uma-agent/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, crossOrigin, secureOrigin, shouldCloseForBufferedAmount } from "../src/app.js";
import { AuthService } from "../src/auth.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const action of cleanup.splice(0).reverse()) await action();
});

describe("server", () => {
  it("closes an overloaded WebSocket instead of growing an unbounded queue", () => {
    expect(shouldCloseForBufferedAmount(4 * 1024 * 1024, 4 * 1024 * 1024)).toBe(false);
    expect(shouldCloseForBufferedAmount(4 * 1024 * 1024 + 1, 4 * 1024 * 1024)).toBe(true);
    expect(crossOrigin(undefined, "localhost")).toBe(false);
    expect(crossOrigin("not a url", "localhost")).toBe(true);
    expect(secureOrigin(undefined)).toBe(false);
    expect(secureOrigin("not a url")).toBe(false);
  });

  it("requires auth and serves authoritative snapshots", async () => {
    const root = await mkdtemp(join(tmpdir(), "uma-server-"));
    const state = join(root, "state");
    const config: UmaConfig = {
      server: {
        host: "127.0.0.1",
        port: 3210,
        stateDir: state,
        workspaceRoots: [root],
        webOrigins: ["https://web.example"],
        maxUploadBytes: 1024,
      },
      auth: { webSessionHours: 1 },
      models: [
        {
          provider: "test",
          id: "model",
          name: "Model",
          api: "openai-responses",
          baseUrl: "http://127.0.0.1:9/v1",
          apiKeyEnv: "UMA_TEST_KEY",
          reasoning: false,
          tools: true,
          vision: false,
          structuredOutput: true,
          contextWindow: 1000,
          maxTokens: 100,
        },
      ],
      defaultModel: { provider: "test", id: "model" },
      defaultThinkingLevel: "off",
      skillsDirs: [],
      mcpServers: [],
      runtime: { maxParallelSessions: 1, approvalTimeoutMs: 1000, toolTimeoutMs: 1000 },
      roles: {
        default: { provider: "test", id: "model" },
        reasoning: { provider: "test", id: "model" },
        fast: { provider: "test", id: "model" },
        vision: { provider: "test", id: "model" },
      },
      xianyu: { adapterUrl: "http://127.0.0.1:3250", controlTokenEnv: "UMA_TEST_XIANYU_TOKEN" },
    };
    const previousToken = process.env.UMA_TEST_XIANYU_TOKEN;
    const previousPassword = process.env.UMA_XIANYU_ADMIN_PASSWORD_HASH;
    const salt = randomBytes(16);
    const digest = scryptSync("test-admin-password", salt, 32, { N: 16_384, r: 8, p: 1 });
    process.env.UMA_TEST_XIANYU_TOKEN = "adapter-test-token";
    process.env.UMA_XIANYU_ADMIN_PASSWORD_HASH = `scrypt$16384$8$1$${salt.toString("base64url")}$${digest.toString("base64url")}`;
    const runtime = new UmaRuntime(config);
    await runtime.start();
    const admin = runtime.database.createUser("admin");
    const testToken = new AuthService(runtime).issueToken(admin.id, "server-test").token;
    const app = await createServer(runtime, { webRoot: false, configLoader: async () => config });
    cleanup.push(async () => {
      vi.restoreAllMocks();
      if (previousToken === undefined) delete process.env.UMA_TEST_XIANYU_TOKEN;
      else process.env.UMA_TEST_XIANYU_TOKEN = previousToken;
      if (previousPassword === undefined) delete process.env.UMA_XIANYU_ADMIN_PASSWORD_HASH;
      else process.env.UMA_XIANYU_ADMIN_PASSWORD_HASH = previousPassword;
      await app.close();
      await runtime.stop();
      await rm(root, { recursive: true, force: true });
    });
    expect((await app.inject({ method: "GET", url: "/api/v15/health/live" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/v15/health/ready" })).json()).toMatchObject({
      status: "ok",
      version: "1.3.0",
      protocolVersion: 15,
    });
    expect((await app.inject({ method: "GET", url: "/api/v15/sessions" })).statusCode).toBe(401);
    const preflight = await app.inject({
      method: "OPTIONS",
      url: "/api/v15/sessions",
      headers: {
        origin: "https://web.example",
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type, x-xianyu-grant",
      },
    });
    expect(preflight.statusCode).toBe(204);
    expect(preflight.headers["access-control-allow-origin"]).toBe("https://web.example");
    expect(preflight.headers["access-control-allow-credentials"]).toBe("true");
    expect(preflight.headers["access-control-allow-headers"]).toContain("X-Xianyu-Grant");
    const deniedPreflight = await app.inject({
      method: "OPTIONS",
      url: "/api/v15/sessions",
      headers: {
        origin: "https://attacker.example",
        "access-control-request-method": "POST",
      },
    });
    expect(deniedPreflight.statusCode).toBe(403);
    const login = await app.inject({
      method: "POST",
      url: "/api/v15/auth/login",
      headers: { origin: "https://web.example" },
      payload: { token: testToken },
    });
    expect(login.statusCode).toBe(200);
    expect(login.headers["set-cookie"]).toContain("SameSite=None");
    expect(login.headers["set-cookie"]).toContain("Secure");
    const webCookie = login.cookies[0];
    expect(webCookie).toBeDefined();
    const missingOrigin = await app.inject({
      method: "POST",
      url: "/api/v15/sessions",
      headers: { cookie: `${webCookie?.name}=${webCookie?.value}` },
      payload: {},
    });
    expect(missingOrigin.statusCode).toBe(403);
    expect(missingOrigin.json().error.code).toBe("forbidden");
    const cookieSession = await app.inject({
      method: "POST",
      url: "/api/v15/sessions",
      headers: {
        cookie: `${webCookie?.name}=${webCookie?.value}`,
        origin: "https://web.example",
      },
      payload: {},
    });
    expect(cookieSession.statusCode).toBe(200);
    const cookieSessionId = cookieSession.json<{ id: string }>().id;
    const socket = await app.injectWS("/api/v15/events", {
      headers: {
        cookie: `${webCookie?.name}=${webCookie?.value}`,
        origin: "https://web.example",
      },
    });
    const socketEvent = new Promise<{ type: string }>((resolve) => {
      socket.on("message", (data) => {
        const event = JSON.parse(String(data)) as { type: string };
        if (event.type === "session.snapshot") resolve(event);
      });
    });
    socket.send(JSON.stringify({ type: "subscribe", sessions: [{ id: cookieSessionId, lastSequence: 0 }] }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    runtime.updateSession(cookieSessionId, { title: "Synced over WebSocket" });
    expect((await socketEvent).type).toBe("session.snapshot");
    socket.terminate();

    await expect(
      app.injectWS("/api/v15/events", { headers: { origin: "https://attacker.example" } }),
    ).rejects.toThrow("Unexpected server response: 403");
    const logout = await app.inject({
      method: "POST",
      url: "/api/v15/auth/logout",
      headers: {
        cookie: `${webCookie?.name}=${webCookie?.value}`,
        origin: "https://web.example",
      },
    });
    expect(logout.statusCode).toBe(204);
    expect(logout.headers["set-cookie"]).toContain("SameSite=None");
    expect(logout.headers["set-cookie"]).toContain("Secure");
    const created = await app.inject({
      method: "POST",
      url: "/api/v15/sessions",
      headers: { authorization: `Bearer ${testToken}` },
      payload: { title: "API test" },
    });
    expect(created.statusCode).toBe(200);
    const session = created.json<{ id: string }>();
    const snapshot = await app.inject({
      method: "GET",
      url: `/api/v15/sessions/${session.id}/snapshot`,
      headers: { authorization: `Bearer ${testToken}` },
    });
    expect(snapshot.json<{ session: { title: string } }>().session.title).toBe("API test");
    const shortcut = await app.inject({
      method: "POST",
      url: `/api/v15/sessions/${session.id}/shortcuts`,
      headers: { authorization: `Bearer ${testToken}` },
      payload: { command: "/session status" },
    });
    expect(shortcut.statusCode).toBe(200);
    expect(shortcut.json<{ output: string }>().output).toContain("API test");
    const other = runtime.database.createUser("user");
    const otherToken = new AuthService(runtime).issueToken(other.id, "other-test").token;
    const deniedTrace = await app.inject({
      method: "GET",
      url: "/api/v15/traces?runId=missing-run",
      headers: { authorization: `Bearer ${otherToken}` },
    });
    expect(deniedTrace.statusCode).toBe(404);
    const forbiddenShortcut = await app.inject({
      method: "POST",
      url: `/api/v15/sessions/${session.id}/shortcuts`,
      headers: { authorization: `Bearer ${otherToken}` },
      payload: { command: "/status" },
    });
    expect(forbiddenShortcut.statusCode).toBe(404);
    const invalidShortcut = await app.inject({
      method: "POST",
      url: `/api/v15/sessions/${session.id}/shortcuts`,
      headers: { authorization: `Bearer ${testToken}` },
      payload: { command: "/not-a-command" },
    });
    expect(invalidShortcut.statusCode).toBe(400);
    const memory = await app.inject({
      method: "POST",
      url: "/api/v15/memory",
      headers: { authorization: `Bearer ${testToken}` },
      payload: { sessionId: session.id, scope: "global", content: "prefers deterministic tests" },
    });
    expect(memory.statusCode).toBe(200);
    expect(memory.json()).toMatchObject({
      sessionId: session.id,
      scope: "global",
      confidence: 1,
      status: "active",
    });
    expect(runtime.database.searchMemory(session.id, "deterministic tests")).toContain(
      "prefers deterministic tests",
    );
    const attachment = await runtime.addAttachment({
      sessionId: session.id,
      name: "hello.txt",
      mimeType: "text/plain",
      data: Buffer.from("attachment body"),
    });
    const downloaded = await app.inject({
      method: "GET",
      url: `/api/v15/attachments/${attachment.id}/content`,
      headers: { authorization: `Bearer ${testToken}` },
    });
    expect(downloaded.statusCode).toBe(200);
    expect(downloaded.body).toBe("attachment body");
    runtime.database.insertMessage({
      sessionId: session.id,
      role: "user",
      status: "complete",
      content: "history item",
    });
    const storedSession = runtime.database.getSession(session.id);
    const run = runtime.database.createRun(
      session.id,
      "checkpoint-message",
      runtime.models.snapshot(storedSession.model),
      storedSession.thinkingLevel,
      "agent",
      "agent",
    ).run;
    const telemetry = (
      runtime as unknown as {
        trace: {
          store: {
            start: (record: Record<string, unknown>) => void;
            finish: (record: Record<string, unknown>) => void;
          };
        };
      }
    ).trace.store;
    telemetry.start({
      traceId: "server-trace",
      spanId: "server-root",
      runId: run.id,
      sessionId: session.id,
      name: "run",
      kind: "run",
      service: "core",
      startedAt: 1,
      attributes: { safe: "value", authorization: "secret" },
    });
    telemetry.finish({
      traceId: "server-trace",
      spanId: "server-root",
      runId: run.id,
      sessionId: session.id,
      name: "run",
      kind: "run",
      service: "core",
      startedAt: 1,
      endedAt: 11,
      durationMs: 10,
      status: "ok",
      attributes: { safe: "value", authorization: "secret" },
      events: [],
    });
    telemetry.start({
      traceId: "server-trace",
      spanId: "server-model",
      parentSpanId: "server-root",
      runId: run.id,
      sessionId: session.id,
      name: "model",
      kind: "model",
      service: "core",
      startedAt: 2,
      attributes: { safe: "model" },
    });
    telemetry.finish({
      traceId: "server-trace",
      spanId: "server-model",
      parentSpanId: "server-root",
      runId: run.id,
      sessionId: session.id,
      name: "model",
      kind: "model",
      service: "core",
      startedAt: 2,
      endedAt: 5,
      durationMs: 3,
      status: "ok",
      attributes: { safe: "model" },
      events: [],
    });
    const tracePage = await app.inject({
      method: "GET",
      url: `/api/v15/traces?runId=${run.id}&offset=0&limit=1`,
      headers: { authorization: `Bearer ${testToken}` },
    });
    expect(tracePage.statusCode).toBe(200);
    expect(tracePage.json()).toMatchObject({
      traceId: "server-trace",
      hasMore: true,
      nextOffset: 1,
      spans: [{ spanId: "server-root", attributes: { safe: "value", authorization: "[REDACTED]" } }],
    });
    const traceTail = await app.inject({
      method: "GET",
      url: `/api/v15/traces?runId=${run.id}&offset=1&limit=1`,
      headers: { authorization: `Bearer ${testToken}` },
    });
    expect(traceTail.json()).toMatchObject({
      hasMore: false,
      spans: [{ spanId: "server-model", parentSpanId: "server-root" }],
    });
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/api/v15/traces?runId=${run.id}`,
          headers: { authorization: `Bearer ${otherToken}` },
        })
      ).statusCode,
    ).toBe(404);
    runtime.database.createCheckpoint({
      runId: run.id,
      phase: "preflight",
      turnCount: 0,
      lastMessageSequence: 1,
      safeToResume: true,
    });
    const history = await app.inject({
      method: "GET",
      url: `/api/v15/sessions/${session.id}/history?limit=10`,
      headers: { authorization: `Bearer ${testToken}` },
    });
    expect(history.json<{ items: Array<{ content: string }> }>().items[0]?.content).toBe("history item");
    const checkpoints = await app.inject({
      method: "GET",
      url: `/api/v15/runs/${run.id}/checkpoints`,
      headers: { authorization: `Bearer ${testToken}` },
    });
    expect(checkpoints.json<Array<{ phase: string }>>()[0]?.phase).toBe("preflight");
    const invalidPatch = await app.inject({
      method: "PATCH",
      url: `/api/v15/sessions/${session.id}`,
      headers: { authorization: `Bearer ${testToken}` },
      payload: { workspace: "elsewhere" },
    });
    expect(invalidPatch.statusCode).toBe(400);
    expect(invalidPatch.json()).toMatchObject({
      error: { code: "validation_failed", retryable: false },
    });
    expect(invalidPatch.json<{ error: { requestId: string } }>().error.requestId).toMatch(/^req-/);
    const createdSchedule = await app.inject({
      method: "POST",
      url: "/api/v15/schedules",
      headers: { authorization: `Bearer ${testToken}` },
      payload: {
        name: "hourly",
        prompt: "summarize",
        schedule: { kind: "interval", everyMs: 3_600_000 },
      },
    });
    expect(createdSchedule.statusCode).toBe(200);
    const scheduleId = createdSchedule.json<{ id: string }>().id;
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/v15/schedules",
          headers: { authorization: `Bearer ${testToken}` },
        })
      ).json<Array<{ id: string }>>(),
    ).toEqual([expect.objectContaining({ id: scheduleId })]);
    expect(
      (
        await app.inject({
          method: "PATCH",
          url: `/api/v15/schedules/${scheduleId}`,
          headers: { authorization: `Bearer ${testToken}` },
          payload: { enabled: false },
        })
      ).json(),
    ).toMatchObject({ enabled: false });
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/api/v15/schedules/${scheduleId}/runs`,
          headers: { authorization: `Bearer ${testToken}` },
        })
      ).json(),
    ).toEqual([]);
    const report = await app.inject({
      method: "GET",
      url: "/api/v15/reports/operations?from=0",
      headers: { authorization: `Bearer ${testToken}` },
    });
    expect(report.json()).toMatchObject({ runs: { total: 1 }, tools: { calls: 0 } });
    const diagnostics = await app.inject({
      method: "GET",
      url: "/api/v15/reports/diagnostics?from=0",
      headers: { authorization: `Bearer ${testToken}` },
    });
    expect(diagnostics.json()).toMatchObject({ summary: { runs: { total: 1 } } });
    const diagnosticsBody = diagnostics.json<{
      trace: { spans: number; incomplete: number; latencyMs: { p50: number; p95: number; p99: number } };
    }>();
    expect(diagnosticsBody.trace.spans).toBeGreaterThanOrEqual(2);
    expect(diagnosticsBody.trace.incomplete).toBe(0);
    expect(diagnosticsBody.trace.latencyMs.p50).toBeGreaterThan(0);
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/v15/reports/resources?from=0",
          headers: { authorization: `Bearer ${testToken}` },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/v15/reports/resources?from=0",
          headers: { authorization: `Bearer ${otherToken}` },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/api/v15/reports/operations?from=0&to=${Date.now()}`,
          headers: { authorization: `Bearer ${testToken}` },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/api/v15/reports/diagnostics?from=0&to=${Date.now()}`,
          headers: { authorization: `Bearer ${testToken}` },
        })
      ).statusCode,
    ).toBe(200);
    const authHeaders = { authorization: `Bearer ${testToken}` };
    const adapterRequests: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      adapterRequests.push(`${init?.method ?? "GET"} ${url}`);
      const payload = url.endsWith("/health")
        ? { status: "ok", paused: false }
        : url.endsWith("/conversations")
          ? [{ id: "conversation-1", sessionId: session.id }]
          : url.includes("/history/")
            ? { messages: [] }
            : url.includes("/item/")
              ? { id: "item-1", title: "Test item" }
              : url.endsWith("/chat")
                ? { ok: true, conversationId: "conversation-1" }
                : url.endsWith("/publish")
                  ? { ok: true, itemId: "item-2" }
                  : {};
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    expect(
      (await app.inject({ method: "GET", url: "/api/v15/xianyu/status", headers: authHeaders })).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v15/xianyu/unlock",
          headers: authHeaders,
          payload: { password: "wrong" },
        })
      ).statusCode,
    ).toBe(403);
    const unlocked = await app.inject({
      method: "POST",
      url: "/api/v15/xianyu/unlock",
      headers: authHeaders,
      payload: { password: "test-admin-password" },
    });
    expect(unlocked.statusCode).toBe(200);
    const grant = unlocked.json<{ grant: string; expiresAt: number }>();
    expect(grant.grant).toHaveLength(43);
    expect(grant.expiresAt).toBeGreaterThan(Date.now());
    const xianyuHeaders = { ...authHeaders, "x-xianyu-grant": grant.grant };
    expect(
      (await app.inject({ method: "GET", url: "/api/v15/xianyu/status", headers: xianyuHeaders })).json(),
    ).toMatchObject({ status: "ok" });
    expect(
      (
        await app.inject({ method: "GET", url: "/api/v15/xianyu/conversations", headers: xianyuHeaders })
      ).json(),
    ).toEqual([{ id: "conversation-1", sessionId: session.id }]);
    for (const action of ["start", "stop", "pause", "resume"])
      expect(
        (await app.inject({ method: "POST", url: `/api/v15/xianyu/${action}`, headers: xianyuHeaders }))
          .statusCode,
      ).toBe(200);
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/v15/xianyu/history/conversation-1",
          headers: xianyuHeaders,
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (await app.inject({ method: "GET", url: "/api/v15/xianyu/item/item-1", headers: xianyuHeaders }))
        .statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v15/xianyu/chat",
          headers: xianyuHeaders,
          payload: { receiverId: "buyer-1", itemId: "item-1" },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v15/xianyu/chat",
          headers: xianyuHeaders,
          payload: { receiverId: "", itemId: "item-1" },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v15/xianyu/publish",
          headers: xianyuHeaders,
          payload: {
            description: "item",
            imagePaths: ["/tmp/a.jpg"],
            delivery: "free_shipping",
            longitude: "121.4",
            latitude: "31.2",
          },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v15/xianyu/publish",
          headers: xianyuHeaders,
          payload: {
            description: "item",
            imagePaths: [],
            delivery: "free_shipping",
            longitude: "121.4",
            latitude: "31.2",
          },
        })
      ).statusCode,
    ).toBe(400);
    expect(adapterRequests).toEqual(
      expect.arrayContaining([
        "GET http://127.0.0.1:3250/health",
        "POST http://127.0.0.1:3250/start",
        "POST http://127.0.0.1:3250/publish",
      ]),
    );
    const renewedLogin = await app.inject({
      method: "POST",
      url: "/api/v15/auth/login",
      headers: { origin: "https://web.example" },
      payload: { token: testToken },
    });
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v15/auth/logout",
          headers: {
            origin: "https://web.example",
            authorization: `Bearer ${testToken}`,
            cookie: `${renewedLogin.cookies[0]?.name}=${renewedLogin.cookies[0]?.value}`,
          },
        })
      ).statusCode,
    ).toBe(204);
    expect(
      (await app.inject({ method: "GET", url: "/api/v15/xianyu/status", headers: xianyuHeaders })).statusCode,
    ).toBe(403);
    expect(
      (await app.inject({ method: "GET", url: "/api/v15/sessions", headers: authHeaders })).json<
        Array<{ id: string }>
      >(),
    ).toEqual(expect.arrayContaining([expect.objectContaining({ id: session.id })]));
    expect(
      (
        await app.inject({
          method: "PATCH",
          url: `/api/v15/sessions/${session.id}`,
          headers: authHeaders,
          payload: { title: "Renamed", queueMode: "preemptive" },
        })
      ).json(),
    ).toMatchObject({ title: "Renamed", queueMode: "preemptive" });
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/api/v15/sessions/${session.id}/events?after=-10&limit=5000`,
          headers: authHeaders,
        })
      ).json(),
    ).toMatchObject({ sessionId: session.id });
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/api/v15/sessions/${session.id}/history?before=999999&limit=1`,
          headers: authHeaders,
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (await app.inject({ method: "GET", url: "/api/v15/models", headers: authHeaders })).json<
        Array<unknown>
      >(),
    ).toHaveLength(1);
    expect(
      (await app.inject({ method: "GET", url: "/api/v15/skills", headers: authHeaders })).json(),
    ).toMatchObject({
      available: expect.arrayContaining([
        expect.objectContaining({ name: "builtin-web" }),
        expect.objectContaining({ name: "builtin-stackexchange" }),
        expect.objectContaining({ name: "skill-creator" }),
        expect.objectContaining({ name: "skill-vetter" }),
      ]),
      packages: [],
    });
    expect(
      (await app.inject({ method: "POST", url: "/api/v15/skills/refresh", headers: authHeaders })).json(),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "builtin-web" }),
        expect.objectContaining({ name: "builtin-stackexchange" }),
      ]),
    );
    expect(
      (await app.inject({ method: "POST", url: "/api/v15/admin/reload", headers: authHeaders })).json(),
    ).toMatchObject({ applied: expect.any(Array), restartRequired: expect.any(Array) });
    expect(
      (await app.inject({ method: "GET", url: "/api/v15/admin/config", headers: authHeaders })).json(),
    ).toMatchObject({ defaultModel: { provider: "test", id: "model" }, revision: expect.any(String) });
    expect(
      (await app.inject({ method: "GET", url: "/api/v15/profile", headers: authHeaders })).json(),
    ).toMatchObject({ content: "" });
    expect(
      (
        await app.inject({
          method: "PUT",
          url: "/api/v15/profile",
          headers: authHeaders,
          payload: { content: "Prefer concise, evidence-backed answers." },
        })
      ).json(),
    ).toMatchObject({ content: "Prefer concise, evidence-backed answers." });
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/api/v15/sessions/${session.id}/history/search?q=history&limit=5`,
          headers: authHeaders,
        })
      ).json<Array<{ content: string }>>(),
    ).toEqual([expect.objectContaining({ content: "history item" })]);
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/api/v15/sessions/${session.id}/activity?limit=5`,
          headers: authHeaders,
        })
      ).json<Array<unknown>>().length,
    ).toBeGreaterThan(0);
    const skillSource = join(root, "server-skill");
    await import("node:fs/promises").then((fs) => fs.mkdir(skillSource));
    await writeFile(
      join(skillSource, "SKILL.md"),
      "---\nname: server-skill\ndescription: Server route fixture\nversion: 1.0.0\n---\nUse safely.",
    );
    const installedSkill = await app.inject({
      method: "POST",
      url: "/api/v15/skills/install",
      headers: authHeaders,
      payload: { source: "local", reference: skillSource },
    });
    expect(installedSkill.statusCode).toBe(200);
    const skillId = installedSkill.json<{ id: string }>().id;
    for (const action of ["enable", "disable", "reject"])
      expect(
        (
          await app.inject({
            method: "POST",
            url: `/api/v15/skills/${skillId}/${action}`,
            headers: authHeaders,
          })
        ).statusCode,
      ).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/v15/mcp", headers: authHeaders })).json()).toEqual(
      [],
    );
    expect(
      (await app.inject({ method: "GET", url: "/api/v15/knowledge", headers: authHeaders })).json(),
    ).toEqual([]);
    expect((await app.inject({ method: "GET", url: "/api/v15/tasks", headers: authHeaders })).json()).toEqual(
      [],
    );
    const taskResponse = await app.inject({
      method: "POST",
      url: "/api/v15/tasks",
      headers: authHeaders,
      payload: { prompt: "background prompt", parentSessionId: session.id },
    });
    expect(taskResponse.statusCode).toBe(200);
    const taskId = taskResponse.json<{ id: string }>().id;
    expect(
      (await app.inject({ method: "GET", url: `/api/v15/tasks/${taskId}`, headers: authHeaders })).json(),
    ).toMatchObject({ id: taskId });
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/api/v15/tasks/${taskId}/snapshot`,
          headers: authHeaders,
        })
      ).json(),
    ).toHaveProperty("session");
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/v15/tasks/${taskId}/cancel`,
          headers: authHeaders,
        })
      ).json(),
    ).toMatchObject({ id: taskId });
    expect(
      (await app.inject({ method: "DELETE", url: `/api/v15/tasks/${taskId}`, headers: authHeaders }))
        .statusCode,
    ).toBe(204);

    const candidateMemory = runtime.createMemoryFact(session.id, "session", "candidate fact");
    runtime.database.updateMemoryFact(candidateMemory.id, "candidate");
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/v15/memory?status=candidate",
          headers: authHeaders,
        })
      ).json<Array<{ id: string }>>(),
    ).toEqual([expect.objectContaining({ id: candidateMemory.id })]);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/v15/memory/${candidateMemory.id}`,
          headers: authHeaders,
          payload: { status: "active" },
        })
      ).json(),
    ).toMatchObject({ status: "active" });
    expect(
      (
        await app.inject({
          method: "DELETE",
          url: `/api/v15/memory/${candidateMemory.id}`,
          headers: authHeaders,
        })
      ).statusCode,
    ).toBe(204);
    expect(
      (await app.inject({ method: "GET", url: `/api/v15/runs/${run.id}`, headers: authHeaders })).json(),
    ).toMatchObject({ id: run.id });
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/api/v15/runs/${run.id}/actions`,
          headers: authHeaders,
        })
      ).json(),
    ).toEqual([]);
    expect(
      (
        await app.inject({ method: "GET", url: `/api/v15/runs/${run.id}/quality`, headers: authHeaders })
      ).json(),
    ).toEqual([]);
    expect(
      (
        await app.inject({ method: "GET", url: "/api/v15/optimization-proposals", headers: authHeaders })
      ).json(),
    ).toEqual([]);
    const evaluation = await app.inject({
      method: "POST",
      url: "/api/v15/evaluations",
      headers: authHeaders,
      payload: {
        mode: "faux",
        suiteVersion: "test-1",
        status: "completed",
        totals: { total: 1, passed: 1, failed: 0, skipped: 0 },
        durationMs: 1,
        cases: [{ name: "case", category: "regression", passed: true, durationMs: 1 }],
      },
    });
    expect(evaluation.statusCode).toBe(200);
    const evaluationId = evaluation.json<{ id: string }>().id;
    expect(
      (await app.inject({ method: "GET", url: "/api/v15/evaluations?limit=1", headers: authHeaders })).json<
        Array<{ id: string }>
      >(),
    ).toEqual([expect.objectContaining({ id: evaluationId })]);
    expect(
      (
        await app.inject({ method: "GET", url: `/api/v15/evaluations/${evaluationId}`, headers: authHeaders })
      ).json(),
    ).toMatchObject({ id: evaluationId, totals: { passed: 1 } });
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v15/optimization-proposals/generate",
          headers: authHeaders,
          payload: { from: 0, to: Date.now() },
        })
      ).json(),
    ).toEqual([]);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v15/optimization-proposals/generate",
          headers: authHeaders,
          payload: {},
        })
      ).json(),
    ).toEqual([]);
    const proposal = runtime.database.addOptimizationProposal({
      title: "Review latency",
      evidence: ["fixture"],
      risk: "low",
      recommendation: "Inspect it",
      validation: ["Run tests"],
      status: "pending",
    });
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/v15/optimization-proposals/${proposal.id}/decision`,
          headers: authHeaders,
          payload: { status: "accepted" },
        })
      ).json(),
    ).toMatchObject({ id: proposal.id, status: "accepted" });

    runtime.database.insertMessage({
      id: "quality-question",
      sessionId: session.id,
      role: "user",
      status: "complete",
      content: "What is the result?",
    });
    runtime.database.insertMessage({
      id: "quality-answer",
      sessionId: session.id,
      role: "assistant",
      status: "complete",
      content: "The result is concise.",
    });
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v15/messages/quality-answer/review",
          headers: authHeaders,
          payload: { feedback: "check clarity" },
        })
      ).statusCode,
    ).toBe(202);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v15/messages/quality-answer/improve",
          headers: authHeaders,
          payload: { force: true, reset: true },
        })
      ).statusCode,
    ).toBe(202);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/v15/sessions/${session.id}/commands`,
          headers: authHeaders,
          payload: { command: "node --version", messageId: "server-command" },
        })
      ).statusCode,
    ).toBe(202);
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/api/v15/audit/runs/${run.id}`,
          headers: authHeaders,
        })
      ).json(),
    ).toEqual([]);

    const upload = await app.inject({
      method: "POST",
      url: "/api/v15/uploads",
      payload: Buffer.from(
        `--boundary\r\nContent-Disposition: form-data; name="sessionId"\r\n\r\n${session.id}\r\n--boundary\r\nContent-Disposition: form-data; name="file"; filename="upload.txt"\r\nContent-Type: text/plain\r\n\r\nupload body\r\n--boundary--\r\n`,
      ),
      headers: {
        ...authHeaders,
        "content-type": "multipart/form-data; boundary=boundary",
      },
    });
    expect(upload.statusCode).toBe(200);
    expect(upload.json()).toMatchObject({ name: "upload.txt" });

    for (const [method, url, payload] of [
      ["POST", "/api/v15/sessions", { mode: "invalid" }],
      ["POST", `/api/v15/sessions/${session.id}/messages`, { text: "missing id" }],
      ["POST", "/api/v15/tasks", {}],
      ["POST", "/api/v15/knowledge", {}],
      ["POST", "/api/v15/knowledge", { name: "attachment", attachmentId: "missing" }],
      ["POST", "/api/v15/schedules", { name: "bad" }],
      ["PATCH", `/api/v15/schedules/${scheduleId}`, { schedule: { kind: "invalid" } }],
      ["POST", `/api/v15/memory/${memory.json<{ id: string }>().id}`, { status: "invalid" }],
      ["POST", `/api/v15/runs/${run.id}/actions/missing/decide`, { decision: "invalid" }],
      ["POST", `/api/v15/messages/${run.messageId}/review`, { feedback: 42 }],
      ["POST", `/api/v15/messages/${run.messageId}/improve`, { force: "yes" }],
      ["POST", `/api/v15/sessions/${session.id}/commands`, { command: "" }],
      ["POST", "/api/v15/skills/install", { source: "unknown", reference: "x" }],
      ["PUT", "/api/v15/profile", {}],
      ["POST", "/api/v15/optimization-proposals/generate", { from: 10, to: 1 }],
      ["POST", `/api/v15/optimization-proposals/${proposal.id}/decision`, { status: "pending" }],
    ] as const) {
      expect((await app.inject({ method, url, headers: authHeaders, payload })).statusCode).toBe(400);
    }
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/v15/reports/operations?from=10&to=1",
          headers: authHeaders,
        })
      ).statusCode,
    ).toBe(400);
    expect((await app.inject({ method: "GET", url: "/" })).body).toContain("has not been built");
    const manualScheduleRun = await app.inject({
      method: "POST",
      url: `/api/v15/schedules/${scheduleId}/run`,
      headers: authHeaders,
    });
    expect(manualScheduleRun.statusCode).toBe(200);
    const scheduleRunId = manualScheduleRun.json<{ id: string }>().id;
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/api/v15/schedule-runs/${scheduleRunId}`,
          headers: authHeaders,
        })
      ).json(),
    ).toMatchObject({ id: scheduleRunId, trigger: "manual" });
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/v15/schedule-runs/${scheduleRunId}/cancel`,
          headers: authHeaders,
        })
      ).json(),
    ).toMatchObject({ status: "cancelled" });
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/v15/sessions/${session.id}/cancel`,
          headers: authHeaders,
        })
      ).statusCode,
    ).toBe(204);
    const cancelledRun = await app.inject({
      method: "POST",
      url: `/api/v15/runs/${run.id}/cancel`,
      headers: authHeaders,
    });
    expect(cancelledRun.json()).toMatchObject({ id: run.id, status: "cancelled" });
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/v15/runs/${run.id}/resume`,
          headers: authHeaders,
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/v15/attachments/missing/content",
          headers: authHeaders,
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v15/uploads",
          headers: { ...authHeaders, "content-type": "multipart/form-data; boundary=empty" },
          payload: Buffer.from("--empty--\r\n"),
        })
      ).statusCode,
    ).toBe(400);
    for (let attempt = 0; attempt < 5; attempt++) {
      const invalidLogin = await app.inject({
        method: "POST",
        url: "/api/v15/auth/login",
        headers: { origin: "https://web.example" },
        payload: { token: "wrong" },
      });
      expect(invalidLogin.statusCode).toBe(401);
    }
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v15/auth/login",
          headers: { origin: "https://web.example" },
          payload: { token: "wrong" },
        })
      ).statusCode,
    ).toBe(429);
    expect(
      (
        await app.inject({
          method: "DELETE",
          url: `/api/v15/schedules/${scheduleId}`,
          headers: { authorization: `Bearer ${testToken}` },
        })
      ).statusCode,
    ).toBe(204);
    await writeFile(join(root, "notes.md"), "UmaAgent searchable knowledge");
    const queuedKnowledge = await app.inject({
      method: "POST",
      url: "/api/v15/knowledge",
      headers: { authorization: `Bearer ${testToken}` },
      payload: { name: "notes", path: "notes.md" },
    });
    expect(queuedKnowledge.json()).toMatchObject({ status: "queued" });
    const knowledgeId = queuedKnowledge.json<{ id: string }>().id;
    for (let attempt = 0; attempt < 20; attempt++) {
      if (runtime.knowledge.list().find((item) => item.id === knowledgeId)?.status === "indexed") break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(runtime.knowledge.search("searchable knowledge")[0]?.content).toContain("UmaAgent");
    expect(
      (
        await app.inject({
          method: "DELETE",
          url: `/api/v15/knowledge/${knowledgeId}`,
          headers: { authorization: `Bearer ${testToken}` },
        })
      ).statusCode,
    ).toBe(204);
    const crossOriginLogin = await app.inject({
      method: "POST",
      url: "/api/v15/auth/login",
      headers: { origin: "https://attacker.example" },
      payload: { token: testToken },
    });
    expect(crossOriginLogin.statusCode).toBe(403);
    const bearerFromWrongOrigin = await app.inject({
      method: "GET",
      url: "/api/v15/sessions",
      headers: { authorization: `Bearer ${testToken}`, origin: "https://attacker.example" },
    });
    expect(bearerFromWrongOrigin.statusCode).toBe(403);
    const unknown = await app.inject({
      method: "GET",
      url: "/api/v15/unknown",
      headers: { authorization: `Bearer ${testToken}` },
    });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json<{ error: { code: string } }>().error.code).toBe("not_found");
    const removedV11 = await app.inject({ method: "GET", url: "/api/v11/health/live", headers: authHeaders });
    expect(removedV11.statusCode).toBe(404);
    expect(removedV11.json<{ error: { code: string; message: string } }>().error).toMatchObject({
      code: "unsupported_api_version",
      message: "Only API v15 is supported",
    });
    const trends = await app.inject({
      method: "GET",
      url: "/api/v15/evaluations/trends?from=0&groupBy=suite",
      headers: authHeaders,
    });
    expect(trends.statusCode).toBe(200);
    expect(trends.json()).toEqual([
      expect.objectContaining({ group: "test-1", totalCases: 1, passedCases: 1, passRate: 1 }),
    ]);
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/v15/evaluations/trends?from=10&to=1",
          headers: authHeaders,
        })
      ).statusCode,
    ).toBe(400);
    const removedV4 = await app.inject({
      method: "GET",
      url: "/api/v4/health",
      headers: { authorization: `Bearer ${testToken}` },
    });
    expect(removedV4.statusCode).toBe(404);
  });
});
