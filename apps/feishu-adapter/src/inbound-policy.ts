export interface FeishuInboundEnvelope {
  sender?: { sender_id?: { open_id?: string; user_id?: string } };
  message: {
    message_type: string;
    chat_type: string;
    root_id?: string;
    parent_id?: string;
    mentions?: Array<unknown>;
  };
}

const supportedTypes = new Set(["text", "post", "image", "file"]);

export function isAllowedOpenId(openId: string | undefined, allowedOpenIds: ReadonlySet<string>): boolean {
  return Boolean(openId && allowedOpenIds.has(openId));
}

export function acceptsInbound(
  input: FeishuInboundEnvelope,
  allowedOpenIds: ReadonlySet<string>,
  isOutboundMessage: (messageId: string | undefined) => boolean,
): boolean {
  if (!supportedTypes.has(input.message.message_type)) return false;
  const senderId = input.sender?.sender_id?.open_id;
  if (!isAllowedOpenId(senderId, allowedOpenIds)) return false;
  if (input.message.chat_type !== "group") return true;
  if (input.message.mentions?.length) return true;
  return isOutboundMessage(input.message.parent_id) || isOutboundMessage(input.message.root_id);
}
