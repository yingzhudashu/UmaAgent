import Value from "typebox/value";
import { describe, expect, it } from "vitest";
import {
  AGENT_SHORTCUT_COMMANDS,
  AgentEventEnvelopeSchema,
  CreateScheduledTaskRequestSchema,
  CreateSessionRequestSchema,
  RunActionDecisionSchema,
  SendMessageRequestSchema,
  ShortcutRequestSchema,
  TraceSpanSchema,
} from "../src/index.js";

describe("protocol schemas", () => {
  it("validates shortcut requests and exposes the canonical command set", () => {
    expect(AGENT_SHORTCUT_COMMANDS).toContain("/self-opt proposals");
    expect(Value.Check(ShortcutRequestSchema, { command: "/status" })).toBe(true);
    expect(Value.Check(ShortcutRequestSchema, { command: "" })).toBe(false);
    expect(Value.Check(ShortcutRequestSchema, { command: "/status", extra: true })).toBe(false);
  });
  it("accepts strict message requests", () => {
    expect(Value.Check(SendMessageRequestSchema, { messageId: "m1", text: "hello", mode: "agent" })).toBe(
      true,
    );
    expect(Value.Check(SendMessageRequestSchema, { messageId: "m1", text: "hello", mode: "legacy" })).toBe(
      false,
    );
    expect(Value.Check(SendMessageRequestSchema, { messageId: "m1", text: "hello", unknown: true })).toBe(
      false,
    );
  });

  it("accepts an empty create-session request", () => {
    expect(Value.Check(CreateSessionRequestSchema, {})).toBe(true);
  });

  it("rejects events with the wrong protocol version", () => {
    expect(
      Value.Check(AgentEventEnvelopeSchema, {
        protocolVersion: 4,
        sessionId: "s",
        sequence: 1,
        timestamp: 1,
        type: "server.status",
        payload: {},
      }),
    ).toBe(false);
  });

  it("validates bounded trace spans", () => {
    expect(
      Value.Check(TraceSpanSchema, {
        traceId: "trace",
        spanId: "span",
        runId: "run",
        sessionId: "session",
        name: "model",
        kind: "model",
        status: "ok",
        startedAt: 1,
        durationMs: 2,
        attributes: { provider: "test" },
        endedAt: 3,
      }),
    ).toBe(true);
    expect(
      Value.Check(TraceSpanSchema, {
        traceId: "trace",
        spanId: "span",
        runId: "run",
        sessionId: "session",
        name: "model",
        kind: "model",
        status: "ok",
        startedAt: 1,
        durationMs: 2,
        attributes: { prompt: "secret" },
        endedAt: 3,
        extra: true,
      }),
    ).toBe(false);
  });

  it("accepts only the v7 Action decisions", () => {
    for (const decision of ["approve", "reject", "acknowledge"])
      expect(Value.Check(RunActionDecisionSchema, { decision })).toBe(true);
    expect(Value.Check(RunActionDecisionSchema, { decision: "confirm" })).toBe(false);
    expect(Value.Check(RunActionDecisionSchema, { decision: "approve", extra: true })).toBe(false);
  });

  it("validates persistent schedule definitions", () => {
    expect(
      Value.Check(CreateScheduledTaskRequestSchema, {
        name: "daily",
        prompt: "summarize",
        schedule: { kind: "cron", expression: "0 9 * * *", timezone: "Asia/Shanghai" },
      }),
    ).toBe(true);
    expect(
      Value.Check(CreateScheduledTaskRequestSchema, {
        name: "too-fast",
        prompt: "run",
        schedule: { kind: "interval", everyMs: 1000 },
      }),
    ).toBe(false);
  });
});
