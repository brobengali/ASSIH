# Grounded Web Search Agent

A chat agent with **exactly one tool: web search**. 

Most search agents bloat their context with tool loops for math, dates, memory, and orchestration. This project takes the opposite approach: **handle time and memory deterministically in plain code**, and give the model a single, well-optimized parallel search tool.

It answers time-sensitive questions, remembers past discussions across sessions, verifies what changed since a given date, and honestly admits when it has no record of a past conversation.

---

## Quickstart

Get up and running in under a minute:

```bash
# 1. Install dependencies
npm install

# 2. Configure keys (Gemini / OpenAI + Tavily)
cp .env.example .env

# 3. Start the server and web UI
npm run dev
```

Open **`http://localhost:3000`** in your browser.

---

## Testing & Evals

```bash
# Run unit tests (dates, memory, search caching & filtering)
npm test

# Run the 12-case architectural eval suite
npm run eval
```

The eval suite tests real-world edge cases with an injectable clock:
- Relative weekday resolution (*"On Monday we shortlisted 5 CRM tools..."*)
- Anaphoric references (*"Has any pricing changed since then?"*)
- Zero-hallucination checks when no prior record exists
- Skipping web search for chit-chat and timeless facts
- Parallel multi-entity fanout in a single tool step
- Prompt-injection resistance against malicious search snippets

---

## How It's Built

- **Single Loop, One Tool:** Uses the Vercel AI SDK with a hard-capped 4-step loop. No LangChain or complex agent frameworks.
- **Deterministic Dates:** Relative expressions like *"last Tuesday"* or *"3 November"* are parsed in code via `chrono-node` with past-bias rules, not guessed by the LLM.
- **Persistent Memory:** Stored in local SQLite (`node:sqlite`) with zero external DB setup. Past turns and citations persist across restarts.
- **Parallel Fanout Search:** The `web_search` tool accepts multiple queries at once, fan-searching all entities simultaneously and compacting snippets before they hit the context window.
- **Model Agnostic:** Works out of the box with **Gemini 3.6 / 3.5**, OpenAI (`gpt-4o-mini`), Groq, or any OpenAI-compatible provider.

For full architectural reasoning and tradeoffs, read [DESIGN.md](DESIGN.md).
