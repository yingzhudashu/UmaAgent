import { createHash } from "node:crypto";
import type { RunAction } from "@uma-agent/protocol";

export type ToolLoopDecision = {
  level: "warning" | "critical";
  pattern: "repeat" | "no_progress" | "ping_pong";
  count: number;
  signature: string;
  message: string;
};

type ToolRecord = {
  idempotencyKey: string;
  signature: string;
  result?: string;
};

function normalized(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalized);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, normalized(item)]),
    );
  return value;
}

function digest(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(normalized(value)))
    .digest("hex")
    .slice(0, 24);
}

export class ToolLoopGuard {
  private readonly records: ToolRecord[] = [];
  private readonly keys = new Set<string>();

  constructor(actions: RunAction[] = []) {
    for (const action of actions) this.restore(action);
  }

  check(toolName: string, args: unknown, idempotencyKey: string): ToolLoopDecision | undefined {
    if (this.keys.has(idempotencyKey)) return undefined;
    const signature = `${toolName}:${digest(args)}`;
    this.keys.add(idempotencyKey);
    this.records.push({ idempotencyKey, signature });
    if (this.records.length > 64) this.records.shift();

    const repeatCount = this.records.filter((item) => item.signature === signature).length;
    if (repeatCount >= 6)
      return {
        level: "critical",
        pattern: "repeat",
        count: repeatCount,
        signature,
        message: `Tool call ${toolName} repeated ${repeatCount} times with the same input.`,
      };

    const completed = this.records.filter((item) => item.signature === signature && item.result);
    const recentResults = completed.slice(-3).map((item) => item.result);
    if (recentResults.length === 3 && new Set(recentResults).size === 1)
      return {
        level: "warning",
        pattern: "no_progress",
        count: 3,
        signature,
        message: `Tool call ${toolName} produced the same result three times. Change strategy before retrying.`,
      };

    const recent = this.records.slice(-10).map((item) => item.signature);
    if (
      recent.length >= 10 &&
      recent.every((item, index) => item === recent[index % 2]) &&
      recent[0] !== recent[1]
    )
      return {
        level: "critical",
        pattern: "ping_pong",
        count: 5,
        signature,
        message: "Alternating tool calls repeated for five cycles without convergence.",
      };
    if (recent.length >= 6) {
      const last = recent.slice(-6);
      if (last.every((item, index) => item === last[index % 2]) && last[0] !== last[1])
        return {
          level: "warning",
          pattern: "ping_pong",
          count: 3,
          signature,
          message: "Alternating tool calls repeated for three cycles. Change strategy.",
        };
    }
    if (repeatCount === 3)
      return {
        level: "warning",
        pattern: "repeat",
        count: repeatCount,
        signature,
        message: `Tool call ${toolName} repeated three times with the same input. Change strategy.`,
      };
    return undefined;
  }

  recordResult(idempotencyKey: string, result: unknown): void {
    const record = this.records.findLast((item) => item.idempotencyKey === idempotencyKey);
    if (record) record.result = digest(result);
  }

  private restore(action: RunAction): void {
    if (this.keys.has(action.idempotencyKey)) return;
    this.keys.add(action.idempotencyKey);
    this.records.push({
      idempotencyKey: action.idempotencyKey,
      signature: `${action.toolName}:${digest(action.input)}`,
      ...(action.result === undefined ? {} : { result: digest(action.result) }),
    });
  }
}
