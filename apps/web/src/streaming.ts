import type { QueryClient } from "@tanstack/react-query";
import type { AgentEventEnvelope, MessageDelta, SessionSnapshot } from "@uma-agent/protocol";

export function applyStreamingEvent(
  queryClient: QueryClient,
  sessionId: string,
  event: AgentEventEnvelope,
): void {
  if (event.type !== "message.delta") return;
  const payload = event.payload as MessageDelta;
  if (typeof payload.messageId !== "string" || typeof payload.append !== "string") return;
  queryClient.setQueryData<SessionSnapshot>(["snapshot", sessionId], (current) => {
    if (!current) return current;
    return {
      ...current,
      transcript: current.transcript.map((item) =>
        item.id === payload.messageId
          ? { ...item, content: `${item.content}${payload.append}`, updatedAt: Date.now() }
          : item,
      ),
    };
  });
}
