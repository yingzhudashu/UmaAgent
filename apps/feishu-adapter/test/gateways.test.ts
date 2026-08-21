import { describe, expect, it, vi } from "vitest";
import { LarkFeishuGateway } from "../src/gateways.js";

describe("LarkFeishuGateway", () => {
  it("creates, updates, and downloads card resources through the SDK boundary", async () => {
    const readable = { getReadableStream: vi.fn() };
    const create = vi
      .fn()
      .mockResolvedValueOnce({ data: { message_id: "message-1" } })
      .mockResolvedValueOnce({ data: {} });
    const patch = vi.fn(async () => ({}));
    const get = vi.fn(async () => readable);
    const gateway = new LarkFeishuGateway({
      im: { message: { create, patch }, messageResource: { get } },
    } as never);

    await expect(gateway.createCard("chat-1", "card-json")).resolves.toBe("message-1");
    await expect(gateway.createCard("chat-2", "card-json-2")).resolves.toBeUndefined();
    expect(create).toHaveBeenNthCalledWith(1, {
      params: { receive_id_type: "chat_id" },
      data: { receive_id: "chat-1", content: "card-json", msg_type: "interactive" },
    });

    await gateway.updateCard("message-1", "updated-json");
    expect(patch).toHaveBeenCalledWith({
      path: { message_id: "message-1" },
      data: { content: "updated-json" },
    });

    await expect(gateway.downloadResource("message-1", "file-key", "file")).resolves.toBe(readable);
    expect(get).toHaveBeenCalledWith({
      params: { type: "file" },
      path: { message_id: "message-1", file_key: "file-key" },
    });
  });
});
