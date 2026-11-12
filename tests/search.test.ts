import { test, describe } from 'node:test';
import assert from 'node:assert';
import { SearchEngine } from '../server/search.js';

describe('SearchEngine multi-query parallel tool', () => {
  test('executes queries in parallel, dedupes URLs, and trims snippets', async () => {
    const engine = new SearchEngine('dummy_key');

    let callCount = 0;
    engine.setMockHandler(async (query: string) => {
      callCount++;
      return [
        {
          title: `${query} Official`,
          url: 'https://example.com/shared-page',
          snippet: 'Very long text '.repeat(50),
          domain: 'example.com',
          query,
        },
        {
          title: `${query} Specific`,
          url: `https://${query.toLowerCase().replace(/[^a-z0-9]/g, '')}.com/pricing`,
          snippet: 'Pricing details for 20 reps',
          domain: `${query.toLowerCase().replace(/[^a-z0-9]/g, '')}.com`,
          query,
        },
        {
          title: 'Spam Result',
          url: 'https://pinterest.com/pin/12345',
          snippet: 'Spam pin',
          domain: 'pinterest.com',
          query,
        },
      ];
    });

    const output = await engine.executeSearch({
      queries: ['HubSpot CRM', 'Salesforce CRM'],
      since: '2026-11-09',
    });

    assert.strictEqual(output.queriedCount, 2);
    // 2 queries fired
    assert.strictEqual(callCount, 2);
    // 'https://example.com/shared-page' appeared in both queries, must be deduplicated
    const sharedCount = output.results.filter(r => r.url === 'https://example.com/shared-page').length;
    assert.strictEqual(sharedCount, 1, 'Shared URL must be deduplicated');

    // Spam domain (pinterest.com) must be excluded
    const spam = output.results.find(r => r.domain === 'pinterest.com');
    assert.strictEqual(spam, undefined, 'Low-quality domain must be filtered');

    // Snippet must be trimmed
    const first = output.results[0];
    assert.ok(first.snippet.length <= 330, 'Snippet must be compacted');

    // Cache test: re-query should hit cache without calling mock handler
    const prevCalls = callCount;
    await engine.executeSearch({
      queries: ['HubSpot CRM'],
      since: '2026-11-09',
    });
    assert.strictEqual(callCount, prevCalls, 'Cached query must not invoke search again');
  });

  test('handles failed individual query gracefully with warning', async () => {
    const engine = new SearchEngine('dummy_key');
    engine.setMockHandler(async (query: string) => {
      if (query.includes('Broken')) {
        throw new Error('Connection timeout');
      }
      return [
        {
          title: 'Good Result',
          url: 'https://good.com',
          snippet: 'Valid snippet',
          domain: 'good.com',
          query,
        },
      ];
    });

    const output = await engine.executeSearch({
      queries: ['Good Query', 'Broken Query'],
    });

    assert.strictEqual(output.queriedCount, 2);
    assert.strictEqual(output.results.length, 1);
    assert.ok(output.warnings && output.warnings.length === 1);
    assert.ok(output.warnings[0].includes('Broken Query'));
  });
});

