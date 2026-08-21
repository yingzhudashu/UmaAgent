import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { contentText } from "@earendil-works/pi-ai";
import Type from "typebox";
import Value from "typebox/value";
import type { PreflightDecision } from "./types.js";

export class Semaphore {
  private active = 0;
  private waiting: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async acquire(): Promise<() => void> {
    if (this.active >= this.limit) await new Promise<void>((resolve) => this.waiting.push(resolve));
    this.active++;
    return () => {
      this.active--;
      this.waiting.shift()?.();
    };
  }

  count(): number {
    return this.active;
  }
}

export type PendingApproval = { resolve: (approved: boolean) => void; timer: NodeJS.Timeout };

export function textFromMessage(message: AgentMessage): string {
  if (message.role === "assistant") return contentText(message.content);
  if (message.role === "user")
    return typeof message.content === "string"
      ? message.content
      : message.content
          .filter((item) => item.type === "text")
          .map((item) => item.text)
          .join("\n");
  if (message.role === "toolResult")
    return message.content
      .filter((item) => item.type === "text")
      .map((item) => item.text)
      .join("\n");
  return "";
}

export function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  return JSON.parse((fenced ?? text).trim());
}

export const TaskClassificationSchema = Type.Object(
  { taskClass: Type.Union([Type.Literal("simple"), Type.Literal("standard"), Type.Literal("complex")]) },
  { additionalProperties: false },
);

export const PreflightDecisionSchema = Type.Object(
  {
    taskClass: Type.Union([Type.Literal("simple"), Type.Literal("standard"), Type.Literal("complex")]),
    route: Type.Union([Type.Literal("direct"), Type.Literal("clarify"), Type.Literal("plan")]),
    goal: Type.String({ minLength: 1 }),
    reasoningSummary: Type.String(),
    successCriteria: Type.Array(Type.String({ minLength: 1 })),
    questions: Type.Array(Type.String({ minLength: 1 })),
    steps: Type.Array(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
);

export const VerificationSchema = Type.Object(
  { accepted: Type.Boolean(), feedback: Type.String() },
  { additionalProperties: false },
);

export const MemoryExtractionSchema = Type.Array(
  Type.Object(
    {
      key: Type.String({ minLength: 1 }),
      value: Type.String({ minLength: 1 }),
      category: Type.String({ minLength: 1 }),
      evidence: Type.Optional(Type.String()),
      confidence: Type.Number({ minimum: 0, maximum: 1 }),
      scope: Type.Union([Type.Literal("global"), Type.Literal("session")]),
    },
    { additionalProperties: false },
  ),
);

export function decisionFrom(value: unknown): PreflightDecision {
  if (!Value.Check(PreflightDecisionSchema, value)) throw new Error("Preflight response is invalid");
  return value;
}

export function isSecretLike(value: string): boolean {
  return /(api[_-]?key|bearer\s+|password|secret|token\s*[:=]|-----BEGIN)/i.test(value);
}

export function isTransientProviderError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /(429|rate.?limit|5\d\d|network|timeout|timed out|econn|fetch failed|socket hang up)/i.test(message);
}

export type RuntimeFaultPoint =
  | "preflight.completed"
  | "checkpoint.created"
  | "model.started"
  | "model.completed"
  | "tool.prepared"
  | "tool.started"
  | "tool.completed"
  | "verify.completed";

export function injectRuntimeFault(point: RuntimeFaultPoint): void {
  if (process.env.NODE_ENV !== "test" || process.env.UMA_TEST_FAULT_POINT !== point) return;
  const mode = process.env.UMA_TEST_FAULT_MODE;
  if (mode === "abort") process.abort();
  throw new Error(`Injected runtime fault: ${point}`);
}
