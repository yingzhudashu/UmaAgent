import type {
  AdapterHealth,
  ChannelInboundMessage,
  ExternalConversation,
  MessageSource,
} from "@uma-agent/protocol";

export interface XianyuTransport {
  start(onMessage: (message: ChannelInboundMessage) => Promise<void>): Promise<void>;
  stop(): Promise<void>;
  send(conversation: ExternalConversation, text: string): Promise<void>;
  connected(): boolean;
}

export interface XianyuCore {
  mapConversation(input: ExternalConversation): Promise<string>;
  sendMessage(sessionId: string, text: string, source?: MessageSource): Promise<void>;
}

/**
 * Protocol-neutral Xianyu adapter. A production transport must implement the
 * platform-specific session and message protocol; this layer owns lifecycle,
 * pause/resume state, forwarding, and diagnostics only.
 */
export function createXianyuAdapter(deps: { transport: XianyuTransport; core: XianyuCore }) {
  let started = false;
  let paused = false;
  let inbound = 0;
  let outbound = 0;
  let reconnects = 0;
  let lastError: string | undefined;
  let lastInboundAt: number | undefined;
  const handleInbound = async (message: ChannelInboundMessage) => {
    if (!started || paused) return;
    try {
      const sessionId = await deps.core.mapConversation(message.conversation);
      await deps.core.sendMessage(sessionId, message.text, {
        adapter: message.conversation.adapter,
        conversationId: message.conversation.conversationId,
        externalMessageId: message.externalMessageId,
        ...(message.senderId ? { senderId: message.senderId } : {}),
      });
      inbound += 1;
      lastInboundAt = Date.now();
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      throw error;
    }
  };
  return {
    async start() {
      if (started) return;
      await deps.transport.start(handleInbound);
      started = true;
    },
    async stop() {
      if (!started) return;
      await deps.transport.stop();
      started = false;
    },
    pause() {
      paused = true;
    },
    resume() {
      paused = false;
    },
    async send(conversation: ExternalConversation, text: string) {
      if (!started || paused) throw new Error("Xianyu adapter is paused or stopped");
      await deps.transport.send(conversation, text);
      outbound += 1;
    },
    reconnect() {
      reconnects += 1;
    },
    health(): AdapterHealth & { paused: boolean; inbound: number; outbound: number; reconnects: number } {
      return {
        status: started ? (lastError ? "degraded" : "ok") : "stopped",
        connected: started && deps.transport.connected(),
        paused,
        inbound,
        outbound,
        reconnects,
        ...(lastInboundAt === undefined ? {} : { lastInboundAt }),
        ...(lastError ? { lastError } : {}),
      };
    },
  };
}
