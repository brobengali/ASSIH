import { z } from 'zod';

export const webSearchInputSchema = z.object({
  queries: z
    .array(z.string())
    .min(1)
    .max(6)
    .describe(
      "Search queries to execute in parallel. Fan out across separate entities (e.g. separate query per CRM or DB product) and include angles like 'pricing' or 'changelog' when checking changes."
    ),
  since: z
    .string()
    .optional()
    .describe('Optional ISO date (YYYY-MM-DD) to filter results published on or after this date.'),
  topic: z
    .enum(['general', 'news'])
    .optional()
    .describe("Category: 'general' (default) for docs/pricing/changelogs, 'news' for press/announcements."),
});

export type WebSearchInput = z.infer<typeof webSearchInputSchema>;

export interface SearchResultItem {
  title: string;
  url: string;
  snippet: string;
  domain: string;
  publishedDate?: string;
  query: string;
}

export interface WebSearchOutput {
  results: SearchResultItem[];
  queriedCount: number;
  returnedCount: number;
  warnings?: string[];
  sinceFilterApplied?: string;
}

// Low-quality aggregator / spam domains to filter out
const BLOCKED_DOMAINS = new Set([
  'pinterest.com',
  'quora.com',
  'softonic.com',
  'apkpure.com',
  'coupon.com',
  'retailmenot.com',
  'slickdeals.net',
]);

interface CacheEntry {
  data: SearchResultItem[];
  timestamp: number;
}

export class SearchEngine {
  private cache = new Map<string, CacheEntry>();
  private cacheTTLMs = 10 * 60 * 1000; // 10 minutes
  private maxCacheSize = 250;
  private apiKey: string | undefined;

  // Mock handler for testing & evals
  private mockSearchHandler?: (query: string, since?: string) => Promise<SearchResultItem[]>;

  constructor(apiKey?: string) {
    this.apiKey = apiKey || process.env.TAVILY_API_KEY;
  }

  public setMockHandler(handler?: (query: string, since?: string) => Promise<SearchResultItem[]>) {
    this.mockSearchHandler = handler;
  }

  private getCacheKey(query: string, since?: string, topic?: string): string {
    return `${query.trim().toLowerCase()}|${since || ''}|${topic || 'general'}`;
  }

  private cleanSnippet(text: string, maxChars: number = 320): string {
    if (!text) return '';
    const collapsed = text.replace(/\s+/g, ' ').trim();
    if (collapsed.length <= maxChars) return collapsed;
    const truncated = collapsed.slice(0, maxChars);
    const lastSpace = truncated.lastIndexOf(' ');
    return (lastSpace > maxChars * 0.7 ? truncated.slice(0, lastSpace) : truncated) + '...';
  }

  private extractDomain(urlStr: string): string {
    try {
      const u = new URL(urlStr);
      return u.hostname.replace(/^www\./, '');
    } catch {
      return '';
    }
  }

  private isLowQuality(urlStr: string): boolean {
    const domain = this.extractDomain(urlStr);
    for (const blocked of BLOCKED_DOMAINS) {
      if (domain === blocked || domain.endsWith('.' + blocked)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Single query execution with timeout + 1 retry
   */
  private async searchSingleWithRetry(
    query: string,
    since?: string,
    topic: 'general' | 'news' = 'general'
  ): Promise<SearchResultItem[]> {
    const cacheKey = this.getCacheKey(query, since, topic);
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < this.cacheTTLMs) {
      return cached.data;
    }

    let rawResults: any[] = [];
    if (this.mockSearchHandler) {
      rawResults = await this.mockSearchHandler(query, since);
    } else {
      if (!this.apiKey) {
        throw new Error('TAVILY_API_KEY is not set. Cannot execute real search.');
      }

      let lastErr: any;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const body: Record<string, any> = {
            api_key: this.apiKey,
            query,
            search_depth: 'basic',
            topic,
            max_results: 4,
            include_answer: false,
          };

          if (since) {
            body.start_date = since;
          }

          const res = await fetch('https://api.tavily.com/search', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(9000),
          });

          if (!res.ok) {
            const errText = await res.text().catch(() => '');
            throw new Error(`Tavily HTTP ${res.status}: ${errText}`);
          }

          const json = (await res.json()) as any;
          rawResults = json.results || [];
          break;
        } catch (err: any) {
          lastErr = err;
          if (attempt === 0) {
            // brief backoff before 1 retry
            await new Promise(r => setTimeout(r, 400));
          } else {
            throw lastErr || new Error(`Search failed for query "${query}"`);
          }
        }
      }
    }

    const processed: SearchResultItem[] = [];
    for (const item of rawResults) {
      const url = item.url || '';
      if (!url || this.isLowQuality(url)) continue;

      processed.push({
        title: (item.title || '').trim(),
        url,
        snippet: this.cleanSnippet(item.content || item.snippet || ''),
        domain: this.extractDomain(url),
        publishedDate: item.publishedDate || item.published_date || item.date || undefined,
        query,
      });
    }

    this.saveToCache(cacheKey, processed);
    return processed;
  }

  private saveToCache(key: string, data: SearchResultItem[]) {
    if (this.cache.size >= this.maxCacheSize) {
      // LRU evict oldest
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey) this.cache.delete(oldestKey);
    }
    this.cache.set(key, { data, timestamp: Date.now() });
  }

  /**
   * Main tool entrypoint: fans out queries in parallel, dedupes URLs, caps items
   */
  public async executeSearch(input: WebSearchInput): Promise<WebSearchOutput> {
    const { queries, since, topic = 'general' } = input;
    const warnings: string[] = [];
    const seenUrls = new Set<string>();
    const allResults: SearchResultItem[] = [];

    // Fan out in parallel
    const promises = queries.map(q =>
      this.searchSingleWithRetry(q, since, topic).catch(err => {
        warnings.push(`Search failed for "${q}": ${err.message}`);
        return [] as SearchResultItem[];
      })
    );

    const outcomes = await Promise.all(promises);

    for (const queryResults of outcomes) {
      // Cap per query to avoid overwhelming context
      const topForQuery = queryResults.slice(0, 3);
      for (const item of topForQuery) {
        if (!seenUrls.has(item.url)) {
          seenUrls.add(item.url);
          allResults.push(item);
        }
      }
    }

    return {
      results: allResults,
      queriedCount: queries.length,
      returnedCount: allResults.length,
      warnings: warnings.length > 0 ? warnings : undefined,
      sinceFilterApplied: since,
    };
  }

  public clearCache() {
    this.cache.clear();
  }
}
