import type { LookupFunction } from "node:net";
import type { Agent, MockAgent } from "undici";
import { beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import { safeFetch } from "../src/tools.js";

const network = vi.hoisted(() => ({
  lookup: vi.fn(),
  status: 200,
  dispatchers: [] as Array<{ close: MockInstance<MockAgent["close"]>; options: Agent.Options }>,
}));
vi.mock("node:dns/promises", () => ({ lookup: network.lookup }));
vi.mock("undici", async (importOriginal) => {
  const undici = await importOriginal<typeof import("undici")>();
  return {
    ...undici,
    Agent: class extends undici.MockAgent {
      constructor(options: Agent.Options) {
        super();
        this.disableNetConnect();
        this.get("https://public.example.test")
          .intercept({ path: "/", method: "GET" })
          .reply(network.status, "<!doctype html><title>Isolated response</title>");
        network.dispatchers.push({ close: vi.spyOn(this, "close"), options });
      }
    },
  };
});

beforeEach(() => {
  network.lookup.mockReset().mockResolvedValue([{ address: "93.184.215.14", family: 4 }]);
  network.status = 200;
  network.dispatchers.length = 0;
});

describe("safe HTTP fetch with isolated DNS and transport", () => {
  it("fetches a public URL and pins both Node DNS callback forms to the validated address", async () => {
    const body = await safeFetch("https://public.example.test/");
    expect(body).toContain("<!doctype html>");
    expect(network.lookup).toHaveBeenCalledExactlyOnceWith("public.example.test", { all: true });
    const dispatcher = network.dispatchers[0];
    expect(dispatcher?.close).toHaveBeenCalledOnce();
    const lookup = (dispatcher?.options.connect as { lookup: LookupFunction }).lookup;
    const all = vi.fn();
    lookup("public.example.test", { all: true }, all);
    expect(all).toHaveBeenCalledExactlyOnceWith(null, [{ address: "93.184.215.14", family: 4 }]);
    const single = vi.fn();
    lookup("public.example.test", { all: false }, single);
    expect(single).toHaveBeenCalledExactlyOnceWith(null, "93.184.215.14", 4);
  });

  it("preserves DNS failure diagnostics without contacting a transport", async () => {
    network.lookup.mockRejectedValue(
      Object.assign(new Error("DNS fixture not found"), { code: "ENOTFOUND" }),
    );
    await expect(safeFetch("https://public.example.test/")).rejects.toThrow(
      "http_get_dns_failed (ENOTFOUND)",
    );
    expect(network.dispatchers).toHaveLength(0);
  });

  it("preserves HTTP status diagnostics and closes its dispatcher", async () => {
    network.status = 404;
    await expect(safeFetch("https://public.example.test/")).rejects.toThrow("http_get_http_status: HTTP 404");
    expect(network.dispatchers[0]?.close).toHaveBeenCalledOnce();
  });

  it("rejects a DNS response containing a private address before creating a transport", async () => {
    network.lookup.mockResolvedValue([
      { address: "93.184.215.14", family: 4 },
      { address: "127.0.0.1", family: 4 },
    ]);
    await expect(safeFetch("https://public.example.test/")).rejects.toThrow("Private");
    expect(network.dispatchers).toHaveLength(0);
  });
});
