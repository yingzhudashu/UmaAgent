import { type TavilyClient, tavily } from "@tavily/core";
import type { SearchCitation } from "@uma-agent/protocol";
import { safeFetch } from "./tools.js";

export class SearchService {
  private readonly tavilyClient: TavilyClient | undefined;

  constructor(apiKey = process.env.TAVILY_API_KEY?.trim()) {
    this.tavilyClient = apiKey ? tavily({ apiKey, clientName: "uma-agent" }) : undefined;
  }

  async search(
    provider: "tavily" | "stackexchange",
    query: string,
    limit = 5,
    signal?: AbortSignal,
  ): Promise<SearchCitation[]> {
    const normalized = query.trim();
    if (!normalized) throw new Error("Search query is required");
    const bounded = Math.max(1, Math.min(10, limit));
    if (provider === "stackexchange") return this.stackExchange(normalized, bounded, signal);
    if (!this.tavilyClient) throw new Error("TAVILY_API_KEY is required for Tavily search");
    const response = await this.tavilyClient.search(normalized, {
      searchDepth: "basic",
      maxResults: bounded,
      includeAnswer: false,
      includeRawContent: false,
      timeout: 10,
    });
    return response.results.slice(0, bounded).map((item) => ({
      title: item.title,
      url: item.url,
      snippet: item.content.slice(0, 2_000),
      source: "tavily",
    }));
  }

  private async stackExchange(query: string, limit: number, signal?: AbortSignal): Promise<SearchCitation[]> {
    const url = new URL("https://api.stackexchange.com/2.3/search/advanced");
    url.searchParams.set("site", "stackoverflow");
    url.searchParams.set("order", "desc");
    url.searchParams.set("sort", "relevance");
    url.searchParams.set("q", query);
    url.searchParams.set("pagesize", String(limit));
    url.searchParams.set("filter", "withbody");
    const body = JSON.parse(await safeFetch(url.toString(), signal)) as {
      items?: Array<{ title?: string; link?: string; body?: string }>;
    };
    return (body.items ?? []).slice(0, limit).flatMap((item) =>
      item.title && item.link
        ? [
            {
              title: item.title,
              url: item.link,
              snippet: (item.body ?? "")
                .replace(/<[^>]+>/g, " ")
                .replace(/\s+/g, " ")
                .slice(0, 2_000),
              source: "stackexchange" as const,
            },
          ]
        : [],
    );
  }
}
