import { type AgentEventEnvelope, PROTOCOL_VERSION } from "@uma-agent/protocol";

export function eventEnvelope(value: unknown): value is AgentEventEnvelope {
  if (!value || typeof value !== "object") return false;
  const event = value as Record<string, unknown>;
  if (
    event.protocolVersion !== PROTOCOL_VERSION ||
    typeof event.sessionId !== "string" ||
    typeof event.sequence !== "number" ||
    typeof event.timestamp !== "number" ||
    typeof event.type !== "string"
  )
    return false;
  if (event.type !== "message.delta") return event.sequence >= 1;
  const payload = event.payload as Record<string, unknown> | undefined;
  return (
    event.transient === true &&
    event.sequence === 0 &&
    Boolean(payload) &&
    typeof payload?.messageId === "string" &&
    typeof payload.append === "string" &&
    payload.append.length > 0 &&
    typeof payload.updatedAt === "number"
  );
}
