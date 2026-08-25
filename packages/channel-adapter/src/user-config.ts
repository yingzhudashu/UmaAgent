import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

export interface UserConfig {
  version: 1;
  core: { serverUrl: string; token: string };
  feishu?: {
    appId: string;
    appSecret: string;
    verificationToken?: string;
    encryptKey?: string;
    allowedOpenIds: string[];
    host: string;
    port: number;
    stateDir: string;
    maxAttachmentBytes: number;
    mcpHost: string;
    mcpPort: number;
  };
  xianyu?: {
    cookie: string;
    controlToken: string;
    host: string;
    port: number;
    stateDir: string;
  };
}

type RecordValue = Record<string, unknown>;

function record(value: unknown, label: string): RecordValue {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${label} must be an object`);
  return value as RecordValue;
}

function keys(value: RecordValue, allowed: string[], label: string): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new Error(`${label} has unknown fields: ${unknown.join(", ")}`);
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "")
    throw new Error(`${label} must be a non-empty string`);
  return value.trim();
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  return stringValue(value, label);
}

function port(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 65_535)
    throw new Error(`${label} must be a valid TCP port`);
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
    throw new Error(`${label} must be a positive integer`);
  return value;
}

function expandPath(value: string, label: string): string {
  const expanded = value.replace(
    /%([A-Za-z_][A-Za-z0-9_]*)%|\$([A-Za-z_][A-Za-z0-9_]*)/g,
    (_, windows, unix) => {
      const name = windows ?? unix;
      const result = process.env[name];
      if (!result) throw new Error(`${label} references missing environment variable ${name}`);
      return result;
    },
  );
  return isAbsolute(expanded) ? resolve(expanded) : resolve(expanded);
}

function parse(value: unknown): UserConfig {
  const root = record(value, "user config");
  keys(root, ["version", "core", "feishu", "xianyu"], "user config");
  if (root.version !== 1) throw new Error("user config.version must be 1");
  const core = record(root.core, "user config.core");
  keys(core, ["serverUrl", "token"], "user config.core");
  const result: UserConfig = {
    version: 1,
    core: {
      serverUrl: stringValue(core.serverUrl, "user config.core.serverUrl"),
      token: stringValue(core.token, "user config.core.token"),
    },
  };
  if (root.feishu !== undefined) {
    const feishu = record(root.feishu, "user config.feishu");
    keys(
      feishu,
      [
        "appId",
        "appSecret",
        "verificationToken",
        "encryptKey",
        "allowedOpenIds",
        "host",
        "port",
        "stateDir",
        "maxAttachmentBytes",
        "mcpHost",
        "mcpPort",
      ],
      "user config.feishu",
    );
    if (
      !Array.isArray(feishu.allowedOpenIds) ||
      feishu.allowedOpenIds.length === 0 ||
      feishu.allowedOpenIds.some((item) => typeof item !== "string" || item.trim() === "")
    )
      throw new Error("user config.feishu.allowedOpenIds must contain at least one Open ID");
    const verificationToken = optionalString(
      feishu.verificationToken,
      "user config.feishu.verificationToken",
    );
    const encryptKey = optionalString(feishu.encryptKey, "user config.feishu.encryptKey");
    result.feishu = {
      appId: stringValue(feishu.appId, "user config.feishu.appId"),
      appSecret: stringValue(feishu.appSecret, "user config.feishu.appSecret"),
      ...(verificationToken ? { verificationToken } : {}),
      ...(encryptKey ? { encryptKey } : {}),
      allowedOpenIds: feishu.allowedOpenIds.map((item) => String(item).trim()),
      host: stringValue(feishu.host, "user config.feishu.host"),
      port: port(feishu.port, "user config.feishu.port"),
      stateDir: expandPath(
        stringValue(feishu.stateDir, "user config.feishu.stateDir"),
        "user config.feishu.stateDir",
      ),
      maxAttachmentBytes: positiveInteger(feishu.maxAttachmentBytes, "user config.feishu.maxAttachmentBytes"),
      mcpHost: stringValue(feishu.mcpHost ?? "127.0.0.1", "user config.feishu.mcpHost"),
      mcpPort: port(feishu.mcpPort ?? 3240, "user config.feishu.mcpPort"),
    };
  }
  if (root.xianyu !== undefined) {
    const xianyu = record(root.xianyu, "user config.xianyu");
    keys(xianyu, ["cookie", "controlToken", "host", "port", "stateDir"], "user config.xianyu");
    result.xianyu = {
      cookie: stringValue(xianyu.cookie, "user config.xianyu.cookie"),
      controlToken: stringValue(xianyu.controlToken, "user config.xianyu.controlToken"),
      host: stringValue(xianyu.host, "user config.xianyu.host"),
      port: port(xianyu.port, "user config.xianyu.port"),
      stateDir: expandPath(
        stringValue(xianyu.stateDir, "user config.xianyu.stateDir"),
        "user config.xianyu.stateDir",
      ),
    };
  }
  if (!result.feishu && !result.xianyu) throw new Error("user config must define feishu or xianyu");
  return result;
}

export async function loadUserConfig(
  path: string,
  channel: "feishu" | "xianyu",
): Promise<UserConfig & Required<Pick<UserConfig, typeof channel>>> {
  const absolute = resolve(path);
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(absolute, "utf8"));
  } catch (error) {
    throw new Error(
      `Cannot read user config ${absolute}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const config = parse(parsed);
  if (!config[channel]) throw new Error(`user config.${channel} is required`);
  return config as UserConfig & Required<Pick<UserConfig, typeof channel>>;
}
