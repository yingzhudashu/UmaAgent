import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

/**
 * 只检查 Provider 配置和认证状态，不发送模型请求，也不产生模型调用费用。
 * 运行时必须显式指定实际环境的 env-file，例如：
 * node --env-file=D:\\AIhub\\UmaAgent\\.env scripts/diagnose-provider.mjs
 */
const configPath = process.env.UMA_PROVIDER_CONFIG?.trim() || "uma.config.json";
let config;
try {
  config = JSON.parse(await readFile(resolve(configPath), "utf8"));
} catch (error) {
  throw new Error(
    `无法读取或解析 UmaAgent 配置 ${resolve(configPath)}：${error instanceof Error ? error.message : String(error)}`,
  );
}
const modelRef = config.roles?.default ?? config.defaultModel ?? {};
const modelId = process.env.UMA_PROVIDER_MODEL?.trim() || modelRef.id || Object.keys(config.models ?? {})[0];
const model = config.models?.[modelId] ?? {};
const providerId = process.env.UMA_PROVIDER_ID?.trim() || model.provider || modelRef.provider;
const provider = config.providers?.[providerId] ?? {};
const configuredBaseUrl = process.env.UMA_PROVIDER_BASE_URL?.trim() || provider.baseUrl || "";
let baseUrl;
try {
  const parsedBaseUrl = new URL(configuredBaseUrl);
  if (
    !["http:", "https:"].includes(parsedBaseUrl.protocol) ||
    parsedBaseUrl.username ||
    parsedBaseUrl.password
  )
    throw new Error("Provider URL 必须是无凭据的 HTTP(S) 地址");
  baseUrl = parsedBaseUrl.toString().replace(/\/$/, "");
} catch {
  throw new Error("Provider URL 必须是无凭据的 HTTP(S) 地址");
}
const apiKeyEnv = process.env.UMA_PROVIDER_API_KEY_ENV?.trim() || provider.apiKeyEnv || "OPENAI_API_KEY";
const api = process.env.UMA_PROVIDER_API?.trim() || model.api || "openai-completions";
const key = process.env[apiKeyEnv]?.trim() || "";
if (!providerId || !modelId || !baseUrl) throw new Error("Provider 配置不完整");

const result = {
  provider: providerId,
  model: modelId,
  api,
  endpoint: baseUrl,
  apiKeyEnv,
  keyConfigured: Boolean(key),
  ...(key
    ? {
        keyLength: key.length,
        keyFingerprint: createHash("sha256").update(key).digest("hex").slice(0, 12),
      }
    : {}),
};
if (!key) {
  console.log(JSON.stringify({ ...result, status: "missing_key" }));
  process.exitCode = 2;
} else {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(`${baseUrl}/models`, {
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${key}`,
        accept: "application/json",
        "user-agent": "UmaAgent/1.0",
      },
    });
    const body = await response.text();
    const status = response.ok
      ? "ok"
      : response.status === 401 || response.status === 403
        ? "auth_rejected"
        : "http_error";
    console.log(
      JSON.stringify({ ...result, status, httpStatus: response.status, responseBytes: body.length }),
    );
    if (!response.ok) process.exitCode = 1;
  } catch (error) {
    console.log(
      JSON.stringify({
        ...result,
        status: error instanceof Error && error.name === "AbortError" ? "timeout" : "network_error",
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    process.exitCode = 1;
  } finally {
    clearTimeout(timer);
  }
}
