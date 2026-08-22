import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { UmaRuntime } from "@uma-agent/core";
import type { FastifyReply, FastifyRequest } from "fastify";

export const COOKIE_NAME = "uma_session";
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

export type AuthPrincipal = {
  userId: string;
  role: "admin" | "user";
  method: "web" | "access_token" | "break_glass";
  scopes: string[];
};

export type IssuedToken = { token: string; id: string; expiresAt: number };

function parsePersonalToken(value: string): { id: string; secret: string } | undefined {
  const match = /^uma_pat_([0-9a-f-]{36})_([A-Za-z0-9_-]{32,})$/.exec(value);
  return match ? { id: match[1] as string, secret: match[2] as string } : undefined;
}

export class AuthService {
  private failures = new Map<string, { count: number; resetAt: number }>();
  private registrations = new Map<string, { count: number; resetAt: number }>();
  private testPrincipal?: AuthPrincipal;
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

  private personalPrincipal(token: string | undefined): AuthPrincipal | undefined {
    if (!token) return undefined;
    const parsed = parsePersonalToken(token);
    if (!parsed) return undefined;
    const record = this.runtime.database.findAuthToken(parsed.id, hash(parsed.secret));
    return record
      ? { userId: record.userId, role: record.role, method: "access_token", scopes: record.scopes }
      : undefined;
  }

  principalFromRequest(request: FastifyRequest): AuthPrincipal | undefined {
    const bearer = request.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
    const personal = this.personalPrincipal(bearer);
    if (personal) return personal;
    if (this.tokenMatches(bearer))
      return { userId: "break-glass", role: "admin", method: "break_glass", scopes: ["break_glass"] };
    const cookie = request.cookies[COOKIE_NAME];
    const session = cookie ? this.runtime.database.webSessionUser(hash(cookie)) : undefined;
    return session
      ? { userId: session.userId, role: session.role, method: "web", scopes: ["user"] }
      : undefined;
  }

  bearerAuthenticated(request: FastifyRequest): boolean {
    const bearer = request.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
    return Boolean(this.personalPrincipal(bearer) || this.tokenMatches(bearer));
  }

  webSessionAuthenticated(request: FastifyRequest): boolean {
    const cookie = request.cookies[COOKIE_NAME];
    return Boolean(cookie && this.runtime.database.hasWebSession(hash(cookie)));
  }

  requestAuthenticated(request: FastifyRequest): boolean {
    return Boolean(this.principalFromRequest(request));
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

  registrationAllowed(ip: string): boolean {
    const current = this.registrations.get(ip);
    return !current || current.resetAt <= Date.now() || current.count < 3;
  }

  recordRegistration(ip: string): void {
    const now = Date.now();
    const current = this.registrations.get(ip);
    this.registrations.set(
      ip,
      !current || current.resetAt <= now
        ? { count: 1, resetAt: now + 86_400_000 }
        : { count: current.count + 1, resetAt: current.resetAt },
    );
  }

  register(label = "primary"): IssuedToken & { userId: string } {
    const user = this.runtime.database.createUser("user");
    const issued = this.issueToken(user.id, label);
    return { ...issued, userId: user.id };
  }

  issueToken(userId: string, label = "token", expiresInDays = 90): IssuedToken {
    const id = randomUUID();
    const secret = randomBytes(32).toString("base64url");
    const expiresAt = Date.now() + Math.min(365, Math.max(1, expiresInDays)) * 86_400_000;
    this.runtime.database.putAuthToken({
      id,
      userId,
      tokenHash: hash(secret),
      label: label.trim().slice(0, 80) || "token",
      scopes: ["user"],
      expiresAt,
    });
    return { token: `uma_pat_${id}_${secret}`, id, expiresAt };
  }

  private redirectAllowed(clientId: string, redirectUri: string): boolean {
    const configured = (process.env.UMA_OAUTH_REDIRECTS ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    return configured.includes(`${clientId}|${redirectUri}`);
  }

  authorize(
    token: string,
    input: { clientId: string; redirectUri: string; codeChallenge: string },
  ): { code: string; expiresAt: number } {
    if (!this.redirectAllowed(input.clientId, input.redirectUri))
      throw new Error("OAuth redirect is not allowed");
    const principal = this.personalPrincipal(token);
    if (!principal) throw new Error("Invalid token");
    const code = randomBytes(32).toString("base64url");
    const expiresAt = Date.now() + 300_000;
    this.runtime.database.putAuthorizationCode({
      code,
      userId: principal.userId,
      clientId: input.clientId,
      redirectUri: input.redirectUri,
      codeChallenge: input.codeChallenge,
      expiresAt,
    });
    return { code, expiresAt };
  }

  exchangeAuthorizationCode(input: {
    code: string;
    clientId: string;
    redirectUri: string;
    codeVerifier: string;
  }): IssuedToken {
    const record = this.runtime.database.consumeAuthorizationCode(input.code);
    if (
      !record ||
      record.expiresAt <= Date.now() ||
      record.clientId !== input.clientId ||
      record.redirectUri !== input.redirectUri
    )
      throw new Error("Invalid authorization code");
    const challenge = createHash("sha256").update(input.codeVerifier).digest("base64url");
    if (challenge !== record.codeChallenge) throw new Error("Invalid PKCE verifier");
    return this.issueToken(record.userId, `oauth:${input.clientId}`, 30);
  }

  testBreakGlassPrincipal(): AuthPrincipal | undefined {
    if (process.env.NODE_ENV !== "test" || !this.sharedToken) return undefined;
    if (this.testPrincipal) return this.testPrincipal;
    const created = this.runtime.database.createUser("admin");
    this.runtime.database.claimUnownedSessions(created.id);
    this.testPrincipal = {
      userId: created.id,
      role: "admin",
      method: "break_glass",
      scopes: ["break_glass"],
    };
    return this.testPrincipal;
  }

  createWebSession(
    reply: FastifyReply,
    userIdOrOptions: string | undefined | { crossOrigin: boolean; secure: boolean },
    maybeOptions?: { crossOrigin: boolean; secure: boolean },
  ): void {
    const userId = typeof userIdOrOptions === "string" ? userIdOrOptions : undefined;
    const options = (typeof userIdOrOptions === "object" ? userIdOrOptions : maybeOptions) ?? {
      crossOrigin: false,
      secure: false,
    };
    const token = randomBytes(32).toString("base64url");
    const expiresAt = Date.now() + this.runtime.config.auth.webSessionHours * 3_600_000;
    this.runtime.database.putWebSession(hash(token), expiresAt, userId);
    reply.setCookie(COOKIE_NAME, token, {
      httpOnly: true,
      sameSite: options.crossOrigin && options.secure ? "none" : "strict",
      secure: options.secure,
      path: "/",
      expires: new Date(expiresAt),
    });
  }

  logout(
    request: FastifyRequest,
    reply: FastifyReply,
    options: { crossOrigin: boolean; secure: boolean },
  ): void {
    const token = request.cookies[COOKIE_NAME];
    if (token) this.runtime.database.deleteWebSession(hash(token));
    reply.clearCookie(COOKIE_NAME, {
      path: "/",
      sameSite: options.crossOrigin && options.secure ? "none" : "strict",
      secure: options.secure,
    });
  }
}
