import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

if (process.env.UMA_REAL_API !== "1")
  throw new Error("Real Embedding smoke is disabled. Set UMA_REAL_API=1 to authorize the external request.");

const configPath = resolve(process.env.UMA_REAL_CONFIG?.trim() || "docker/uma.config.json");
const config = JSON.parse(await readFile(configPath, "utf8"));
const embedding = config.embedding;
if (!embedding?.enabled) throw new Error(`Embedding is not enabled in ${configPath}`);
const apiKeyEnv = String(embedding.apiKeyEnv || "EMBEDDING_API_KEY");
if (!process.env[apiKeyEnv]?.trim()) throw new Error(`Missing API key ${apiKeyEnv} in the environment`);

const { EmbeddingService } = await import("../packages/core/dist/embedding.js");
const service = new EmbeddingService({
  enabled: true,
  baseUrl: String(embedding.baseUrl),
  model: String(embedding.model),
  apiKeyEnv,
  timeoutMs: Number(embedding.timeoutMs ?? 30_000),
  batchSize: Number(embedding.batchSize ?? 32),
  cacheSize: Number(embedding.cacheSize ?? 2048),
  maxConcurrentRequests: Number(embedding.maxConcurrentRequests ?? 2),
  retryAttempts: Number(embedding.retryAttempts ?? 2),
});
const started = Date.now();
const vectors = await service.embedBatch(["UmaAgent isolated embedding smoke", "UmaAgent trace diagnostics"]);
const dimensions = [...new Set(vectors.map((vector) => vector?.length ?? 0))];
if (vectors.length !== 2 || vectors.some((vector) => !vector))
  throw new Error("Embedding provider returned incomplete vectors");
console.log(
  JSON.stringify({
    ok: true,
    count: vectors.length,
    dimensions,
    elapsedMs: Date.now() - started,
    model: service.model,
  }),
);
