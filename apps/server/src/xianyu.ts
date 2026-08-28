import { scrypt as nodeScrypt, randomBytes, timingSafeEqual } from "node:crypto";

type Json = Record<string, unknown> | unknown[];

export function validateXianyuChatBody(body: Record<string, unknown>): Record<string, string> {
  if (
    typeof body.receiverId !== "string" ||
    !body.receiverId.trim() ||
    typeof body.itemId !== "string" ||
    !body.itemId.trim()
  )
    throw new Error("receiverId and itemId are required");
  return { receiverId: body.receiverId.trim(), itemId: body.itemId.trim() };
}

export function validateXianyuPublishBody(body: Record<string, unknown>): Record<string, unknown> {
  const allowed = new Set([
    "description",
    "imagePaths",
    "delivery",
    "longitude",
    "latitude",
    "currentPrice",
    "originalPrice",
    "shippingFee",
    "selfPickup",
  ]);
  const unknown = Object.keys(body).filter((key) => !allowed.has(key));
  if (unknown.length) throw new Error(`发布请求包含未知字段: ${unknown.join(", ")}`);
  const imagePaths = body.imagePaths;
  const delivery = body.delivery;
  const longitude = body.longitude;
  const latitude = body.latitude;
  if (
    typeof body.description !== "string" ||
    !body.description.trim() ||
    !Array.isArray(imagePaths) ||
    imagePaths.length === 0 ||
    !imagePaths.every((value) => typeof value === "string" && value.trim()) ||
    (typeof longitude !== "string" && typeof longitude !== "number") ||
    String(longitude).trim() === "" ||
    (typeof latitude !== "string" && typeof latitude !== "number") ||
    String(latitude).trim() === "" ||
    !["free_shipping", "distance_based", "fixed", "pickup_only"].includes(String(delivery))
  )
    throw new Error("description, imagePaths, delivery, longitude and latitude are required");
  for (const name of ["currentPrice", "originalPrice", "shippingFee"] as const) {
    if (body[name] === undefined) continue;
    const value = Number(body[name]);
    if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be a non-negative number`);
  }
  if (String(delivery) === "fixed" && body.shippingFee === undefined)
    throw new Error("fixed delivery requires shippingFee");
  if (body.selfPickup !== undefined && typeof body.selfPickup !== "boolean")
    throw new Error("selfPickup must be boolean");
  return {
    description: body.description.trim(),
    imagePaths: imagePaths.map((value) => String(value).trim()),
    delivery: String(delivery),
    longitude: String(longitude).trim(),
    latitude: String(latitude).trim(),
    ...(body.currentPrice === undefined ? {} : { currentPrice: body.currentPrice }),
    ...(body.originalPrice === undefined ? {} : { originalPrice: body.originalPrice }),
    ...(body.shippingFee === undefined ? {} : { shippingFee: body.shippingFee }),
    ...(body.selfPickup === undefined ? {} : { selfPickup: body.selfPickup }),
  };
}

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
    const now = Date.now();
    for (const [id, entry] of this.grants) if (entry.expiresAt <= now) this.grants.delete(id);
    const value = randomBytes(32).toString("base64url");
    const expiresAt = now + 30 * 60 * 1000;
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
  if (
    ![N, r, p].every(Number.isSafeInteger) ||
    N < 2 ||
    N > 1_048_576 ||
    (N & (N - 1)) !== 0 ||
    r < 1 ||
    r > 32 ||
    p < 1 ||
    p > 16
  )
    return false;
  try {
    const salt = Buffer.from(saltText, "base64url");
    const expected = Buffer.from(digestText, "base64url");
    if (salt.length < 8 || salt.length > 64 || expected.length < 16 || expected.length > 64) return false;
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
