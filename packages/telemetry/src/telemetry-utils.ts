import { randomBytes } from "node:crypto";
import type { SpanAttributes } from "@earendil-works/pi-telemetry";
import type { TraceParent } from "./telemetry-contract.js";

const REDACTED = "[REDACTED]";
const sensitive =
  /(authorization|cookie|api[_-]?key|password|secret|token|prompt|completion|body|arguments|parameters|payload)/i;
const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/i;
// 错误文本中的结构化敏感值可能嵌套、换行或被截断；从敏感值起点截断，避免尾部泄露。
const errorSecretPatterns = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi,
  /(\bcookie\s*:\s*)[^;\r\n]+/gi,
  /((?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|token|prompt|completion|request[_-]?body|body)\s*[:=]\s*)(?:"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|\{[\s\S]*|\[(?!REDACTED(?:_URL)?\])[\s\S]*|[^\s,;&}]+)/gi,
  /(["']?(?:authorization|cookie|api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|token|prompt|completion|body)["']?\s*:\s*)(?:"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|\{[\s\S]*|\[(?!REDACTED(?:_URL)?\])[\s\S]*|[^\s,;&}]+)/gi,
  /([?&](?:api[_-]?key|access[_-]?token|password|secret|token)=)[^&#\s]*/gi,
  /\b(?:sk-[A-Za-z0-9][A-Za-z0-9_-]{9,}|ghp_[A-Za-z0-9]{10,}|github_pat_[A-Za-z0-9_]{10,}|xox[baprs]-[A-Za-z0-9-]{10,})\b/g,
  /\buma_pat_[A-Za-z0-9_-]+\b/g,
];

export function redactErrorMessage(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  let redacted = value.replace(/https?:\/\/[^\s<>"']+/gi, "[REDACTED_URL]");
  for (const pattern of errorSecretPatterns)
    redacted = redacted.replace(pattern, (...matches: unknown[]) => {
      const prefix = typeof matches[1] === "string" ? matches[1] : "";
      return `${prefix}${REDACTED}`;
    });
  return redacted.slice(0, 2_000);
}

export function parseTraceparent(value: string | undefined): TraceParent | undefined {
  if (!value) return undefined;
  const match = TRACEPARENT.exec(value.trim());
  if (!match || /^0+$/.test(match[1] as string) || /^0+$/.test(match[2] as string)) return undefined;
  return {
    traceId: (match[1] as string).toLowerCase(),
    spanId: (match[2] as string).toLowerCase(),
    traceFlags: Number.parseInt(match[3] as string, 16),
  };
}

export function formatTraceparent(parent: TraceParent): string {
  const normalized = parseTraceparent(
    `00-${parent.traceId}-${parent.spanId}-${parent.traceFlags.toString(16).padStart(2, "0")}`,
  );
  if (!normalized) throw new Error("Invalid W3C trace context");
  return `00-${normalized.traceId}-${normalized.spanId}-${normalized.traceFlags.toString(16).padStart(2, "0")}`;
}

export function traceId(): string {
  return randomBytes(16).toString("hex");
}

export function spanId(): string {
  return randomBytes(8).toString("hex");
}

export function telemetryDirectory(defaultDirectory: string): string {
  return process.env.UMA_TELEMETRY_DIR?.trim() || defaultDirectory;
}

export function safeAttributes(
  attributes: SpanAttributes | undefined,
): Record<string, string | number | boolean> {
  const result: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(attributes ?? {}).slice(0, 32)) {
    if (!/^[a-zA-Z0-9_.-]{1,80}$/.test(key) || value === undefined) continue;
    if (sensitive.test(key)) result[key] = REDACTED;
    else if (typeof value === "string") result[key] = (redactErrorMessage(value) ?? "").slice(0, 200);
    else if (typeof value === "number" && Number.isFinite(value)) result[key] = value;
    else if (typeof value === "boolean") result[key] = value;
  }
  return result;
}
