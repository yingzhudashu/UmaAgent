import { randomBytes, scryptSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  validateXianyuChatBody,
  validateXianyuPublishBody,
  verifyXianyuPassword,
  XianyuGrantStore,
} from "../src/xianyu.js";

describe("xianyu access control", () => {
  it("verifies the scrypt password format without exposing plaintext", async () => {
    const salt = randomBytes(16);
    const digest = scryptSync("correct horse", salt, 32, { N: 16_384, r: 8, p: 1 });
    const encoded = `scrypt$16384$8$1$${salt.toString("base64url")}$${digest.toString("base64url")}`;
    await expect(verifyXianyuPassword("correct horse", encoded)).resolves.toBe(true);
    await expect(verifyXianyuPassword("wrong", encoded)).resolves.toBe(false);
    await expect(verifyXianyuPassword("correct horse", "plaintext")).resolves.toBe(false);
    await expect(
      verifyXianyuPassword(
        "correct horse",
        `scrypt$33554432$8$1$${salt.toString("base64url")}$${digest.toString("base64url")}`,
      ),
    ).resolves.toBe(false);
    await expect(
      verifyXianyuPassword("correct horse", `scrypt$16384$8$1$${salt.toString("base64url")}$AA`),
    ).resolves.toBe(false);
  });

  it("issues per-user in-memory grants", () => {
    const store = new XianyuGrantStore();
    const issued = store.issue("user-1");
    expect(store.valid("user-1", issued.grant)).toBe(true);
    expect(store.valid("user-2", issued.grant)).toBe(false);
    store.revoke("user-1");
    expect(store.valid("user-1", issued.grant)).toBe(false);
  });

  it("rejects incomplete control payloads before reaching the adapter", () => {
    expect(() => validateXianyuChatBody({ receiverId: "", itemId: "item" })).toThrow();
    expect(validateXianyuChatBody({ receiverId: " buyer ", itemId: " item " })).toEqual({
      receiverId: "buyer",
      itemId: "item",
    });
    expect(() => validateXianyuPublishBody({ description: "item", imagePaths: [] })).toThrow();
    expect(
      validateXianyuPublishBody({
        description: " item ",
        imagePaths: [" /tmp/a.jpg "],
        delivery: "free_shipping",
        longitude: "121.4",
        latitude: "31.2",
      }),
    ).toMatchObject({
      description: "item",
      imagePaths: ["/tmp/a.jpg"],
      longitude: "121.4",
      latitude: "31.2",
    });
    expect(() =>
      validateXianyuPublishBody({
        description: "item",
        imagePaths: ["/tmp/a.jpg"],
        delivery: "free_shipping",
      }),
    ).toThrow(/longitude/);
    expect(() =>
      validateXianyuPublishBody({
        description: "item",
        imagePaths: ["/tmp/a.jpg"],
        delivery: "fixed",
        longitude: "1",
        latitude: "2",
      }),
    ).toThrow(/shippingFee/);
  });
});
