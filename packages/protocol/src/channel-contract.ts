import Type, { type Static } from "typebox";
import type { AgentEventEnvelope } from "./event-contract.js";
import { Strict } from "./schema-helpers.js";

export interface AdapterHealth {
  status: "ok" | "degraded" | "stopped";
  connected: boolean;
  lastInboundAt?: number;
  lastError?: string;
}

export interface ExternalConversation {
  adapter: string;
  tenantId: string;
  conversationId: string;
  threadId?: string;
  kind: "direct" | "group";
}

export interface ChannelInboundMessage {
  conversation: ExternalConversation;
  externalMessageId: string;
  senderId?: string;
  text: string;
  attachmentIds?: string[];
}

export interface ChannelAdapter {
  start(): Promise<void>;
  stop(): Promise<void>;
  health(): AdapterHealth;
  mapConversation(input: ExternalConversation): Promise<string>;
  handleInbound(input: ChannelInboundMessage): Promise<void>;
  renderEvent(event: AgentEventEnvelope): Promise<void>;
}

/** 当前认证账号的执行策略，不接受客户端指定其他账号。 */
export const ExecutionSettingsSchema = Strict({ autoApprove: Type.Boolean() });
export type ExecutionSettings = Static<typeof ExecutionSettingsSchema>;
