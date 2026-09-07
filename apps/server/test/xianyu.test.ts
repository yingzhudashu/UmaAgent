import { describe, expect, it } from "vitest";
import { validateXianyuChatBody, validateXianyuPublishBody } from "../src/xianyu.js";

describe("xianyu request validation", () => {
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
