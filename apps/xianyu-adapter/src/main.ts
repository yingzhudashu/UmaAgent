import { UmaClient } from "@uma-agent/client";
import { createXianyuAdapter, type XianyuTransport } from "./adapter.js";

// The transport is intentionally injected by the deployment-specific connector.
// No undocumented Xianyu protocol or credentials are assumed here.
export function createConfiguredXianyuAdapter(transport: XianyuTransport) {
  const client = new UmaClient({
    baseUrl: process.env.UMA_SERVER_URL ?? "http://127.0.0.1:3210",
    ...(process.env.UMA_TOKEN ? { token: process.env.UMA_TOKEN } : {}),
  });
  const sessions = new Map<string, string>();
  return createXianyuAdapter({
    transport,
    core: {
      mapConversation: async (conversation) => {
        const key = `${conversation.tenantId}:${conversation.conversationId}:${conversation.threadId ?? ""}`;
        const existing = sessions.get(key);
        if (existing) return existing;
        const session = await client.createSession({ title: `Xianyu ${conversation.conversationId}` });
        sessions.set(key, session.id);
        return session.id;
      },
      sendMessage: async (sessionId, text, source) => {
        if (!source) throw new Error("Xianyu message source is required");
        await client.sendMessage(sessionId, text, { mode: "agent", source });
      },
    },
  });
}
