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

function assertKeys(value: Record<string, unknown>, allowed: string[], label: string): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new Error(`${label} has unknown fields: ${unknown.join(", ")}`);
}

function parseModel(value: unknown, index: number): UmaModelConfig {
  const item = record(value, `models[${index}]`);
  assertKeys(
    item,
    ["provider", "id", "name", "api", "baseUrl", "apiKeyEnv", "reasoning", "contextWindow", "maxTokens"],
    `models[${index}]`,
  );
  const api = stringValue(item.api, `models[${index}].api`);
  if (api !== "openai-responses" && api !== "openai-completions")
    throw new Error(`Unsupported model API: ${api}`);
  return {
    provider: stringValue(item.provider, `models[${index}].provider`),
    id: stringValue(item.id, `models[${index}].id`),
    name: stringValue(item.name, `models[${index}].name`),
    api,
    baseUrl: stringValue(item.baseUrl, `models[${index}].baseUrl`),
    apiKeyEnv: stringValue(item.apiKeyEnv, `models[${index}].apiKeyEnv`),
    reasoning: item.reasoning === true,
    contextWindow: numberValue(item.contextWindow, `models[${index}].contextWindow`),
    maxTokens: numberValue(item.maxTokens, `models[${index}].maxTokens`),
  };
}

function parseMcp(value: unknown, index: number): McpServerConfig {
  const item = record(value, `mcpServers[${index}]`);
  assertKeys(item, ["name", "transport", "command", "args", "url", "env"], `mcpServers[${index}]`);
  const transport = stringValue(item.transport, `mcpServers[${index}].transport`);
  if (transport !== "stdio" && transport !== "http")
    throw new Error(`Unsupported MCP transport: ${transport}`);
  const result: McpServerConfig = { name: stringValue(item.name, `mcpServers[${index}].name`), transport };
  if (item.command !== undefined) result.command = stringValue(item.command, `mcpServers[${index}].command`);
  if (item.args !== undefined) result.args = stringArray(item.args, `mcpServers[${index}].args`);
  if (item.url !== undefined) result.url = stringValue(item.url, `mcpServers[${index}].url`);
  if (item.env !== undefined)
    result.env = record(item.env, `mcpServers[${index}].env`) as Record<string, string>;
  if (transport === "stdio" && !result.command) throw new Error(`mcpServers[${index}].command is required`);
  if (transport === "http" && !result.url) throw new Error(`mcpServers[${index}].url is required`);
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
      "models",
      "defaultModel",
      "defaultThinkingLevel",
      "skillsDirs",
      "mcpServers",
      "runtime",
    ],
    "config",
  );
  const server = record(root.server, "server");
  const auth = record(root.auth, "auth");
  const defaultModel = record(root.defaultModel, "defaultModel");
  const runtime = record(root.runtime ?? {}, "runtime");
  const models = Array.isArray(root.models) ? root.models.map(parseModel) : [];
  if (models.length === 0) throw new Error("At least one model is required");
  const configDir = resolve(absolute, "..");
  const resolvePath = (value: string) => (isAbsolute(value) ? resolve(value) : resolve(configDir, value));
  const workspaceRoots = stringArray(server.workspaceRoots, "server.workspaceRoots").map(resolvePath);
  if (workspaceRoots.length === 0) throw new Error("server.workspaceRoots must not be empty");
  const thinking = typeof root.defaultThinkingLevel === "string" ? root.defaultThinkingLevel : "medium";
  if (!new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]).has(thinking))
    throw new Error("Invalid defaultThinkingLevel");
  const result: UmaConfig = {
    server: {
      host: typeof server.host === "string" ? server.host : "127.0.0.1",
      port: numberValue(server.port, "server.port", 3210),
      stateDir: resolvePath(stringValue(server.stateDir ?? ".uma", "server.stateDir")),
      workspaceRoots,
      webOrigins: stringArray(server.webOrigins, "server.webOrigins"),
      maxUploadBytes: numberValue(server.maxUploadBytes, "server.maxUploadBytes", 20 * 1024 * 1024),
    },
    auth: {
      tokenEnv: typeof auth.tokenEnv === "string" ? auth.tokenEnv : "UMA_AUTH_TOKEN",
      webSessionHours: numberValue(auth.webSessionHours, "auth.webSessionHours", 168),
    },
    models,
    defaultModel: {
      provider: stringValue(defaultModel.provider, "defaultModel.provider"),
      id: stringValue(defaultModel.id, "defaultModel.id"),
    },
    defaultThinkingLevel: thinking as UmaConfig["defaultThinkingLevel"],
    skillsDirs: stringArray(root.skillsDirs, "skillsDirs").map(resolvePath),
    mcpServers: Array.isArray(root.mcpServers) ? root.mcpServers.map(parseMcp) : [],
    runtime: {
      maxParallelSessions: numberValue(runtime.maxParallelSessions, "runtime.maxParallelSessions", 4),
      approvalTimeoutMs: numberValue(runtime.approvalTimeoutMs, "runtime.approvalTimeoutMs", 120_000),
      toolTimeoutMs: numberValue(runtime.toolTimeoutMs, "runtime.toolTimeoutMs", 60_000),
    },
  };
  if (
    !models.some(
      (model) => model.provider === result.defaultModel.provider && model.id === result.defaultModel.id,
    )
  ) {
    throw new Error("defaultModel is not present in models");
  }
  if (!process.env[result.auth.tokenEnv]) throw new Error(`Missing server token: ${result.auth.tokenEnv}`);
  return result;
}
