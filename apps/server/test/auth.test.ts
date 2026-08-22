import type { UmaRuntime } from "@uma-agent/core";
import type { FastifyReply, FastifyRequest } from "fastify";
import { describe, expect, it, vi } from "vitest";
import { AuthService, COOKIE_NAME } from "../src/auth.js";

function fixture() {
  const sessions = new Set<string>();
  const users = new Map<string, { id: string; role: "admin" | "user" }>();
  const tokens = new Map<string, { userId: string; tokenHash: string }>();
  const database = {
    hasWebSession: vi.fn((hash: string) => sessions.has(hash)),
    putWebSession: vi.fn((hash: string) => sessions.add(hash)),
    deleteWebSession: vi.fn((hash: string) => sessions.delete(hash)),
    createUser: vi.fn((role: "admin" | "user" = "user") => {
      const id = `${role}-user`;
      users.set(id, { id, role });
      return { id, role, status: "active" as const };
    }),
    putAuthToken: vi.fn((input: { id: string; userId: string; tokenHash: string }) =>
      tokens.set(input.id, { userId: input.userId, tokenHash: input.tokenHash }),
    ),
    findAuthToken: vi.fn((id: string, tokenHash: string) => {
      const token = tokens.get(id);
      const user = token ? users.get(token.userId) : undefined;
      return token && user && token.tokenHash === tokenHash
        ? { id, userId: user.id, role: user.role, scopes: ["user"] }
        : undefined;
    }),
  };
  const runtime = { config: { auth: { webSessionHours: 1 } }, database } as unknown as UmaRuntime;
  return { auth: new AuthService(runtime), database };
}

const request = (headers: Record<string, string> = {}, cookies: Record<string, string> = {}) =>
  ({ headers, cookies }) as unknown as FastifyRequest;

describe("AuthService", () => {
  it("authenticates personal bearer credentials and cookies", () => {
    const { auth, database } = fixture();
    const user = auth.register("test");
    expect(auth.bearerAuthenticated(request({ authorization: `Bearer ${user.token}` }))).toBe(true);
    expect(auth.bearerAuthenticated(request({ authorization: "Bearer invalid" }))).toBe(false);
    expect(auth.requestAuthenticated(request({ authorization: `Bearer ${user.token}` }))).toBe(true);
    expect(auth.requestAuthenticated(request())).toBe(false);
    expect(auth.webSessionAuthenticated(request())).toBe(false);
    database.hasWebSession.mockReturnValueOnce(true);
    expect(auth.webSessionAuthenticated(request({}, { [COOKIE_NAME]: "cookie" }))).toBe(true);
  });

  it("limits repeated failures and resets the window", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const { auth } = fixture();
    expect(auth.loginAllowed("127.0.0.1")).toBe(true);
    for (let count = 0; count < 5; count++) auth.recordFailure("127.0.0.1");
    expect(auth.loginAllowed("127.0.0.1")).toBe(false);
    vi.advanceTimersByTime(60_001);
    expect(auth.loginAllowed("127.0.0.1")).toBe(true);
    vi.useRealTimers();
  });

  it("creates and clears strict and cross-origin cookies", () => {
    const { auth, database } = fixture();
    const setCookie = vi.fn();
    const clearCookie = vi.fn();
    const reply = { setCookie, clearCookie } as unknown as FastifyReply;
    const user = auth.register("web");
    auth.createWebSession(reply, user.userId, { crossOrigin: false, secure: false });
    auth.createWebSession(reply, user.userId, { crossOrigin: true, secure: true });
    expect(setCookie.mock.calls[0]?.[2]).toMatchObject({ sameSite: "strict", secure: false });
    expect(setCookie.mock.calls[1]?.[2]).toMatchObject({ sameSite: "none", secure: true });
    expect(database.putWebSession).toHaveBeenCalledTimes(2);
    auth.logout(request(), reply, { crossOrigin: false, secure: false });
    auth.logout(request({}, { [COOKIE_NAME]: "cookie" }), reply, { crossOrigin: true, secure: true });
    expect(database.deleteWebSession).toHaveBeenCalledTimes(1);
  });
});
