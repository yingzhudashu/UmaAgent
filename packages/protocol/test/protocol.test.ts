import Value from "typebox/value";
import { describe, expect, it } from "vitest";
import {
  AgentEventEnvelopeSchema,
  CreateScheduledTaskRequestSchema,
  CreateSessionRequestSchema,
  RunActionDecisionSchema,
  SendMessageRequestSchema,
} from "../src/index.js";

describe("protocol schemas", () => {
  it("accepts strict message requests", () => {
    expect(Value.Check(SendMessageRequestSchema, { messageId: "m1", text: "hello", mode: "ask" })).toBe(true);
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
