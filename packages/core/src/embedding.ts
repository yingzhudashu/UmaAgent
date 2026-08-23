import { createHash } from "node:crypto";
import type { EmbeddingConfig } from "./types.js";

type EmbeddingResponse = { data?: Array<{ embedding?: number[]; index?: number }> };

export class EmbeddingService {
  private readonly cache = new Map<string, number[]>();
  private readonly pending = new Map<string, Promise<number[] | undefined>>();
  private readonly apiKey: string | undefined;
  private activeRequests = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(config?: EmbeddingConfig) {
    this.config = config ?? {
      enabled: false,
      baseUrl: "https://api.siliconflow.cn/v1",
      model: "BAAI/bge-m3",
      apiKeyEnv: "EMBEDDING_API_KEY",
      timeoutMs: 30_000,
      batchSize: 32,
      cacheSize: 2048,
      maxConcurrentRequests: 2,
      retryAttempts: 2,
    };
    this.apiKey = process.env[this.config.apiKeyEnv]?.trim();
  }

  private readonly config: EmbeddingConfig;

  get enabled(): boolean {
    return this.config.enabled && Boolean(this.apiKey);
  }

  get model(): string {
    return this.config.model;
  }

  hash(text: string): string {
    return createHash("sha256").update(text).digest("hex");
  }

  async embed(text: string): Promise<number[] | undefined> {
    if (!this.enabled || !text.trim()) return undefined;
    const key = `${this.config.model}:${this.hash(text)}`;
    const cached = this.cache.get(key);
    if (cached) return cached;
    const existing = this.pending.get(key);
    if (existing) return existing;
    const request = this.fetch([text])
      .then((items) => {
        const vector = items[0];
        if (!vector) return undefined;
        this.remember(key, vector);
        return vector;
      })
      .finally(() => this.pending.delete(key));
    this.pending.set(key, request);
    return request;
  }

  async embedBatch(texts: string[]): Promise<Array<number[] | undefined>> {
    if (!this.enabled) return texts.map(() => undefined);
    const result: Array<number[] | undefined> = [];
    try {
      for (let offset = 0; offset < texts.length; offset += this.config.batchSize) {
        const batch = texts.slice(offset, offset + this.config.batchSize);
        const values = await this.fetch(batch);
        batch.forEach((text, index) => {
          const vector = values[index];
          if (vector) this.remember(`${this.config.model}:${this.hash(text)}`, vector);
          result.push(vector);
        });
      }
    } catch {
      return texts.map(() => undefined);
    }
    return result;
  }

  private remember(key: string, vector: number[]): void {
    this.cache.delete(key);
    this.cache.set(key, vector);
    while (this.cache.size > this.config.cacheSize)
      this.cache.delete(this.cache.keys().next().value as string);
  }

  private async fetch(input: string[]): Promise<number[][]> {
    if (!this.apiKey) return [];
    await this.acquire();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
    try {
      let lastError: unknown;
      for (let attempt = 0; attempt <= this.config.retryAttempts; attempt += 1) {
        try {
          const response = await fetch(`${this.config.baseUrl}/embeddings`, {
            method: "POST",
            headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
            body: JSON.stringify({ model: this.config.model, input }),
            signal: controller.signal,
          });
          if (!response.ok) {
            if (![408, 425, 429, 500, 502, 503, 504].includes(response.status))
              throw new Error(`Embedding provider returned HTTP ${response.status}`);
            throw new Error(`Transient embedding provider HTTP ${response.status}`);
          }
          const body = (await response.json()) as EmbeddingResponse;
          return (body.data ?? [])
            .sort((left, right) => (left.index ?? 0) - (right.index ?? 0))
            .map((item) => item.embedding ?? []);
        } catch (error) {
          lastError = error;
          if (controller.signal.aborted || attempt >= this.config.retryAttempts) break;
          await new Promise<void>((resolve) => setTimeout(resolve, Math.min(1_000 * 2 ** attempt, 5_000)));
        }
      }
      throw lastError instanceof Error ? lastError : new Error(String(lastError));
    } finally {
      clearTimeout(timer);
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.activeRequests < this.config.maxConcurrentRequests) {
      this.activeRequests += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) =>
      this.waiters.push(() => {
        this.activeRequests += 1;
        resolve();
      }),
    );
  }

  private release(): void {
    const next = this.waiters.shift();
    if (next) next();
    else this.activeRequests = Math.max(0, this.activeRequests - 1);
  }
}
