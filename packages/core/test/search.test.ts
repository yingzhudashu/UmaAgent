import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  safeFetch: vi.fn(),
  search: vi.fn(),
  tavily: vi.fn(),
}));

vi.mock("../src/tools.js", () => ({ safeFetch: mocks.safeFetch }));
vi.mock("@tavily/core", () => ({ tavily: mocks.tavily }));

import { SearchService } from "../src/search.js";

describe("search service", () => {
  beforeEach(() => {
    mocks.safeFetch.mockReset();
    mocks.search.mockReset();
    mocks.tavily.mockReset().mockImplementation(() => ({ search: mocks.search }));
  });

  it("requires a query and an explicit Tavily key", async () => {
    const search = new SearchService("");
    await expect(search.search("tavily", "", 5)).rejects.toThrow("query");
    await expect(search.search("tavily", "typescript", 5)).rejects.toThrow("TAVILY_API_KEY");
  });

  it("bounds and normalizes Tavily results", async () => {
    const search = new SearchService("isolated-test-key");
    mocks.search.mockResolvedValue({
      results: [
        { title: "First", url: "https://example.com/1", content: "a".repeat(2_100) },
        { title: "Second", url: "https://example.com/2", content: "second" },
      ],
    });

    await expect(search.search("tavily", "  typescript  ", 0)).resolves.toEqual([
      {
        title: "First",
        url: "https://example.com/1",
        snippet: "a".repeat(2_000),
        source: "tavily",
      },
    ]);
    expect(mocks.search).toHaveBeenCalledWith(
      "typescript",
      expect.objectContaining({ maxResults: 1, timeout: 10 }),
    );
  });

  it("round-robins configured keys across successful searches", async () => {
    mocks.search.mockResolvedValue({ results: [] });
    const search = new SearchService(["first-key", "second-key", "third-key"]);

    await search.search("tavily", "one");
    await search.search("tavily", "two");
    await search.search("tavily", "three");

    expect(mocks.tavily.mock.calls.map(([input]) => input.apiKey)).toEqual([
      "first-key",
      "second-key",
      "third-key",
    ]);
  });

  it("skips an expired key and succeeds with the next key without exposing credentials", async () => {
    mocks.tavily.mockImplementation(({ apiKey }: { apiKey: string }) => ({
      search:
        apiKey === "expired-key"
          ? vi.fn().mockRejectedValue(new Error("401 Error: invalid api key"))
          : mocks.search,
    }));
    mocks.search.mockResolvedValue({ results: [] });
    const search = new SearchService("expired-key,working-key");

    await expect(search.search("tavily", "fallback")).resolves.toEqual([]);
    expect(mocks.tavily.mock.calls.map(([input]) => input.apiKey)).toEqual(["expired-key", "working-key"]);
  });

  it("continues after a quota error and reports a sanitized all-keys failure", async () => {
    mocks.tavily.mockImplementation(({ apiKey }: { apiKey: string }) => ({
      search: vi.fn().mockRejectedValue(new Error(`${apiKey} quota exceeded`)),
    }));
    const search = new SearchService(["first-secret", "second-secret"]);

    await expect(search.search("tavily", "quota")).rejects.toThrow(
      "Tavily search failed for all 2 configured API keys",
    );
    await expect(search.search("tavily", "quota")).rejects.not.toThrow(/first-secret|second-secret/);
  });

  it("maps valid Stack Exchange results and skips incomplete entries", async () => {
    mocks.safeFetch.mockResolvedValue(
      JSON.stringify({
        items: [
          { title: "Useful answer", link: "https://stackoverflow.com/q/1", body: "<p>Hello   world</p>" },
          { title: "Missing link" },
          { link: "https://stackoverflow.com/q/2" },
        ],
      }),
    );
    const signal = new AbortController().signal;
    await expect(new SearchService("").search("stackexchange", "node", 99, signal)).resolves.toEqual([
      {
        title: "Useful answer",
        url: "https://stackoverflow.com/q/1",
        snippet: " Hello world ",
        source: "stackexchange",
      },
    ]);
    const [url, passedSignal] = mocks.safeFetch.mock.calls[0] ?? [];
    expect(String(url)).toContain("pagesize=10");
    expect(passedSignal).toBe(signal);

    mocks.safeFetch.mockResolvedValue("{}");
    await expect(new SearchService("").search("stackexchange", "node", 2)).resolves.toEqual([]);
  });
});
