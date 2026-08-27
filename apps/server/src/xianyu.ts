import { scrypt as nodeScrypt, randomBytes, timingSafeEqual } from "node:crypto";

type Json = Record<string, unknown> | unknown[];

export class XianyuControlClient {
  private readonly baseUrl: string;
  private readonly token: string;
  constructor(adapterUrl: string, token: string) {
    this.baseUrl = adapterUrl.replace(/\/$/, "");
    this.token = token;
  }
  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${this.token}`,
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...init.headers,
      },
    });
    if (!response.ok) throw new Error(`闲鱼 Adapter 请求失败: HTTP ${response.status}`);
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }
  health<T = Json>() {
    return this.request<T>("/health");
  }
  start() {
    return this.request<void>("/start", { method: "POST" });
  }
  stop() {
    return this.request<void>("/stop", { method: "POST" });
  }
  pause() {
    return this.request<void>("/pause", { method: "POST" });
  }
  resume() {
    return this.request<void>("/resume", { method: "POST" });
  }
  conversations<T = Json>() {
    return this.request<T>("/conversations");
  }
  history<T = Json>(id: string) {
    return this.request<T>(`/history/${encodeURIComponent(id)}`);
  }
  item<T = Json>(id: string) {
    return this.request<T>(`/item/${encodeURIComponent(id)}`);
  }
  chat<T = Json>(body: Json) {
    return this.request<T>("/chat", { method: "POST", body: JSON.stringify(body) });
  }
  publish<T = Json>(body: Json) {
    return this.request<T>("/publish", { method: "POST", body: JSON.stringify(body) });
  }
}

export class XianyuGrantStore {
  private readonly grants = new Map<string, { value: string; expiresAt: number }>();
  issue(userId: string): { grant: string; expiresAt: number } {
    const value = randomBytes(32).toString("base64url");
    const expiresAt = Date.now() + 30 * 60 * 1000;
    this.grants.set(userId, { value, expiresAt });
    return { grant: value, expiresAt };
  }
  valid(userId: string, grant: string): boolean {
    const entry = this.grants.get(userId);
    if (!entry || entry.expiresAt <= Date.now()) {
      this.grants.delete(userId);
      return false;
    }
    const actual = Buffer.from(entry.value);
    const supplied = Buffer.from(grant);
    return actual.length === supplied.length && timingSafeEqual(actual, supplied);
  }
  revoke(userId: string): void {
    this.grants.delete(userId);
  }
}

export async function verifyXianyuPassword(password: string, encoded: string): Promise<boolean> {
  const parts = encoded.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, nText, rText, pText, saltText, digestText] = parts as [
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  const N = Number(nText),
    r = Number(rText),
    p = Number(pText);
  if (![N, r, p].every(Number.isSafeInteger) || N < 2 || r < 1 || p < 1) return false;
  try {
    const salt = Buffer.from(saltText, "base64url");
    const expected = Buffer.from(digestText, "base64url");
    const derived = await new Promise<Buffer>((resolve, reject) =>
      nodeScrypt(password, salt, expected.length, { N, r, p }, (error, value) =>
        error ? reject(error) : resolve(value),
      ),
    );
    return derived.length === expected.length && timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}
