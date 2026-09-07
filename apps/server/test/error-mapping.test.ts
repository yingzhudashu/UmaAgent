import { describe, expect, it } from "vitest";
import { mapServerError } from "../src/error-mapping.js";

describe("server error mapping", () => {
  it("redacts credential values while retaining the diagnostic category", () => {
    const result = mapServerError(
      new Error("Provider request failed: Bearer abc.def api_key=private-key ECONNRESET"),
      [],
    );
    expect(result).toMatchObject({ code: "provider_error", status: 502, retryable: true });
    expect(result.message).toContain("ECONNRESET");
    expect(result.message).not.toContain("abc.def");
    expect(result.message).not.toContain("private-key");
  });

  it("keeps Xianyu administrator and grant failures distinguishable", () => {
    expect(mapServerError(new Error("Xianyu administrator access required"), [])).toMatchObject({
      code: "xianyu_admin_required",
      status: 403,
    });
    expect(mapServerError(new Error("Xianyu grant expired or missing"), [])).toMatchObject({
      code: "xianyu_grant_expired",
      status: 403,
    });
  });
});
