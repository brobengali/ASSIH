import { streamText, tool, CoreMessage } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { resolveDates, DateResolutionResult } from './dates.js';
import { MemoryStore, SourceCitation, StoredMessage } from './memory.js';
import { SearchEngine, webSearchInputSchema, WebSearchOutput } from './search.js';
import { buildSystemPrompt } from './prompt.js';

export interface MockRunnerResult {
  text: string;
  toolCalls?: Array<{ queries: string[]; since?: string; topic?: 'general' | 'news' }>;
}

export interface AgentConfig {
  memoryStore: MemoryStore;
  searchEngine: SearchEngine;
  modelName?: string;
  apiKey?: string;
  baseURL?: string;
  mockRunner?: (prompt: string, toolsAvailable: boolean) => Promise<MockRunnerResult>;
}

export interface RunAgentParams {
  userId: string;
  conversationId: string;
  userMessage: string;
  clientTimezone?: string;
  clientNow?: Date; // Allows clock injection for tests/evals
  onEvent?: (event: AgentStreamEvent) => void;
}

export type AgentStreamEvent =
  | { type: 'status'; stage: 'grounding' | 'searching' | 'generating'; message: string }
  | { type: 'resolved_dates'; dates: DateResolutionResult['resolved'] }
  | { type: 'tool_call'; queries: string[]; since?: string }
  | { type: 'tool_result'; count: number; results: SourceCitation[] }
  | { type: 'text_delta'; delta: string }
  | { type: 'finish'; fullText: string; sources: SourceCitation[] }
  | { type: 'error'; error: string };

export class ChatAgent {
  private memory: MemoryStore;
  private searchEngine: SearchEngine;
  private modelName: string;
  private apiKey?: string;
  private baseURL?: string;
  private mockRunner?: (prompt: string, toolsAvailable: boolean) => Promise<MockRunnerResult>;

  constructor(config: AgentConfig) {
    this.memory = config.memoryStore;
    this.searchEngine = config.searchEngine;
    this.modelName = config.modelName || process.env.MODEL_NAME || 'gpt-4o-mini';
    this.apiKey = config.apiKey || process.env.OPENAI_API_KEY;
    this.baseURL = config.baseURL || process.env.OPENAI_BASE_URL;
    this.mockRunner = config.mockRunner;
  }

  public setMockRunner(runner?: (prompt: string, toolsAvailable: boolean) => Promise<MockRunnerResult>) {
    this.mockRunner = runner;
  }

  /**
   * Main turn execution loop:
   * 1. Deterministic temporal grounding via resolveDates()
   * 2. Context retrieval from SQLite (active turns, past digest, relevant turns)
   * 3. Construct grounded prompt
   * 4. Single-agent bounded tool loop with streaming SSE
   * 5. Record messages and cited sources to SQLite
   * 6. Trigger async summary in background
   */
  public async executeTurn(params: RunAgentParams): Promise<{ text: string; sources: SourceCitation[] }> {
    const { userId, conversationId, userMessage, clientTimezone = 'UTC', clientNow = new Date(), onEvent } = params;

    onEvent?.({ type: 'status', stage: 'grounding', message: 'Resolving dates and retrieving memory...' });

    // 1. Get recent messages in this conversation
    const activeMessages = this.memory.getConversationMessages(conversationId, 20);
    const priorTurn = activeMessages.filter(m => m.role === 'user').pop();
    const priorTurnDate = priorTurn?.created_at;

    // 2. Resolve dates deterministically
    const dateInfo = resolveDates(userMessage, clientNow, clientTimezone, priorTurnDate);
    if (dateInfo.resolved.length > 0) {
      onEvent?.({ type: 'resolved_dates', dates: dateInfo.resolved });
    }

    // 3. Find relevant past history matching resolved dates or key terms
    const targetDates = dateInfo.resolved.map(r => r.isoDate);
    if (dateInfo.resolved.some(r => r.alternativeIsoDate)) {
      targetDates.push(...dateInfo.resolved.map(r => r.alternativeIsoDate!).filter(Boolean));
    }

    // Extract potential entity keywords from query (e.g. CRM, Postgres, Redis, etc.)
    const keywordMatches = userMessage.match(/\b[A-Z][a-zA-Z0-9_-]+\b|\b(CRM|Postgres|PostgreSQL|MySQL|Redis|Supabase|Neon)\b/gi) || [];
    const relevantTurns = this.memory.findRelevantTurns(userId, conversationId, {
      targetDates,
      keywords: Array.from(new Set(keywordMatches)),
    });

    // Check if user referenced a specific date/past event but no record matched
    let userReferencedDateWithoutMatch: string | undefined;
    const hasPastReference = dateInfo.resolved.some(r => r.isRelativeWeekday || r.expression.toLowerCase().includes('last') || /\d{1,2}\s+[a-z]+/i.test(r.expression));
    if (hasPastReference && relevantTurns.length === 0) {
      userReferencedDateWithoutMatch = dateInfo.resolved.map(r => r.expression).join(', ');
    }

    // 4. Past conversations digest
    const pastDigest = this.memory.getUserPastConversationsDigest(userId, conversationId);

    // 5. Build system prompt
    const systemPrompt = buildSystemPrompt({
      dateInfo,
      recentMessages: activeMessages,
      pastDigest,
      relevantTurns,
      userReferencedDateWithoutMatch,
    });

    // Save user message to memory immediately
    const userMsgId = `usr_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    this.memory.saveMessage({
      id: userMsgId,
      conversationId,
      userId,
      role: 'user',
      content: userMessage,
      createdAt: clientNow.toISOString(),
    });

    // Format conversation history for model
    const coreMessages: CoreMessage[] = [];
    for (const msg of activeMessages) {
      if (msg.role === 'user' || msg.role === 'assistant') {
        coreMessages.push({
          role: msg.role,
          content: `[${msg.created_at}] ${msg.content}`,
        });
      }
    }
    coreMessages.push({
      role: 'user',
      content: `[${clientNow.toISOString()}] ${userMessage}`,
    });

    const accumulatedSources: SourceCitation[] = [];
    let fullText = '';

    // If mock runner is active (e.g. for offline evals / unit testing)
    if (this.mockRunner) {
      const mockResult = await this.mockRunner(userMessage, true);
      
      // Execute any simulated tool calls so the whole pipeline is exercised
      if (mockResult.toolCalls && mockResult.toolCalls.length > 0) {
        for (const tc of mockResult.toolCalls) {
          onEvent?.({
            type: 'status',
            stage: 'searching',
            message: `Searching ${tc.queries.length} queries in parallel...`,
          });
          onEvent?.({
            type: 'tool_call',
            queries: tc.queries,
            since: tc.since,
          });

          const output = await this.searchEngine.executeSearch(tc);
          const mappedSources: SourceCitation[] = output.results.map(r => ({
            title: r.title,
            url: r.url,
            snippet: r.snippet,
            publishedDate: r.publishedDate,
            domain: r.domain,
          }));

          for (const s of mappedSources) {
            if (!accumulatedSources.some(existing => existing.url === s.url)) {
              accumulatedSources.push(s);
            }
          }

          onEvent?.({
            type: 'tool_result',
            count: output.returnedCount,
            results: mappedSources,
          });
        }
      }

      fullText = mockResult.text;
      onEvent?.({ type: 'status', stage: 'generating', message: 'Generating response...' });
      onEvent?.({ type: 'text_delta', delta: fullText });
      onEvent?.({ type: 'finish', fullText, sources: accumulatedSources });

      const assistantMsgId = `asst_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      this.memory.saveMessage({
        id: assistantMsgId,
        conversationId,
        userId,
        role: 'assistant',
        content: fullText,
        sources: accumulatedSources,
        createdAt: new Date().toISOString(),
      });
      return { text: fullText, sources: accumulatedSources };
    }

    // Single tool: web_search
    const webSearchTool = tool({
      description:
        'Search the public web for up-to-date facts, pricing, documentation, and news. Can fan out multiple parallel queries.',
      parameters: webSearchInputSchema,
      execute: async (input) => {
        onEvent?.({
          type: 'status',
          stage: 'searching',
          message: `Searching ${input.queries.length} queries in parallel...`,
        });
        onEvent?.({
          type: 'tool_call',
          queries: input.queries,
          since: input.since,
        });

        const output: WebSearchOutput = await this.searchEngine.executeSearch(input);

        const mappedSources: SourceCitation[] = output.results.map(r => ({
          title: r.title,
          url: r.url,
          snippet: r.snippet,
          publishedDate: r.publishedDate,
          domain: r.domain,
        }));

        for (const s of mappedSources) {
          if (!accumulatedSources.some(existing => existing.url === s.url)) {
            accumulatedSources.push(s);
          }
        }

        onEvent?.({
          type: 'tool_result',
          count: output.returnedCount,
          results: mappedSources,
        });

        // Format search output cleanly for model
        return {
          resultsCount: output.returnedCount,
          sinceFilterApplied: output.sinceFilterApplied,
          results: output.results.map((r, i) => ({
            id: i + 1,
            title: r.title,
            url: r.url,
            publishedDate: r.publishedDate || 'Unknown',
            domain: r.domain,
            content: r.snippet,
          })),
          warnings: output.warnings,
        };
      },
    });

    if (!this.apiKey) {
      throw new Error('OPENAI_API_KEY is not configured. Please supply an API key in .env to use the live model.');
    }

    const openai = createOpenAI({
      apiKey: this.apiKey,
      baseURL: this.baseURL,
    });

    const modelInstance = openai(this.modelName);

    onEvent?.({ type: 'status', stage: 'generating', message: 'Generating response...' });

    // Stream model execution with bounded tool loop (max 4 steps)
    const result = streamText({
      model: modelInstance,
      system: systemPrompt,
      messages: coreMessages,
      tools: {
        web_search: webSearchTool,
      },
      maxSteps: 4, // Bounded loop
      temperature: 0.1, // Calibrated accuracy
    });

    for await (const part of result.fullStream) {
      if (part.type === 'text-delta') {
        fullText += part.textDelta;
        onEvent?.({ type: 'text_delta', delta: part.textDelta });
      }
    }

    onEvent?.({ type: 'finish', fullText, sources: accumulatedSources });

    // Persist assistant message with sources to SQLite
    const assistantMsgId = `asst_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    this.memory.saveMessage({
      id: assistantMsgId,
      conversationId,
      userId,
      role: 'assistant',
      content: fullText,
      sources: accumulatedSources,
      createdAt: new Date().toISOString(),
    });

    // Schedule async summary without delaying response
    this.memory.scheduleAsyncSummary(conversationId);

    return { text: fullText, sources: accumulatedSources };
  }
}
