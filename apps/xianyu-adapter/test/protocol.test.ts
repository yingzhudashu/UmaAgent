import { describe, expect, it } from "vitest";
import {
  buildRegistration,
  formatCookieHeader,
  mtopSign,
  parseCookieHeader,
  parseInboundFrame,
} from "../src/protocol.js";

describe("Xianyu protocol", () => {
  it("preserves cookie values containing equals and signs MTop requests", () => {
    const cookies = parseCookieHeader("unb=owner; _m_h5_tk=token_123=abc; empty=");
    expect(cookies).toEqual({ unb: "owner", _m_h5_tk: "token_123=abc", empty: "" });
    expect(formatCookieHeader(cookies)).toContain("_m_h5_tk=token_123=abc");
    expect(mtopSign("1", "token", "{}")).toMatch(/^[a-f0-9]{32}$/);
  });

  it("builds the authenticated IM registration frame", () => {
    const frame = buildRegistration("access", "device");
    expect(frame).toMatchObject({
      lwp: "/reg",
      headers: { token: "access", did: "device", "app-key": expect.any(String) },
    });
  });

  it("normalizes text sync push frames", () => {
    const payload = Buffer.from(
      JSON.stringify({
        message: {
          cid: "conversation@goofish",
          uuid: "uuid-1",
          createTime: Date.now(),
          extension: { senderUserId: "buyer", messageId: "message-1", reminderTitle: "Buyer" },
          content: {
            custom: {
              data: Buffer.from(JSON.stringify({ contentType: 1, text: { text: "hello" } })).toString(
                "base64",
              ),
            },
          },
        },
      }),
    ).toString();
    expect(parseInboundFrame({ body: { syncPushPackage: { data: [{ data: payload }] } } })).toMatchObject({
      externalMessageId: "message-1",
      senderId: "buyer",
      text: "hello",
      conversation: { conversationId: "conversation", adapter: "xianyu" },
    });
  });
});
