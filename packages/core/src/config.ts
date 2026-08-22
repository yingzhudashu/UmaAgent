import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import type { McpServerConfig, UmaConfig, UmaModelConfig } from "./types.js";

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "")
    throw new Error(`${label} must be a non-empty string`);
  return value;
}

function numberValue(value: unknown, label: string, fallback?: number): number {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0)
    throw new Error(`${label} must be positive`);
  return value;
}

function stringArray(value: unknown, label: string, fallback: string[] = []): string[] {
  if (value === undefined) return fallback;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string"))
    throw new Error(`${label} must be a string array`);
  return value as string[];
}

function httpUrl(value: unknown, label: string): string {
  const text = stringValue(value, label);
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    throw new Error(`${label} must be a valid HTTP(S) URL`);
  }
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.username || parsed.password)
    throw new Error(`${label} must be a valid HTTP(S) URL without credentials`);
  return text.replace(/\/$/, "");
}

function webOrigins(value: unknown): string[] {
  const values = stringArray(value, "server.webOrigins");
  const unique = new Set<string>();
  for (const origin of values) {
    const parsed = new URL(httpUrl(origin, "server.webOrigins entry"));
    if (origin !== parsed.origin)
      throw new Error("server.webOrigins entries must be exact origins without paths");
    unique.add(origin);
  }
  return [...unique];
}

function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
}

function assertKeys(value: Record<string, unknown>, allowed: string[], label: string): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new Error(`${label} has unknown fields: ${unknown.join(", ")}`);
}

function resultModelRef(value: unknown, label: string): { provider: string; id: string } {
  const source = record(value, label);
  return {
    provider: stringValue(source.provider, `${label}.provider`),
    id: stringValue(source.id, `${label}.id`),
  };
}

function parseModel(
  value: unknown,
  id: string,
  index: number,
  providerId: string,
  provider: Record<string, unknown>,
): UmaModelConfig {
  const item = record(value, `models[${index}]`);
  assertKeys(
    item,
    ["provider", "name", "api", "contextWindow", "maxOutputTokens", "capabilities"],
    `models[${index}]`,
  );
  const api = stringValue(item.api, `models[${index}].api`);
  if (!["openai-responses", "openai-completions", "anthropic-messages", "google-generative-ai"].includes(api))
    throw new Error(`Unsupported model API: ${api}`);
  const capabilities = record(item.capabilities ?? {}, `models.${id}.capabilities`);
  return {
    provider: providerId,
    id,
    name: stringValue(item.name ?? id, `models.${id}.name`),
    api: api as UmaModelConfig["api"],
    baseUrl: httpUrl(provider.baseUrl ?? "https://api.openai.com/v1", `providers.${id}.baseUrl`),
    apiKeyEnv: stringValue(provider.apiKeyEnv, `providers.${id}.apiKeyEnv`),
    reasoning: capabilities.reasoning === true,
    tools: capabilities.tools !== false,
    vision: capabilities.vision === true,
    structuredOutput: capabilities.structuredOutput === true,
    contextWindow: numberValue(item.contextWindow, `models.${id}.contextWindow`),
    maxTokens: numberValue(item.maxOutputTokens, `models.${id}.maxOutputTokens`),
  };
}

function parseMcp(value: unknown, index: number): McpServerConfig {
  const item = record(value, `mcpServers[${index}]`);
  assertKeys(
    item,
    ["name", "transport", "command", "args", "url", "authTokenEnv", "env"],
    `mcpServers[${index}]`,
  );
  const transport = stringValue(item.transport, `mcpServers[${index}].transport`);
  if (transport !== "stdio" && transport !== "http")
    throw new Error(`Unsupported MCP transport: ${transport}`);
  const result: McpServerConfig = { name: stringValue(item.name, `mcpServers[${index}].name`), transport };
  if (item.command !== undefined) result.command = stringValue(item.command, `mcpServers[${index}].command`);
  if (item.args !== undefined) result.args = stringArray(item.args, `mcpServers[${index}].args`);
  if (item.url !== undefined) result.url = stringValue(item.url, `mcpServers[${index}].url`);
  if (item.authTokenEnv !== undefined)
    result.authTokenEnv = stringValue(item.authTokenEnv, `mcpServers[${index}].authTokenEnv`);
  if (item.env !== undefined)
    result.env = record(item.env, `mcpServers[${index}].env`) as Record<string, string>;
  if (transport === "stdio" && !result.command) throw new Error(`mcpServers[${index}].command is required`);
  if (transport === "http" && !result.url) throw new Error(`mcpServers[${index}].url is required`);
  if (transport === "http" && result.url) {
    const host = new URL(result.url).hostname;
    if (!isLoopbackHost(host) && !result.authTokenEnv)
      throw new Error(`mcpServers[${index}].authTokenEnv is required for non-loopback HTTP MCP`);
    if (result.authTokenEnv && !process.env[result.authTokenEnv]?.trim())
      throw new Error(`Missing MCP auth token: ${result.authTokenEnv}`);
  }
  return result;
}

export async function loadConfig(path = "uma.config.json"): Promise<UmaConfig> {
  const absolute = resolve(path);
  const root = record(JSON.parse(await readFile(absolute, "utf8")), "config");
  assertKeys(
    root,
    [
      "server",
      "auth",
      "providers",
      "models",
      "defaultThinkingLevel",
      "skillsDirs",
      "mcpServers",
      "runtime",
      "roles",
    ],
    "config",
  );
  const server = record(root.server, "server");
  const auth = record(root.auth, "auth");
  const providers = record(root.providers, "providers");
  const modelProfiles = record(root.models, "models");
  const runtime = record(root.runtime ?? {}, "runtime");
  const roles = record(root.roles, "roles");
  const models = Object.entries(modelProfiles).map(([id, value], index) => {
    const item = record(value, `models.${id}`);
    const providerId = stringValue(item.provider, `models.${id}.provider`);
    const provider = record(providers[providerId], `providers.${providerId}`);
    return parseModel(item, id, index, providerId, provider);
  });
  if (models.length === 0) throw new Error("At least one model is required");
  const configDir = resolve(absolute, "..");
  const resolvePath = (value: string) => (isAbsolute(value) ? resolve(value) : resolve(configDir, value));
  const workspaceRoots = stringArray(server.workspaceRoots, "server.workspaceRoots").map(resolvePath);
  if (workspaceRoots.length === 0) throw new Error("server.workspaceRoots must not be empty");
  const thinking = typeof root.defaultThinkingLevel === "string" ? root.defaultThinkingLevel : "medium";
  if (!new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]).has(thinking))
    throw new Error("Invalid defaultThinkingLevel");
  const host = typeof server.host === "string" ? stringValue(server.host, "server.host") : "127.0.0.1";
  const allowedWebOrigins = webOrigins(server.webOrigins);
  const defaultRole = resultModelRef(roles.default, "roles.default");
  const result: UmaConfig = {
    server: {
      host,
      port: numberValue(server.port, "server.port", 3210),
      stateDir: resolvePath(stringValue(server.stateDir ?? ".uma", "server.stateDir")),
      workspaceRoots,
      webOrigins: allowedWebOrigins,
      maxUploadBytes: numberValue(server.maxUploadBytes, "server.maxUploadBytes", 20 * 1024 * 1024),
    },
    auth: {
      webSessionHours: numberValue(auth.webSessionHours, "auth.webSessionHours", 168),
    },
    models,
    defaultModel: defaultRole,
    defaultThinkingLevel: (typeof root.defaultThinkingLevel === "string"
      ? root.defaultThinkingLevel
      : "medium") as UmaConfig["defaultThinkingLevel"],
    skillsDirs: stringArray(root.skillsDirs, "skillsDirs").map(resolvePath),
    mcpServers: Array.isArray(root.mcpServers) ? root.mcpServers.map(parseMcp) : [],
    runtime: {
      maxParallelSessions: numberValue(runtime.maxParallelSessions, "runtime.maxParallelSessions", 4),
      approvalTimeoutMs: numberValue(runtime.approvalTimeoutMs, "runtime.approvalTimeoutMs", 120_000),
      toolTimeoutMs: numberValue(runtime.toolTimeoutMs, "runtime.toolTimeoutMs", 60_000),
    },
    roles: {
      default: defaultRole,
      reasoning: resultModelRef(roles.reasoning, "roles.reasoning"),
      fast: resultModelRef(roles.fast, "roles.fast"),
      vision: resultModelRef(roles.vision, "roles.vision"),
    },
  };
  if (
    !models.some(
      (model) => model.provider === result.defaultModel.provider && model.id === result.defaultModel.id,
    )
  ) {
    throw new Error("defaultModel is not present in models");
  }
  for (const [role, model] of Object.entries(result.roles)) {
    if (!models.some((entry) => entry.provider === model.provider && entry.id === model.id))
      throw new Error(`Role ${role} references an unknown model`);
  }
  for (const model of result.models) {
    if (!process.env[model.apiKeyEnv]?.trim()) throw new Error(`Missing model API key: ${model.apiKeyEnv}`);
  }
  if (!isLoopbackHost(host) && allowedWebOrigins.length === 0)
    throw new Error("Public server hosts require at least one server.webOrigins entry");
  return result;
}
