import { describe, expect, it } from "vitest";
import { assertPublicUrl, isPrivateAddress } from "../src/network.js";

describe("browser network policy", () => {
  it("blocks private, reserved, and mapped addresses", () => {
    for (const address of ["127.0.0.1", "10.0.0.1", "192.168.1.1", "169.254.1.1", "::1", "::ffff:127.0.0.1"])
      expect(isPrivateAddress(address)).toBe(true);
    expect(isPrivateAddress("8.8.8.8")).toBe(false);
  });

  it("rejects non-HTTP navigation before DNS lookup", async () => {
    await expect(assertPublicUrl("file:///etc/passwd")).rejects.toThrow("HTTP");
  });
});
