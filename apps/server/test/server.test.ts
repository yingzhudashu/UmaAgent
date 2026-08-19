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
        webOrigins: [],
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
    };
    process.env.UMA_TEST_TOKEN = "secret";
    const runtime = new UmaRuntime(config);
    await runtime.start();
    const app = await createServer(runtime);
    cleanup.push(async () => {
      await app.close();
      await runtime.stop();
      await rm(root, { recursive: true, force: true });
      delete process.env.UMA_TEST_TOKEN;
    });
    expect((await app.inject({ method: "GET", url: "/api/v1/sessions" })).statusCode).toBe(401);
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/sessions",
      headers: { authorization: "Bearer secret" },
      payload: { title: "API test" },
    });
    expect(created.statusCode).toBe(200);
    const session = created.json<{ id: string }>();
    const snapshot = await app.inject({
      method: "GET",
      url: `/api/v1/sessions/${session.id}`,
      headers: { authorization: "Bearer secret" },
    });
    expect(snapshot.json<{ session: { title: string } }>().session.title).toBe("API test");
    const invalidPatch = await app.inject({
      method: "PATCH",
      url: `/api/v1/sessions/${session.id}`,
      headers: { authorization: "Bearer secret" },
      payload: { workspace: "elsewhere" },
    });
    expect(invalidPatch.statusCode).toBe(400);
    const crossOriginLogin = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: { origin: "https://attacker.example" },
      payload: { token: "secret" },
    });
    expect(crossOriginLogin.statusCode).toBe(403);
    const unknown = await app.inject({
      method: "GET",
      url: "/api/v1/unknown",
      headers: { authorization: "Bearer secret" },
    });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json<{ error: { code: string } }>().error.code).toBe("not_found");
  });
});
