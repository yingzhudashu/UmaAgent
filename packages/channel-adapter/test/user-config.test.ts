import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadUserConfig } from "../src/user-config.js";

async function fixture(value: unknown): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "uma-user-config-"));
  const path = join(root, "config.json");
  await writeFile(path, JSON.stringify(value), { mode: 0o600 });
  return path;
}

const valid = {
  version: 1,
  core: { serverUrl: "http://127.0.0.1:3210", token: "core-token" },
  xianyu: {
    cookie: "cookie-value",
    controlToken: "control-token",
    host: "127.0.0.1",
    port: 3250,
    stateDir: "/tmp/uma-xianyu",
  },
};

describe("user config", () => {
  it("rejects unknown fields", async () => {
    const path = await fixture({ ...valid, unexpected: true });
    await expect(loadUserConfig(path, "xianyu")).rejects.toThrow("unknown fields");
  });

  it("rejects missing channel credentials", async () => {
    const path = await fixture({ version: 1, core: valid.core, xianyu: { ...valid.xianyu, cookie: "" } });
    await expect(loadUserConfig(path, "xianyu")).rejects.toThrow("cookie must be a non-empty string");
  });

  it("does not read legacy environment credentials", async () => {
    process.env.XIANYU_COOKIE = "legacy-secret";
    const path = await fixture({ version: 1, core: valid.core });
    await expect(loadUserConfig(path, "xianyu")).rejects.toThrow("must define feishu or xianyu");
    delete process.env.XIANYU_COOKIE;
  });
});
