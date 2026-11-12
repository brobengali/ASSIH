import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

export interface SourceCitation {
  title: string;
  url: string;
  snippet?: string;
  publishedDate?: string;
  domain?: string;
  citedClaims?: string[];
}

export interface StoredMessage {
  id: string;
  conversation_id: string;
  user_id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  sources_json: string | null;
  created_at: string; // ISO 8601
  sources?: SourceCitation[];
}

export interface ConversationMeta {
  id: string;
  user_id: string;
  title: string;
  summary: string | null;
  created_at: string;
  updated_at: string;
}

export interface PastConversationDigestItem {
  id: string;
  title: string;
  date: string; // YYYY-MM-DD
  userQuestions: string[];
  summary: string;
}

export interface RelevantHistoryTurn {
  conversationId: string;
  date: string;
  userQuestion: string;
  assistantAnswer: string;
  sources?: SourceCitation[];
}

export class MemoryStore {
  private db: DatabaseSync;

  constructor(dbPath: string = 'data/chat.db') {
    if (dbPath !== ':memory:') {
      const dir = path.dirname(dbPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    }
    this.db = new DatabaseSync(dbPath);
    this.init();
  }

  private init() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        title TEXT,
        summary TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        sources_json TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY(conversation_id) REFERENCES conversations(id)
      );

      CREATE INDEX IF NOT EXISTS idx_conv_user ON conversations(user_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_msg_conv ON messages(conversation_id, created_at ASC);
      CREATE INDEX IF NOT EXISTS idx_msg_user_date ON messages(user_id, created_at);
    `);
  }

  public ensureConversation(id: string, userId: string, title: string = 'New Conversation', createdAt?: string): ConversationMeta {
    const now = createdAt || new Date().toISOString();
    const existing = this.db.prepare('SELECT * FROM conversations WHERE id = ?').get(id) as unknown as ConversationMeta | undefined;
    if (existing) {
      return existing;
    }

    this.db.prepare(`
      INSERT INTO conversations (id, user_id, title, summary, created_at, updated_at)
      VALUES (?, ?, ?, NULL, ?, ?)
    `).run(id, userId, title, now, now);

    return {
      id,
      user_id: userId,
      title,
      summary: null,
      created_at: now,
      updated_at: now,
    };
  }

  public updateConversationTitle(id: string, title: string) {
    this.db.prepare('UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?').run(title, new Date().toISOString(), id);
  }

  public updateConversationSummary(id: string, summary: string) {
    this.db.prepare('UPDATE conversations SET summary = ?, updated_at = ? WHERE id = ?').run(summary, new Date().toISOString(), id);
  }

  public saveMessage(msg: {
    id: string;
    conversationId: string;
    userId: string;
    role: 'user' | 'assistant' | 'system';
    content: string;
    sources?: SourceCitation[];
    createdAt?: string;
  }): StoredMessage {
    const createdAt = msg.createdAt || new Date().toISOString();
    this.ensureConversation(msg.conversationId, msg.userId, 'New Conversation', createdAt);

    const sourcesJson = msg.sources && msg.sources.length > 0 ? JSON.stringify(msg.sources) : null;

    this.db.prepare(`
      INSERT INTO messages (id, conversation_id, user_id, role, content, sources_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(msg.id, msg.conversationId, msg.userId, msg.role, msg.content, sourcesJson, createdAt);

    this.db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(createdAt, msg.conversationId);

    // If first user message, update title
    if (msg.role === 'user') {
      const conv = this.db.prepare('SELECT title FROM conversations WHERE id = ?').get(msg.conversationId) as unknown as { title: string } | undefined;
      if (conv && conv.title === 'New Conversation') {
        const titleSnippet = msg.content.trim().slice(0, 40) + (msg.content.length > 40 ? '...' : '');
        this.updateConversationTitle(msg.conversationId, titleSnippet);
      }
    }

    return {
      id: msg.id,
      conversation_id: msg.conversationId,
      user_id: msg.userId,
      role: msg.role,
      content: msg.content,
      sources_json: sourcesJson,
      created_at: createdAt,
      sources: msg.sources,
    };
  }

  public getConversationMessages(conversationId: string, limit: number = 50): StoredMessage[] {
    const rows = this.db.prepare(`
      SELECT * FROM messages 
      WHERE conversation_id = ? 
      ORDER BY created_at ASC 
      LIMIT ?
    `).all(conversationId, limit) as unknown as StoredMessage[];

    return rows.map(r => ({
      ...r,
      sources: r.sources_json ? JSON.parse(r.sources_json) : undefined,
    }));
  }

  public listUserConversations(userId: string): ConversationMeta[] {
    return this.db.prepare(`
      SELECT * FROM conversations 
      WHERE user_id = ? 
      ORDER BY updated_at DESC
    `).all(userId) as unknown as ConversationMeta[];
  }

  /**
   * Builds the "Past conversations" digest for this user:
   * for each earlier conversation, date + user's questions + 1–2 line summary of the answer given
   */
  public getUserPastConversationsDigest(userId: string, currentConversationId?: string): PastConversationDigestItem[] {
    const convs = this.db.prepare(`
      SELECT * FROM conversations 
      WHERE user_id = ? AND id != ?
      ORDER BY created_at DESC 
      LIMIT 15
    `).all(userId, currentConversationId || '') as unknown as ConversationMeta[];

    const digest: PastConversationDigestItem[] = [];

    for (const conv of convs) {
      const msgs = this.getConversationMessages(conv.id, 20);
      const userQuestions = msgs.filter(m => m.role === 'user').map(m => m.content.trim());
      
      let summary = conv.summary;
      if (!summary) {
        // Fallback fast heuristic summary if async summary has not populated yet
        const lastAssistantMsg = msgs.filter(m => m.role === 'assistant').pop();
        if (lastAssistantMsg) {
          const firstSentence = lastAssistantMsg.content.split('\n')[0].slice(0, 150);
          summary = firstSentence + (lastAssistantMsg.content.length > 150 ? '...' : '');
        } else {
          summary = 'Discussion in progress.';
        }
      }

      digest.push({
        id: conv.id,
        title: conv.title,
        date: conv.created_at.slice(0, 10),
        userQuestions,
        summary: summary || 'No summary available.',
      });
    }

    return digest;
  }

  /**
   * If resolveDates found a date matching past conversations, or if user references a specific topic,
   * extract those conversations' full relevant turns (the user question AND the answer given, including sources)
   */
  public findRelevantTurns(
    userId: string,
    currentConversationId: string | undefined,
    options: { targetDates?: string[]; keywords?: string[] }
  ): RelevantHistoryTurn[] {
    const results: RelevantHistoryTurn[] = [];
    const targetDates = (options.targetDates || []).filter(Boolean);
    const keywords = (options.keywords || []).filter(k => k.length > 2);

    if (targetDates.length === 0 && keywords.length === 0) {
      return results;
    }

    // Find candidate conversations
    const convs = this.db.prepare(`
      SELECT id, created_at FROM conversations 
      WHERE user_id = ? AND id != ?
    `).all(userId, currentConversationId || '') as unknown as Array<{ id: string; created_at: string }>;

    for (const conv of convs) {
      const msgs = this.getConversationMessages(conv.id, 40);
      for (let i = 0; i < msgs.length; i++) {
        const msg = msgs[i];
        if (msg.role === 'user') {
          const msgDate = msg.created_at.slice(0, 10);
          const dateMatch = targetDates.some(td => td === msgDate);
          
          let keywordMatch = false;
          if (keywords.length > 0) {
            const lowerContent = msg.content.toLowerCase();
            keywordMatch = keywords.some(k => lowerContent.includes(k.toLowerCase()));
          }

          if (dateMatch || keywordMatch) {
            // Pair with the subsequent assistant answer if available
            const nextMsg = msgs[i + 1];
            const answer = nextMsg && nextMsg.role === 'assistant' ? nextMsg.content : '(No recorded answer)';
            const sources = nextMsg && nextMsg.sources ? nextMsg.sources : undefined;

            results.push({
              conversationId: conv.id,
              date: msgDate,
              userQuestion: msg.content,
              assistantAnswer: answer,
              sources,
            });
          }
        }
      }
    }

    return results;
  }

  /**
   * Async summarizer run in background after a conversation turn completes.
   * Costs zero user-facing latency.
   */
  public async scheduleAsyncSummary(conversationId: string, modelCaller?: (prompt: string) => Promise<string>) {
    setImmediate(async () => {
      try {
        const msgs = this.getConversationMessages(conversationId, 20);
        if (msgs.length < 2) return;

        if (modelCaller) {
          const dialog = msgs.map(m => `${m.role.toUpperCase()}: ${m.content}`).join('\n');
          const prompt = `Summarize this conversation turn in 1-2 concise sentences for quick memory retrieval:\n${dialog}\n\nSummary:`;
          const summary = await modelCaller(prompt);
          if (summary) {
            this.updateConversationSummary(conversationId, summary.trim());
            return;
          }
        }

        // Fast fallback heuristic
        const userMsgs = msgs.filter(m => m.role === 'user');
        const assistantMsgs = msgs.filter(m => m.role === 'assistant');
        const lastUser = userMsgs[userMsgs.length - 1]?.content.slice(0, 60);
        const lastAns = assistantMsgs[assistantMsgs.length - 1]?.content.split('\n')[0].slice(0, 100);
        this.updateConversationSummary(conversationId, `User asked about "${lastUser}". Addressed: ${lastAns}`);
      } catch (err) {
        console.error('Async summary error (non-fatal):', err);
      }
    });
  }

  public close() {
    this.db.close();
  }
}

