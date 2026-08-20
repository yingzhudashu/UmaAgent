import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  safeFetch: vi.fn(),
}));

vi.mock("../src/tools.js", () => ({ safeFetch: mocks.safeFetch }));

import { SearchService } from "../src/search.js";

describe("search service", () => {
  beforeEach(() => mocks.safeFetch.mockReset());

  it("requires a query and an explicit Tavily key", async () => {
    const search = new SearchService("");
    await expect(search.search("tavily", "", 5)).rejects.toThrow("query");
    await expect(search.search("tavily", "typescript", 5)).rejects.toThrow("TAVILY_API_KEY");
  });

  it("bounds and normalizes Tavily results", async () => {
    const search = new SearchService("");
    const provider = {
      search: vi.fn().mockResolvedValue({
        results: [
          { title: "First", url: "https://example.com/1", content: "a".repeat(2_100) },
          { title: "Second", url: "https://example.com/2", content: "second" },
        ],
      }),
    };
    Object.assign(search, { tavilyClient: provider });

    await expect(search.search("tavily", "  typescript  ", 0)).resolves.toEqual([
      {
        title: "First",
        url: "https://example.com/1",
        snippet: "a".repeat(2_000),
        source: "tavily",
      },
    ]);
    expect(provider.search).toHaveBeenCalledWith(
      "typescript",
      expect.objectContaining({ maxResults: 1, timeout: 10 }),
    );
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
