import { describe, expect, it } from "vitest";
import { acceptsInbound, type FeishuInboundEnvelope, isAllowedOpenId } from "../src/inbound-policy.js";

const allowed = new Set(["owner"]);

const message = (input: Partial<FeishuInboundEnvelope["message"]> = {}): FeishuInboundEnvelope => ({
  sender: { sender_id: { open_id: "owner" } },
  message: { message_type: "text", chat_type: "p2p", ...input },
});

describe("Feishu inbound policy", () => {
  it("uses the owner allow-list for both messages and card actions", () => {
    expect(isAllowedOpenId("owner", allowed)).toBe(true);
    expect(isAllowedOpenId("stranger", allowed)).toBe(false);
    expect(isAllowedOpenId(undefined, allowed)).toBe(false);
  });

  it("rejects every sender outside the explicit owner whitelist", () => {
    expect(
      acceptsInbound({ ...message(), sender: { sender_id: { open_id: "stranger" } } }, allowed, () => false),
    ).toBe(false);
  });

  it("accepts group messages only when mentioned or replying to an Adapter message", () => {
    expect(acceptsInbound(message({ chat_type: "group" }), allowed, () => false)).toBe(false);
    expect(acceptsInbound(message({ chat_type: "group", mentions: [{}] }), allowed, () => false)).toBe(true);
    expect(
      acceptsInbound(
        message({ chat_type: "group", parent_id: "adapter-card" }),
        allowed,
        (id) => id === "adapter-card",
      ),
    ).toBe(true);
    expect(
      acceptsInbound(
        message({ chat_type: "group", root_id: "unrelated-user-message" }),
        allowed,
        () => false,
      ),
    ).toBe(false);
  });
});
