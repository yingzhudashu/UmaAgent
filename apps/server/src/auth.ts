import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { UmaRuntime } from "@uma-agent/core";
import type { FastifyReply, FastifyRequest } from "fastify";

export const COOKIE_NAME = "uma_session";
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

export class AuthService {
  private failures = new Map<string, { count: number; resetAt: number }>();
  constructor(
    private readonly runtime: UmaRuntime,
    private readonly sharedToken: string | undefined,
  ) {}

  tokenMatches(token: string | undefined): boolean {
    if (!this.sharedToken || !token) return false;
    const actual = Buffer.from(hash(token));
    const expected = Buffer.from(hash(this.sharedToken));
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }

  requestAuthenticated(request: FastifyRequest): boolean {
    const bearer = request.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
    if (bearer && this.tokenMatches(bearer)) return true;
    const cookie = request.cookies[COOKIE_NAME];
    return Boolean(cookie && this.runtime.database.hasWebSession(hash(cookie)));
  }

  loginAllowed(ip: string): boolean {
    const now = Date.now();
    const current = this.failures.get(ip);
    if (!current || current.resetAt <= now) return true;
    return current.count < 5;
  }

  recordFailure(ip: string): void {
    const now = Date.now();
    const current = this.failures.get(ip);
    this.failures.set(
      ip,
      !current || current.resetAt <= now
        ? { count: 1, resetAt: now + 60_000 }
        : { ...current, count: current.count + 1 },
    );
  }

  createWebSession(reply: FastifyReply): void {
    const token = randomBytes(32).toString("base64url");
    const expiresAt = Date.now() + this.runtime.config.auth.webSessionHours * 3_600_000;
    this.runtime.database.putWebSession(hash(token), expiresAt);
    reply.setCookie(COOKIE_NAME, token, {
      httpOnly: true,
      sameSite: "strict",
      secure:
        this.runtime.config.server.host !== "127.0.0.1" && this.runtime.config.server.host !== "localhost",
      path: "/",
      expires: new Date(expiresAt),
    });
  }

  logout(request: FastifyRequest, reply: FastifyReply): void {
    const token = request.cookies[COOKIE_NAME];
    if (token) this.runtime.database.deleteWebSession(hash(token));
    reply.clearCookie(COOKIE_NAME, { path: "/" });
  }
}
