import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
    expect((await app.inject({ method: "GET", url: "/api/v6/health/live" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/v6/health/ready" })).json()).toMatchObject({
      status: "ok",
      version: "0.7.0",
      protocolVersion: 6,
    });
    expect((await app.inject({ method: "GET", url: "/api/v6/sessions" })).statusCode).toBe(401);
    const preflight = await app.inject({
      method: "OPTIONS",
      url: "/api/v6/sessions",
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
      url: "/api/v6/sessions",
      headers: {
        origin: "https://attacker.example",
        "access-control-request-method": "POST",
      },
    });
    expect(deniedPreflight.statusCode).toBe(403);
    const login = await app.inject({
      method: "POST",
      url: "/api/v6/auth/login",
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
      url: "/api/v6/sessions",
      headers: { cookie: `${webCookie?.name}=${webCookie?.value}` },
      payload: {},
    });
    expect(missingOrigin.statusCode).toBe(403);
    expect(missingOrigin.json().error.code).toBe("forbidden");
    const cookieSession = await app.inject({
      method: "POST",
      url: "/api/v6/sessions",
      headers: {
        cookie: `${webCookie?.name}=${webCookie?.value}`,
        origin: "https://web.example",
      },
      payload: {},
    });
    expect(cookieSession.statusCode).toBe(200);
    const cookieSessionId = cookieSession.json<{ id: string }>().id;
    const socket = await app.injectWS("/api/v6/events", {
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
      app.injectWS("/api/v6/events", { headers: { origin: "https://attacker.example" } }),
    ).rejects.toThrow("Unexpected server response: 403");
    const logout = await app.inject({
      method: "POST",
      url: "/api/v6/auth/logout",
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
      url: "/api/v6/sessions",
      headers: { authorization: "Bearer secret" },
      payload: { title: "API test" },
    });
    expect(created.statusCode).toBe(200);
    const session = created.json<{ id: string }>();
    const snapshot = await app.inject({
      method: "GET",
      url: `/api/v6/sessions/${session.id}/snapshot`,
      headers: { authorization: "Bearer secret" },
    });
    expect(snapshot.json<{ session: { title: string } }>().session.title).toBe("API test");
    const memory = await app.inject({
      method: "POST",
      url: "/api/v6/memory",
      headers: { authorization: "Bearer secret" },
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
      url: `/api/v6/attachments/${attachment.id}/content`,
      headers: { authorization: "Bearer secret" },
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
    ).run;
    runtime.database.createCheckpoint({
      runId: run.id,
      phase: "preflight",
      turnCount: 0,
      lastMessageSequence: 1,
      safeToResume: true,
    });
    const history = await app.inject({
      method: "GET",
      url: `/api/v6/sessions/${session.id}/history?limit=10`,
      headers: { authorization: "Bearer secret" },
    });
    expect(history.json<{ items: Array<{ content: string }> }>().items[0]?.content).toBe("history item");
    const checkpoints = await app.inject({
      method: "GET",
      url: `/api/v6/runs/${run.id}/checkpoints`,
      headers: { authorization: "Bearer secret" },
    });
    expect(checkpoints.json<Array<{ phase: string }>>()[0]?.phase).toBe("preflight");
    const invalidPatch = await app.inject({
      method: "PATCH",
      url: `/api/v6/sessions/${session.id}`,
      headers: { authorization: "Bearer secret" },
      payload: { workspace: "elsewhere" },
    });
    expect(invalidPatch.statusCode).toBe(400);
    expect(invalidPatch.json()).toMatchObject({
      error: { code: "validation_failed", retryable: false },
    });
    expect(invalidPatch.json<{ error: { requestId: string } }>().error.requestId).toMatch(/^req-/);
    const createdSchedule = await app.inject({
      method: "POST",
      url: "/api/v6/schedules",
      headers: { authorization: "Bearer secret" },
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
          url: "/api/v6/schedules",
          headers: { authorization: "Bearer secret" },
        })
      ).json<Array<{ id: string }>>(),
    ).toEqual([expect.objectContaining({ id: scheduleId })]);
    expect(
      (
        await app.inject({
          method: "PATCH",
          url: `/api/v6/schedules/${scheduleId}`,
          headers: { authorization: "Bearer secret" },
          payload: { enabled: false },
        })
      ).json(),
    ).toMatchObject({ enabled: false });
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/api/v6/schedules/${scheduleId}/runs`,
          headers: { authorization: "Bearer secret" },
        })
      ).json(),
    ).toEqual([]);
    const report = await app.inject({
      method: "GET",
      url: "/api/v6/reports/operations?from=0",
      headers: { authorization: "Bearer secret" },
    });
    expect(report.json()).toMatchObject({ runs: { total: 1 }, tools: { calls: 0 } });
    const authHeaders = { authorization: "Bearer secret" };
    expect(
      (await app.inject({ method: "GET", url: "/api/v6/sessions", headers: authHeaders })).json<
        Array<{ id: string }>
      >(),
    ).toEqual(expect.arrayContaining([expect.objectContaining({ id: session.id })]));
    expect(
      (
        await app.inject({
          method: "PATCH",
          url: `/api/v6/sessions/${session.id}`,
          headers: authHeaders,
          payload: { title: "Renamed" },
        })
      ).json(),
    ).toMatchObject({ title: "Renamed" });
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/api/v6/sessions/${session.id}/events?after=-10&limit=5000`,
          headers: authHeaders,
        })
      ).json(),
    ).toMatchObject({ sessionId: session.id });
    expect(
      (await app.inject({ method: "GET", url: "/api/v6/models", headers: authHeaders })).json<
        Array<unknown>
      >(),
    ).toHaveLength(1);
    expect((await app.inject({ method: "GET", url: "/api/v6/skills", headers: authHeaders })).json()).toEqual(
      [],
    );
    expect(
      (await app.inject({ method: "POST", url: "/api/v6/skills/refresh", headers: authHeaders })).json(),
    ).toEqual([]);
    expect((await app.inject({ method: "GET", url: "/api/v6/mcp", headers: authHeaders })).json()).toEqual(
      [],
    );
    expect(
      (await app.inject({ method: "GET", url: "/api/v6/knowledge", headers: authHeaders })).json(),
    ).toEqual([]);
    expect((await app.inject({ method: "GET", url: "/api/v6/tasks", headers: authHeaders })).json()).toEqual(
      [],
    );
    const taskResponse = await app.inject({
      method: "POST",
      url: "/api/v6/tasks",
      headers: authHeaders,
      payload: { prompt: "background prompt", parentSessionId: session.id },
    });
    expect(taskResponse.statusCode).toBe(200);
    const taskId = taskResponse.json<{ id: string }>().id;
    expect(
      (await app.inject({ method: "GET", url: `/api/v6/tasks/${taskId}`, headers: authHeaders })).json(),
    ).toMatchObject({ id: taskId });
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/api/v6/tasks/${taskId}/snapshot`,
          headers: authHeaders,
        })
      ).json(),
    ).toHaveProperty("session");
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/v6/tasks/${taskId}/cancel`,
          headers: authHeaders,
        })
      ).json(),
    ).toMatchObject({ id: taskId });

    const candidateMemory = runtime.createMemoryFact(session.id, "session", "candidate fact");
    runtime.database.updateMemoryFact(candidateMemory.id, "candidate");
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/v6/memory?status=candidate",
          headers: authHeaders,
        })
      ).json<Array<{ id: string }>>(),
    ).toEqual([expect.objectContaining({ id: candidateMemory.id })]);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/v6/memory/${candidateMemory.id}`,
          headers: authHeaders,
          payload: { status: "active" },
        })
      ).json(),
    ).toMatchObject({ status: "active" });
    expect(
      (
        await app.inject({
          method: "DELETE",
          url: `/api/v6/memory/${candidateMemory.id}`,
          headers: authHeaders,
        })
      ).statusCode,
    ).toBe(204);
    expect(
      (await app.inject({ method: "GET", url: `/api/v6/runs/${run.id}`, headers: authHeaders })).json(),
    ).toMatchObject({ id: run.id });
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/api/v6/runs/${run.id}/actions`,
          headers: authHeaders,
        })
      ).json(),
    ).toEqual([]);
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/api/v6/audit/runs/${run.id}`,
          headers: authHeaders,
        })
      ).json(),
    ).toEqual([]);

    const upload = await app.inject({
      method: "POST",
      url: "/api/v6/uploads",
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
      ["POST", "/api/v6/sessions", { mode: "invalid" }],
      ["POST", `/api/v6/sessions/${session.id}/messages`, { text: "missing id" }],
      ["POST", "/api/v6/tasks", {}],
      ["POST", "/api/v6/knowledge", {}],
      ["POST", "/api/v6/knowledge", { name: "attachment", attachmentId: "missing" }],
      ["POST", "/api/v6/schedules", { name: "bad" }],
      ["PATCH", `/api/v6/schedules/${scheduleId}`, { schedule: { kind: "invalid" } }],
      ["POST", `/api/v6/memory/${memory.json<{ id: string }>().id}`, { status: "invalid" }],
      ["POST", `/api/v6/runs/${run.id}/actions/missing/decide`, { decision: "invalid" }],
    ] as const) {
      expect((await app.inject({ method, url, headers: authHeaders, payload })).statusCode).toBe(400);
    }
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/v6/reports/operations?from=10&to=1",
          headers: authHeaders,
        })
      ).statusCode,
    ).toBe(400);
    expect((await app.inject({ method: "GET", url: "/" })).body).toContain("has not been built");
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/v6/schedules/${scheduleId}/run`,
          headers: authHeaders,
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/v6/sessions/${session.id}/cancel`,
          headers: authHeaders,
        })
      ).statusCode,
    ).toBe(409);
    const cancelledRun = await app.inject({
      method: "POST",
      url: `/api/v6/runs/${run.id}/cancel`,
      headers: authHeaders,
    });
    expect(cancelledRun.json()).toMatchObject({ id: run.id, status: "cancelled" });
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/v6/runs/${run.id}/resume`,
          headers: authHeaders,
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/v6/attachments/missing/content",
          headers: authHeaders,
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v6/uploads",
          headers: { ...authHeaders, "content-type": "multipart/form-data; boundary=empty" },
          payload: Buffer.from("--empty--\r\n"),
        })
      ).statusCode,
    ).toBe(400);
    for (let attempt = 0; attempt < 5; attempt++) {
      const invalidLogin = await app.inject({
        method: "POST",
        url: "/api/v6/auth/login",
        headers: { origin: "https://web.example" },
        payload: { token: "wrong" },
      });
      expect(invalidLogin.statusCode).toBe(401);
    }
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v6/auth/login",
          headers: { origin: "https://web.example" },
          payload: { token: "wrong" },
        })
      ).statusCode,
    ).toBe(429);
    expect(
      (
        await app.inject({
          method: "DELETE",
          url: `/api/v6/schedules/${scheduleId}`,
          headers: { authorization: "Bearer secret" },
        })
      ).statusCode,
    ).toBe(204);
    await writeFile(join(root, "notes.md"), "UmaAgent searchable knowledge");
    const queuedKnowledge = await app.inject({
      method: "POST",
      url: "/api/v6/knowledge",
      headers: { authorization: "Bearer secret" },
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
          url: `/api/v6/knowledge/${knowledgeId}`,
          headers: { authorization: "Bearer secret" },
        })
      ).statusCode,
    ).toBe(204);
    const crossOriginLogin = await app.inject({
      method: "POST",
      url: "/api/v6/auth/login",
      headers: { origin: "https://attacker.example" },
      payload: { token: "secret" },
    });
    expect(crossOriginLogin.statusCode).toBe(403);
    const bearerFromWrongOrigin = await app.inject({
      method: "GET",
      url: "/api/v6/sessions",
      headers: { authorization: "Bearer secret", origin: "https://attacker.example" },
    });
    expect(bearerFromWrongOrigin.statusCode).toBe(403);
    const unknown = await app.inject({
      method: "GET",
      url: "/api/v6/unknown",
      headers: { authorization: "Bearer secret" },
    });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json<{ error: { code: string } }>().error.code).toBe("not_found");
    const removedV4 = await app.inject({
      method: "GET",
      url: "/api/v4/health",
      headers: { authorization: "Bearer secret" },
    });
    expect(removedV4.statusCode).toBe(404);
  });
});
