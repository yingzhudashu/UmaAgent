import type { TavilyClient } from "@tavily/core";
import type { SearchCitation } from "@uma-agent/protocol";
import { safeFetch } from "./tools.js";

const TAVILY_QUOTA_COOLDOWN_MS = 60_000;

type TavilyKeyInput = string | readonly string[] | undefined;

function parseTavilyKeys(input: TavilyKeyInput): string[] {
  const values: readonly string[] = typeof input === "string" ? input.split(/[\s,;]+/u) : (input ?? []);
  return [...new Set(values.map((value: string) => value.trim()).filter(Boolean))];
}

function errorText(error: unknown): string {
  if (error instanceof Error) return `${error.name} ${error.message}`;
  return String(error);
}

function errorStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const value = error as {
    status?: unknown;
    statusCode?: unknown;
    response?: { status?: unknown };
  };
  for (const candidate of [value.status, value.statusCode, value.response?.status]) {
    const status = typeof candidate === "number" ? candidate : Number(candidate);
    if (Number.isInteger(status)) return status;
  }
  return undefined;
}

function isTavilyKeyFailure(error: unknown): { permanent: boolean } {
  const status = errorStatus(error);
  const text = errorText(error);
  const permanent =
    status === 401 ||
    status === 403 ||
    /(?:invalid|expired|revoked|unauthorized|authentication).*?(?:api\s*key|token)|(?:api\s*key|token).*?(?:invalid|expired|revoked|unauthorized|authentication)/iu.test(
      text,
    );
  const quota =
    status === 429 ||
    /(?:quota|credit|rate\s*limit|too\s*many\s*requests|usage\s*limit|limit\s*exceeded)/iu.test(text);
  return permanent || quota ? { permanent } : { permanent: false };
}

export class SearchService {
  private readonly tavilyKeys: string[];
  private readonly tavilyClients = new Map<string, Promise<TavilyClient>>();
  private readonly tavilyDisabled = new Set<string>();
  private readonly tavilyCooldownUntil = new Map<string, number>();
  private nextTavilyKey = 0;

  constructor(apiKeys?: TavilyKeyInput) {
    if (apiKeys !== undefined) {
      this.tavilyKeys = parseTavilyKeys(apiKeys);
      return;
    }
    const configuredKeys = parseTavilyKeys(process.env.TAVILY_API_KEYS);
    this.tavilyKeys =
      configuredKeys.length > 0 ? configuredKeys : parseTavilyKeys(process.env.TAVILY_API_KEY);
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
    if (this.tavilyKeys.length === 0) {
      throw new Error("TAVILY_API_KEYS or TAVILY_API_KEY is required for Tavily search");
    }
    let lastKeyFailure: unknown;
    for (let attempt = 0; attempt < this.tavilyKeys.length; attempt += 1) {
      signal?.throwIfAborted();
      const keyIndex = this.nextAvailableTavilyKey();
      if (keyIndex === undefined) break;
      const apiKey = this.tavilyKeys[keyIndex];
      if (!apiKey) continue;
      // Reserve the next slot before awaiting the network request so concurrent
      // searches distribute their first attempt across the configured keys.
      this.nextTavilyKey = (keyIndex + 1) % this.tavilyKeys.length;
      try {
        const response = await (await this.tavilyClient(apiKey)).search(normalized, {
          searchDepth: "basic",
          maxResults: bounded,
          includeAnswer: false,
          includeRawContent: false,
          timeout: 10,
        });
        signal?.throwIfAborted();
        return response.results.slice(0, bounded).map((item) => ({
          title: item.title,
          url: item.url,
          snippet: item.content.slice(0, 2_000),
          source: "tavily",
        }));
      } catch (error) {
        signal?.throwIfAborted();
        const keyFailure = isTavilyKeyFailure(error);
        if (
          !keyFailure.permanent &&
          errorStatus(error) !== 429 &&
          !/quota|credit|rate\s*limit|too\s*many\s*requests|usage\s*limit|limit\s*exceeded/iu.test(
            errorText(error),
          )
        ) {
          throw error;
        }
        lastKeyFailure = error;
        if (keyFailure.permanent) this.tavilyDisabled.add(apiKey);
        else this.tavilyCooldownUntil.set(apiKey, Date.now() + TAVILY_QUOTA_COOLDOWN_MS);
      }
    }
    if (lastKeyFailure) {
      throw new Error(`Tavily search failed for all ${this.tavilyKeys.length} configured API keys`);
    }
    throw new Error("Tavily API keys are temporarily unavailable");
  }

  private tavilyClient(apiKey: string): Promise<TavilyClient> {
    const existing = this.tavilyClients.get(apiKey);
    if (existing) return existing;
    const client = import("@tavily/core").then(({ tavily }) => tavily({ apiKey, clientName: "uma-agent" }));
    this.tavilyClients.set(apiKey, client);
    return client;
  }

  private nextAvailableTavilyKey(): number | undefined {
    const now = Date.now();
    for (let offset = 0; offset < this.tavilyKeys.length; offset += 1) {
      const index = (this.nextTavilyKey + offset) % this.tavilyKeys.length;
      const key = this.tavilyKeys[index];
      if (!key) continue;
      if (this.tavilyDisabled.has(key)) continue;
      const cooldownUntil = this.tavilyCooldownUntil.get(key) ?? 0;
      if (cooldownUntil > now) continue;
      this.tavilyCooldownUntil.delete(key);
      return index;
    }
    return undefined;
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
