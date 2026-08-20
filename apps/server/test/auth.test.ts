import type { UmaRuntime } from "@uma-agent/core";
import type { FastifyReply, FastifyRequest } from "fastify";
import { describe, expect, it, vi } from "vitest";
import { AuthService, COOKIE_NAME } from "../src/auth.js";

function fixture(sharedToken: string | undefined = "secret") {
  const sessions = new Set<string>();
  const database = {
    hasWebSession: vi.fn((hash: string) => sessions.has(hash)),
    putWebSession: vi.fn((hash: string) => sessions.add(hash)),
    deleteWebSession: vi.fn((hash: string) => sessions.delete(hash)),
  };
  const runtime = {
    config: { auth: { webSessionHours: 1 } },
    database,
  } as unknown as UmaRuntime;
  return { auth: new AuthService(runtime, sharedToken), database, sessions };
}

const request = (headers: Record<string, string> = {}, cookies: Record<string, string> = {}) =>
  ({ headers, cookies }) as unknown as FastifyRequest;

describe("AuthService", () => {
  it("authenticates constant-time bearer and cookie credentials", () => {
    const { auth, database } = fixture();
    expect(auth.tokenMatches(undefined)).toBe(false);
    expect(auth.tokenMatches("wrong")).toBe(false);
    expect(auth.tokenMatches("secret")).toBe(true);
    expect(fixture("").auth.tokenMatches("secret")).toBe(false);
    expect(auth.bearerAuthenticated(request())).toBe(false);
    expect(auth.bearerAuthenticated(request({ authorization: "Basic secret" }))).toBe(false);
    expect(auth.bearerAuthenticated(request({ authorization: "Bearer secret" }))).toBe(true);
    expect(auth.webSessionAuthenticated(request())).toBe(false);
    database.hasWebSession.mockReturnValueOnce(true);
    expect(auth.webSessionAuthenticated(request({}, { [COOKIE_NAME]: "cookie" }))).toBe(true);
    expect(auth.requestAuthenticated(request({ authorization: "Bearer secret" }))).toBe(true);
    expect(auth.requestAuthenticated(request())).toBe(false);
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
    auth.recordFailure("127.0.0.1");
    expect(auth.loginAllowed("127.0.0.1")).toBe(true);
    vi.useRealTimers();
  });

  it("creates and clears strict and cross-origin cookies", () => {
    const { auth, database } = fixture();
    const setCookie = vi.fn();
    const clearCookie = vi.fn();
    const reply = { setCookie, clearCookie } as unknown as FastifyReply;
    auth.createWebSession(reply, { crossOrigin: false, secure: false });
    auth.createWebSession(reply, { crossOrigin: true, secure: true });
    expect(setCookie.mock.calls[0]?.[2]).toMatchObject({ sameSite: "strict", secure: false });
    expect(setCookie.mock.calls[1]?.[2]).toMatchObject({ sameSite: "none", secure: true });
    expect(database.putWebSession).toHaveBeenCalledTimes(2);

    auth.logout(request(), reply, { crossOrigin: false, secure: false });
    auth.logout(request({}, { [COOKIE_NAME]: "cookie" }), reply, {
      crossOrigin: true,
      secure: true,
    });
    expect(database.deleteWebSession).toHaveBeenCalledTimes(1);
    expect(clearCookie.mock.calls[0]?.[1]).toMatchObject({ sameSite: "strict", secure: false });
    expect(clearCookie.mock.calls[1]?.[1]).toMatchObject({ sameSite: "none", secure: true });
  });
});
