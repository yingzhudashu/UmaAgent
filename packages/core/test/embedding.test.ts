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

  it("fails open when disabled or unconfigured", async () => {
    await expect(new EmbeddingService({ ...config, enabled: false }).embed("text")).resolves.toBeUndefined();
    await expect(new EmbeddingService(config).embedBatch(["text"])).resolves.toEqual([undefined]);
  });

  it("retries transient failures and fails open after the retry budget", async () => {
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
    ).resolves.toEqual([undefined]);
  });
});
