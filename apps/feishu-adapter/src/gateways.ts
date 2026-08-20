import type * as lark from "@larksuiteoapi/node-sdk";
import type { UmaClient } from "@uma-agent/client";

export type CoreGateway = Pick<
  UmaClient,
  | "getSession"
  | "listRunActions"
  | "upload"
  | "createSession"
  | "sendMessage"
  | "subscribeSessions"
  | "resolveApproval"
  | "resumeRun"
  | "decideRunAction"
  | "connectEvents"
  | "close"
>;

export interface FeishuGateway {
  createCard(chatId: string, content: string): Promise<string | undefined>;
  updateCard(messageId: string, content: string): Promise<void>;
  downloadResource(
    messageId: string,
    resourceKey: string,
    type: "image" | "file",
  ): Promise<{ getReadableStream(): AsyncIterable<unknown> }>;
}

export class LarkFeishuGateway implements FeishuGateway {
  constructor(private readonly client: lark.Client) {}

  async createCard(chatId: string, content: string): Promise<string | undefined> {
    const result = await this.client.im.message.create({
      params: { receive_id_type: "chat_id" },
      data: { receive_id: chatId, content, msg_type: "interactive" },
    });
    const messageId = (result as { data?: { message_id?: string } }).data?.message_id;
    return messageId ? String(messageId) : undefined;
  }

  async updateCard(messageId: string, content: string): Promise<void> {
    await (this.client.im.message as unknown as { patch: (input: unknown) => Promise<unknown> }).patch({
      path: { message_id: messageId },
      data: { content },
    });
  }

  async downloadResource(
    messageId: string,
    resourceKey: string,
    type: "image" | "file",
  ): Promise<{ getReadableStream(): AsyncIterable<unknown> }> {
    return this.client.im.messageResource.get({
      params: { type },
      path: { message_id: messageId, file_key: resourceKey },
    }) as Promise<{ getReadableStream(): AsyncIterable<unknown> }>;
  }
}
