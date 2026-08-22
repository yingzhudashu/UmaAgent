import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UmaRuntime } from "@uma-agent/core";
import type { FastifyRequest } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { AuthService } from "../src/auth.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("multi-user authentication", () => {
  it("issues independent one-time personal tokens and scopes sessions by user", async () => {
    const root = await mkdtemp(join(tmpdir(), "uma-auth-"));
    roots.push(root);
    const database = new (await import("@uma-agent/core")).UmaDatabase(root);
    const runtime = { database, config: { auth: { webSessionHours: 1 } } } as unknown as UmaRuntime;
    const auth = new AuthService(runtime, "break-glass-secret");
    const first = auth.register("phone");
    const second = auth.register("browser");
    expect(first.token).not.toBe(second.token);
    const firstRequest = {
      headers: { authorization: `Bearer ${first.token}` },
      cookies: {},
    } as FastifyRequest;
    const secondRequest = {
      headers: { authorization: `Bearer ${second.token}` },
      cookies: {},
    } as FastifyRequest;
    expect(auth.principalFromRequest(firstRequest)?.userId).toBe(first.userId);
    expect(auth.principalFromRequest(secondRequest)?.userId).toBe(second.userId);
    expect(
      auth.principalFromRequest({
        headers: { authorization: "Bearer invalid" },
        cookies: {},
      } as FastifyRequest),
    ).toBeUndefined();

    const sessionA = database.createSession({
      userId: first.userId,
      mode: "assistant",
      title: "A",
      model: { provider: "test", id: "model" },
      thinkingLevel: "off",
    });
    const sessionB = database.createSession({
      userId: second.userId,
      mode: "assistant",
      title: "B",
      model: { provider: "test", id: "model" },
      thinkingLevel: "off",
    });
    expect(database.listUserSessions(first.userId).map((session) => session.id)).toEqual([sessionA.id]);
    expect(database.listUserSessions(second.userId).map((session) => session.id)).toEqual([sessionB.id]);
    expect(database.sessionOwner(sessionA.id)).toBe(first.userId);
    database.createBackgroundTask({ id: "task-a", sessionId: sessionA.id, prompt: "private A" });
    database.createBackgroundTask({ id: "task-b", sessionId: sessionB.id, prompt: "private B" });
    expect(database.listBackgroundTasks(first.userId).map((task) => task.id)).toEqual(["task-a"]);
    expect(database.listBackgroundTasks(second.userId).map((task) => task.id)).toEqual(["task-b"]);
    expect(database.listAuthTokens(first.userId)).toHaveLength(1);
    expect(database.revokeAuthToken(first.userId, first.id)).toBe(true);
    expect(auth.principalFromRequest(firstRequest)).toBeUndefined();
    process.env.UMA_OAUTH_REDIRECTS = "uma-mobile|com.example.uma:/oauth/callback";
    const verifier = "client-verifier-value";
    const challenge = (await import("node:crypto")).createHash("sha256").update(verifier).digest("base64url");
    const authorization = auth.authorize(second.token, {
      clientId: "uma-mobile",
      redirectUri: "com.example.uma:/oauth/callback",
      codeChallenge: challenge,
    });
    const exchanged = auth.exchangeAuthorizationCode({
      code: authorization.code,
      clientId: "uma-mobile",
      redirectUri: "com.example.uma:/oauth/callback",
      codeVerifier: verifier,
    });
    expect(exchanged.token).toMatch(/^uma_pat_/);
    expect(() =>
      auth.exchangeAuthorizationCode({
        code: authorization.code,
        clientId: "uma-mobile",
        redirectUri: "com.example.uma:/oauth/callback",
        codeVerifier: verifier,
      }),
    ).toThrow("authorization code");
    delete process.env.UMA_OAUTH_REDIRECTS;
    database.close();
  });
});
