# Architectural Design: Grounded Web Search Agent

*Author's Note: I designed this system with strict adherence to architectural discipline over surface polish. Every decision prioritizes low latency, determinism, predictable cost, and calibrated honesty.*

---

## 1. How It Works

Each conversation turn follows a deterministic, 6-stage lifecycle:

```text
[User Prompt + Client Timezone]
            │
            ▼
┌────────────────────────────────────────┐
│ 1. Deterministic Temporal Grounding    │  resolveDates(message, now, tz)
│    - Resolves "Monday", "3 Nov", etc.  │  via chrono-node with forwardDate=false
└───────────────────┬────────────────────┘
                    │
                    ▼
┌────────────────────────────────────────┐
│ 2. Context Assembly in Code (SQLite)   │  Extracts:
│    - Active conversation window        │  - Matched turns for resolved dates
│    - Past conversation digests         │  - Verbatim Q&A + cited sources
│    - Flag missing records if asked     │  - Calibrated honesty notice if absent
└───────────────────┬────────────────────┘
                    │
                    ▼
┌────────────────────────────────────────┐
│ 3. Grounded Prompt Assembly            │  System prompt + temporal anchor
│    - Injects current ISO, weekday, tz  │  + prompt-cacheable invariant rules
└───────────────────┬────────────────────┘
                    │
                    ▼
┌────────────────────────────────────────┐
│ 4. Single-Agent Bounded Loop           │  Model evaluates if search needed:
│    - Skip: chit-chat & stable facts    │  - If needed: emits ONE parallel tool call
│    - Search: web_search({queries, ...})│  - Loop hard-capped at <= 4 rounds
└───────────────────┬────────────────────┘
                    │
                    ▼
┌────────────────────────────────────────┐
│ 5. Tool Fanout & Result Compaction     │  Tavily API with parallel fan-out:
│    - Multi-query parallel execution    │  - In-memory LRU cache (10 min TTL)
│    - Dedupe URLs & filter spam domains │  - Compact snippets (~320 chars)
│    - Attach published_date & domain    │  - Structured fallback on timeout
└───────────────────┬────────────────────┘
                    │
                    ▼
┌────────────────────────────────────────┐
│ 6. Streaming SSE & Async Persistence   │  - Tokens stream from byte 1
│    - Numbered inline citations [1]     │  - Persist user & assistant turns
│    - Save claims & source URLs         │  - Async background conversation summary
└────────────────────────────────────────┘
```

---

## 2. Key Decisions & Justifications

1. **Memory and Time Handled in Code, Not via Tools:**
   The specification strictly permits exactly one tool: `web_search`. Even if allowed, delegating date calculation or history lookup to an LLM tool introduces latency, round-trips, and hallucination risk. Humans struggle with calendar math; LLMs are notoriously unreliable at mapping "last Tuesday" to concrete calendar dates. By running `resolveDates()` in pure TypeScript via `chrono-node` with `forwardDate: false`, temporal grounding is deterministic, testable, and runs in sub-millisecond time.

2. **Single Bounded Loop vs. Multi-Agent Orchestration:**
   I rejected multi-agent architectures (orchestrator-worker, critic-agent, planner-executor). In an agent whose sole operational capability is web search, multi-agent frameworks add multiple LLM hops, serialization overhead, non-deterministic failure modes, and 3–5x latency. A single, well-prompted model with a hard-bounded loop ($\le 4$ steps) streaming via Vercel AI SDK achieves superior responsiveness and predictability.

3. **Multi-Query Tool Schema for Parallel Fanout:**
   Instead of `web_search({ query: string })` which forces the model to search sequentially across multiple turns, I designed `web_search({ queries: string[], since?: string, topic?: 'general'|'news' })`. When the user asks "Has any of our 5 shortlisted CRM tools changed pricing since Monday?", the model emits all 5 entity queries in a single step. The server resolves them concurrently via `Promise.allSettled`, cutting round-trip latency from 5 serial round-trips down to 1.

4. **Server-Side Post-Processing and Result Compaction:**
   Raw search outputs are the single largest source of latency and token burn. Before results touch the model context, the engine:
   - Deduplicates identical URLs across parallel queries.
   - Truncates snippets to a compact ~320 characters while preserving sentence boundaries.
   - Drops low-quality scraper and aggregator domains (e.g., Pinterest, coupon farms).
   - Extracts published dates and root domains to assist temporal grounding.

5. **Zero-Config Persistent Storage (SQLite via `node:sqlite`):**
   Using Node 24’s built-in `node:sqlite` provides zero-config, native SQLite storage with zero native compile issues across platforms. Messages, cited source URLs, and timestamps persist across restarts.

6. **Asynchronous Conversation Summaries:**
   Generating past conversation digests synchronously on every turn slows down Time-to-First-Token (TTFT). Instead, I trigger conversation summaries via `setImmediate()` in the background after turns complete. The user gets their answer immediately, while future turns benefit from pre-computed digests.

---

## 3. Considered and Rejected

- **Multi-Agent / Planner-Worker Architectures (LangGraph, CrewAI):** Rejected. They introduce heavy indirection, unpredictable branching, and high token costs for a single-tool domain.
- **Vector Database / Embedding Retrieval for History:** Rejected. The core access pattern here is temporal: "What did I ask on Monday?", "What changed since 3 November?". Vector embeddings are fuzzy and temporal-blind; a cosine search over embeddings often matches semantic similarity while pulling the wrong date. Structured SQL queries filtering by `created_at` are exact, instantaneous, and zero-cost.
- **A Model-Callable Memory Tool:** Rejected. Violates the single-tool constraint and adds unnecessary tool round-trips when conversation history can be prepared deterministically prior to inference.
- **Fetching Full Web Pages for Every Search Result:** Rejected. Full scraping adds 2–4 seconds per URL and introduces scraper blocking/bot gates. Compact snippet extraction paired with Tavily's search depth is 10x faster and fits within tight latency budgets.
- **Cross-Encoder Reranker:** Rejected. For 3–5 parallel entity queries with top-3 extraction, a reranker adds 200–400ms latency with marginal relevance gains.

---

## 4. Known Weaknesses

- **Date Ambiguity in Spoken English:** Phrases like "last Tuesday" are inherently ambiguous (can mean the most recent Tuesday, or Tuesday of the previous calendar week). My engine defaults to the most recent past occurrence, records both candidate dates, and notes the assumption in the prompt.
- **Search Provider Index Freshness:** If a SaaS provider quietly updates pricing without an official blog post or changelog entry, search engines may take days to re-index. The prompt mitigates this by instructing the agent to differentiate "confirmed unchanged" from "no evidence of change in public sources".
- **Summary Drift:** As conversation digests compress past turns, nuanced claims could be omitted over long horizons. Storing raw message records alongside pre-computed digests mitigates this.

---

## 5. What I'd Do With Another Week

1. **Claim-Level Re-Verification Store:** Store past assistant assertions as atomic claims (e.g., `{ entity: "HubSpot", claim: "pricing", value: "$100/seat/mo", verified_at: "2026-11-09" }`). When asked "is it still correct?", query and compare the exact claim values programmatically.
2. **Selective Page Scraper for Pricing Tables:** For verified pricing queries, invoke a specialized headless DOM extractor targeting `table` and `pricing-card` elements on official domains only.
3. **Speculative Parallel Search:** Predict likely entity searches from the user's initial input streaming while the model begins its initial reasoning phase.
4. **Hybrid Embedding Fallback:** Retain strict SQL temporal lookups for date queries, with embedding search as a fallback exclusively for fuzzy associative queries (e.g., "that database you liked last month").
5. **LLM-as-a-Judge Eval Suite:** Expand the 12-case deterministic evaluation suite with automated multi-turn rubric grading across varying synthetic temporal timelines.

