import { describe, expect, it, vi } from "vitest";
import { XianyuAuthError, XianyuClient } from "../src/client.js";

describe("Xianyu client", () => {
  it("rejects incomplete production cookies", () => {
    expect(() => new XianyuClient("unb=owner")).toThrow(XianyuAuthError);
  });

  it("requests an IM access token through the signed MTop endpoint", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ data: { accessToken: "access" }, ret: ["SUCCESS::调用成功"] }), {
          status: 200,
        }),
    );
    const client = new XianyuClient("unb=owner; _m_h5_tk=token_abc", fetchMock as typeof fetch);
    await expect(client.getAccessToken()).resolves.toBe("access");
    const request = fetchMock.mock.calls[0]?.[0]?.toString() ?? "";
    expect(request).toContain("mtop.taobao.idlemessage.pc.login.token");
    const headers = fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(headers.cookie).toContain("unb=owner");
  });

  it("retains refreshed auth cookies returned by MTop", async () => {
    const fetchMock = vi.fn(async () => {
      const response = new Response(JSON.stringify({ data: { accessToken: "access" }, ret: ["SUCCESS"] }), {
        status: 200,
      });
      response.headers.set("set-cookie", "_m_h5_tk=refreshed_1; Path=/");
      return response;
    });
    const client = new XianyuClient("unb=owner; _m_h5_tk=token_abc", fetchMock as typeof fetch);
    await client.getAccessToken();
    expect(client.cookieHeader()).toContain("_m_h5_tk=refreshed_1");
  });
});
