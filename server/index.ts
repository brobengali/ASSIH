import express from 'express';
import cors from 'cors';
import path from 'node:path';
import fs from 'node:fs';
import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import { MemoryStore } from './memory.js';
import { SearchEngine } from './search.js';
import { ChatAgent } from './agent.js';

// Load .env
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

const app = express();
const port = parseInt(process.env.PORT || '3000', 10);

app.use(cors());
app.use(express.json());

// Initialize SQLite store and Search Engine
const memoryStore = new MemoryStore(process.env.DB_PATH || 'data/chat.db');
const searchEngine = new SearchEngine(process.env.TAVILY_API_KEY);
const agent = new ChatAgent({
  memoryStore,
  searchEngine,
  modelName: process.env.MODEL_NAME || 'gpt-4o-mini',
  apiKey: process.env.OPENAI_API_KEY,
  baseURL: process.env.OPENAI_BASE_URL,
});

// API Routes

// 1. Health & Config check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    model: process.env.MODEL_NAME || 'gpt-4o-mini',
    hasOpenAIKey: Boolean(process.env.OPENAI_API_KEY),
    hasTavilyKey: Boolean(process.env.TAVILY_API_KEY),
    serverTime: new Date().toISOString(),
  });
});

// 2. List user conversations
app.get('/api/conversations', (req, res) => {
  const userId = (req.query.userId as string) || 'default_user';
  const conversations = memoryStore.listUserConversations(userId);
  res.json(conversations);
});

// 3. Create conversation
app.post('/api/conversations', (req, res) => {
  const userId = req.body.userId || 'default_user';
  const id = `conv_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const title = req.body.title || 'New Conversation';
  const conv = memoryStore.ensureConversation(id, userId, title);
  res.json(conv);
});

// 4. Get conversation messages
app.get('/api/conversations/:id/messages', (req, res) => {
  const messages = memoryStore.getConversationMessages(req.params.id);
  res.json(messages);
});

// 5. Streaming chat endpoint (SSE)
app.post('/api/chat', async (req, res) => {
  const { message, conversationId, userId, timezone } = req.body;

  if (!message || typeof message !== 'string') {
    res.status(400).json({ error: 'message is required' });
    return;
  }

  const effectiveUserId = userId || 'default_user';
  const effectiveConvId = conversationId || `conv_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const effectiveTz = timezone || 'UTC';

  // Set up SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  const sendEvent = (event: any) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  try {
    sendEvent({ type: 'init', conversationId: effectiveConvId });

    await agent.executeTurn({
      userId: effectiveUserId,
      conversationId: effectiveConvId,
      userMessage: message,
      clientTimezone: effectiveTz,
      clientNow: new Date(),
      onEvent: (event) => {
        sendEvent(event);
      },
    });

    sendEvent({ type: 'done' });
    res.end();
  } catch (err: any) {
    console.error('Chat execution error:', err);
    sendEvent({ type: 'error', error: err.message || 'Internal agent error' });
    res.end();
  }
});

// Serve frontend static files
const webPath = path.join(projectRoot, 'web');
if (fs.existsSync(webPath)) {
  app.use(express.static(webPath));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api')) return next();
    res.sendFile(path.join(webPath, 'index.html'));
  });
}

const server = app.listen(port, () => {
  console.log(`\n======================================================`);
  console.log(` Grounded Web Search Agent`);
  console.log(` Running on: http://localhost:${port}`);
  console.log(` Model:      ${process.env.MODEL_NAME || 'gpt-4o-mini'}`);
  console.log(` Tavily Key: ${process.env.TAVILY_API_KEY ? 'Configured' : 'MISSING (web search simulated or disabled)'}`);
  console.log(` OpenAI Key: ${process.env.OPENAI_API_KEY ? 'Configured' : 'MISSING (set in .env)'}`);
  console.log(`======================================================\n`);
});

export { app, server, memoryStore, searchEngine, agent };

