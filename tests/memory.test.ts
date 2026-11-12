import { test, describe } from 'node:test';
import assert from 'node:assert';
import { MemoryStore } from '../server/memory.js';

describe('MemoryStore SQLite persistent conversation memory', () => {
  test('persists messages, sources, and retrieves history', () => {
    const store = new MemoryStore(':memory:');
    const userId = 'user_123';
    const convId = 'conv_1';

    store.saveMessage({
      id: 'm1',
      conversationId: convId,
      userId,
      role: 'user',
      content: 'On Monday we shortlisted 5 CRM tools for a 20-person sales team.',
      createdAt: '2026-11-09T10:00:00Z',
    });

    store.saveMessage({
      id: 'm2',
      conversationId: convId,
      userId,
      role: 'assistant',
      content: 'Here are 5 top CRMs for 20 reps: HubSpot, Salesforce, Pipedrive, Close, and Zoho.',
      sources: [
        { title: 'CRM Comparison', url: 'https://example.com/crm', citedClaims: ['HubSpot costs $50/mo'] }
      ],
      createdAt: '2026-11-09T10:01:00Z',
    });

    const msgs = store.getConversationMessages(convId);
    assert.strictEqual(msgs.length, 2);
    assert.strictEqual(msgs[0].content, 'On Monday we shortlisted 5 CRM tools for a 20-person sales team.');
    assert.strictEqual(msgs[1].sources?.[0].title, 'CRM Comparison');
    assert.strictEqual(msgs[1].sources?.[0].citedClaims?.[0], 'HubSpot costs $50/mo');

    // Test past conversations digest from another conversation
    const digest = store.getUserPastConversationsDigest(userId, 'conv_2');
    assert.strictEqual(digest.length, 1);
    assert.strictEqual(digest[0].id, convId);
    assert.strictEqual(digest[0].date, '2026-11-09');
    assert.ok(digest[0].userQuestions[0].includes('shortlisted 5 CRM'));

    // Test findRelevantTurns by date (2026-11-09)
    const relevant = store.findRelevantTurns(userId, 'conv_2', { targetDates: ['2026-11-09'] });
    assert.strictEqual(relevant.length, 1);
    assert.strictEqual(relevant[0].date, '2026-11-09');
    assert.ok(relevant[0].assistantAnswer.includes('HubSpot, Salesforce'));
    assert.strictEqual(relevant[0].sources?.[0].url, 'https://example.com/crm');

    // Test honesty scenario: date with no match returns empty
    const noMatch = store.findRelevantTurns(userId, 'conv_2', { targetDates: ['2026-10-14'] });
    assert.strictEqual(noMatch.length, 0);

    store.close();
  });
});

