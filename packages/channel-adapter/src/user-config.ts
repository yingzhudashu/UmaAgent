import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

export interface UserConfig {
  version: 1;
  core: { serverUrl: string; token: string };
  xianyu: {
    cookie: string;
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

function port(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 65_535)
    throw new Error(`${label} must be a valid TCP port`);
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
  keys(root, ["version", "core", "xianyu"], "user config");
  if (root.version !== 1) throw new Error("user config.version must be 1");
  const core = record(root.core, "user config.core");
  keys(core, ["serverUrl", "token"], "user config.core");
  const result = {
    version: 1,
    core: {
      serverUrl: stringValue(core.serverUrl, "user config.core.serverUrl"),
      token: stringValue(core.token, "user config.core.token"),
    },
  } as UserConfig;
  const xianyu = record(root.xianyu, "user config.xianyu");
  keys(xianyu, ["cookie", "host", "port", "stateDir"], "user config.xianyu");
  result.xianyu = {
    cookie: stringValue(xianyu.cookie, "user config.xianyu.cookie"),
    host: stringValue(xianyu.host, "user config.xianyu.host"),
    port: port(xianyu.port, "user config.xianyu.port"),
    stateDir: expandPath(
      stringValue(xianyu.stateDir, "user config.xianyu.stateDir"),
      "user config.xianyu.stateDir",
    ),
  };
  return result;
}

export async function loadUserConfig(path: string): Promise<UserConfig> {
  const absolute = resolve(path);
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(absolute, "utf8"));
  } catch (error) {
    throw new Error(
      `Cannot read user config ${absolute}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return parse(parsed);
}
