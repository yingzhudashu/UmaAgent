import Value from "typebox/value";
import { describe, expect, it } from "vitest";
import {
  AgentEventEnvelopeSchema,
  CreateSessionRequestSchema,
  SendMessageRequestSchema,
} from "../src/index.js";

describe("protocol schemas", () => {
  it("accepts strict message requests", () => {
    expect(Value.Check(SendMessageRequestSchema, { messageId: "m1", text: "hello" })).toBe(true);
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
        protocolVersion: 2,
        sessionId: "s",
        sequence: 1,
        timestamp: 1,
        type: "server.status",
        payload: {},
      }),
    ).toBe(false);
  });
});
