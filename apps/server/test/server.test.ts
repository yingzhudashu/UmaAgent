import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type UmaConfig, UmaRuntime } from "@uma-agent/core";
import { afterEach, describe, expect, it } from "vitest";
import { createServer } from "../src/app.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const action of cleanup.splice(0).reverse()) await action();
});

describe("server", () => {
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
      auth: { tokenEnv: "UMA_TEST_TOKEN", webSessionHours: 1 },
      models: [
        {
          provider: "test",
          id: "model",
          name: "Model",
          api: "openai-responses",
          baseUrl: "http://127.0.0.1:9/v1",
          apiKeyEnv: "UMA_TEST_KEY",
          reasoning: false,
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
    };
    process.env.UMA_TEST_TOKEN = "secret";
    const runtime = new UmaRuntime(config);
    await runtime.start();
    const app = await createServer(runtime, { webRoot: false });
    cleanup.push(async () => {
      await app.close();
      await runtime.stop();
      await rm(root, { recursive: true, force: true });
      delete process.env.UMA_TEST_TOKEN;
    });
    expect((await app.inject({ method: "GET", url: "/api/v3/sessions" })).statusCode).toBe(401);
    const preflight = await app.inject({
      method: "OPTIONS",
      url: "/api/v3/sessions",
      headers: {
        origin: "https://web.example",
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type",
      },
    });
    expect(preflight.statusCode).toBe(204);
    expect(preflight.headers["access-control-allow-origin"]).toBe("https://web.example");
    expect(preflight.headers["access-control-allow-credentials"]).toBe("true");
    const deniedPreflight = await app.inject({
      method: "OPTIONS",
      url: "/api/v3/sessions",
      headers: {
        origin: "https://attacker.example",
        "access-control-request-method": "POST",
      },
    });
    expect(deniedPreflight.statusCode).toBe(403);
    const login = await app.inject({
      method: "POST",
      url: "/api/v3/auth/login",
      headers: { origin: "https://web.example" },
      payload: { token: "secret" },
    });
    expect(login.statusCode).toBe(200);
    expect(login.headers["set-cookie"]).toContain("SameSite=None");
    expect(login.headers["set-cookie"]).toContain("Secure");
    const webCookie = login.cookies[0];
    expect(webCookie).toBeDefined();
    const missingOrigin = await app.inject({
      method: "POST",
      url: "/api/v3/sessions",
      headers: { cookie: `${webCookie?.name}=${webCookie?.value}` },
      payload: {},
    });
    expect(missingOrigin.statusCode).toBe(403);
    expect(missingOrigin.json().error.code).toBe("origin_required");
    const cookieSession = await app.inject({
      method: "POST",
      url: "/api/v3/sessions",
      headers: {
        cookie: `${webCookie?.name}=${webCookie?.value}`,
        origin: "https://web.example",
      },
      payload: {},
    });
    expect(cookieSession.statusCode).toBe(200);
    const cookieSessionId = cookieSession.json<{ id: string }>().id;
    const socket = await app.injectWS("/api/v3/events", {
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
      app.injectWS("/api/v3/events", { headers: { origin: "https://attacker.example" } }),
    ).rejects.toThrow("Unexpected server response: 403");
    const logout = await app.inject({
      method: "POST",
      url: "/api/v3/auth/logout",
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
      url: "/api/v3/sessions",
      headers: { authorization: "Bearer secret" },
      payload: { title: "API test" },
    });
    expect(created.statusCode).toBe(200);
    const session = created.json<{ id: string }>();
    const snapshot = await app.inject({
      method: "GET",
      url: `/api/v3/sessions/${session.id}`,
      headers: { authorization: "Bearer secret" },
    });
    expect(snapshot.json<{ session: { title: string } }>().session.title).toBe("API test");
    const invalidPatch = await app.inject({
      method: "PATCH",
      url: `/api/v3/sessions/${session.id}`,
      headers: { authorization: "Bearer secret" },
      payload: { workspace: "elsewhere" },
    });
    expect(invalidPatch.statusCode).toBe(400);
    const crossOriginLogin = await app.inject({
      method: "POST",
      url: "/api/v3/auth/login",
      headers: { origin: "https://attacker.example" },
      payload: { token: "secret" },
    });
    expect(crossOriginLogin.statusCode).toBe(403);
    const bearerFromWrongOrigin = await app.inject({
      method: "GET",
      url: "/api/v3/sessions",
      headers: { authorization: "Bearer secret", origin: "https://attacker.example" },
    });
    expect(bearerFromWrongOrigin.statusCode).toBe(403);
    const unknown = await app.inject({
      method: "GET",
      url: "/api/v3/unknown",
      headers: { authorization: "Bearer secret" },
    });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json<{ error: { code: string } }>().error.code).toBe("not_found");
  });
});
