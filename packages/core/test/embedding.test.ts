import { afterEach, describe, expect, it, vi } from "vitest";
import { EmbeddingService } from "../src/embedding.js";

const config = {
  enabled: true,
  baseUrl: "https://embedding.test/v1",
  model: "test-model",
  apiKeyEnv: "TEST_EMBEDDING_KEY",
  timeoutMs: 1_000,
  batchSize: 2,
  cacheSize: 2,
  maxConcurrentRequests: 2,
  retryAttempts: 2,
};

describe("EmbeddingService", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.TEST_EMBEDDING_KEY;
  });

  it("batches requests and caches repeated text", async () => {
    process.env.TEST_EMBEDDING_KEY = "secret";
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [
            { index: 0, embedding: [1, 0] },
            { index: 1, embedding: [0, 1] },
          ],
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
    );
    const service = new EmbeddingService(config);
    await expect(service.embedBatch(["one", "two"])).resolves.toEqual([
      [1, 0],
      [0, 1],
    ]);
    await expect(service.embed("one")).resolves.toEqual([1, 0]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("uses keyword mode only when explicitly disabled and rejects missing credentials", async () => {
    await expect(new EmbeddingService({ ...config, enabled: false }).embed("text")).resolves.toBeUndefined();
    expect(() => new EmbeddingService(config)).toThrow("TEST_EMBEDDING_KEY");
  });

  it("retries transient failures and propagates exhausted batch failures", async () => {
    process.env.TEST_EMBEDDING_KEY = "secret";
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(new Error("temporary"))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: [{ index: 0, embedding: [1, 2] }] }), { status: 200 }),
      );
    await expect(new EmbeddingService({ ...config, retryAttempts: 1 }).embed("retry")).resolves.toEqual([
      1, 2,
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    fetchMock.mockRejectedValue(new Error("down"));
    await expect(
      new EmbeddingService({ ...config, retryAttempts: 1 }).embedBatch(["unavailable"]),
    ).rejects.toThrow("down");
  });

  it("hands queued permits over without leaking capacity across waves", async () => {
    process.env.TEST_EMBEDDING_KEY = "secret";
    let active = 0;
    let peak = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      return new Response(JSON.stringify({ data: [{ index: 0, embedding: [1, 2] }] }));
    });
    const service = new EmbeddingService({ ...config, retryAttempts: 0 });
    for (let wave = 0; wave < 3; wave++) {
      const values = await Promise.all(
        Array.from({ length: 6 }, (_, index) => service.embed(`${wave}:${index}`)),
      );
      expect(values).toEqual(Array.from({ length: 6 }, () => [1, 2]));
    }
    expect(peak).toBe(2);
  });

  it("does not retry permanent HTTP or vector contract failures", async () => {
    process.env.TEST_EMBEDDING_KEY = "secret";
    const fetchMock = vi.spyOn(globalThis, "fetch");
    for (const response of [
      new Response("unauthorized", { status: 401 }),
      new Response(JSON.stringify({ data: [] })),
    ]) {
      fetchMock.mockClear().mockResolvedValue(response);
      await expect(new EmbeddingService(config).embed("invalid")).rejects.toThrow();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }
  });

  it("rejects missing, empty and nonnumeric vectors rather than indexing partial results", async () => {
    process.env.TEST_EMBEDDING_KEY = "secret";
    const fetchMock = vi.spyOn(globalThis, "fetch");
    for (const data of [[], [{ index: 0, embedding: [] }], [{ index: 0, embedding: ["invalid"] }]]) {
      fetchMock.mockResolvedValue(new Response(JSON.stringify({ data })));
      await expect(
        new EmbeddingService({ ...config, retryAttempts: 0 }).embedBatch(["text"]),
      ).rejects.toThrow("invalid vectors");
    }
  });
});
