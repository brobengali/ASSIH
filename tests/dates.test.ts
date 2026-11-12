import { test, describe } from 'node:test';
import assert from 'node:assert';
import { resolveDates, formatYMD, formatWeekday } from '../server/dates.js';

describe('resolveDates temporal grounding', () => {
  // Reference date: Thursday, November 12, 2026 at 12:00:00 UTC
  const fixedNow = new Date('2026-11-12T12:00:00.000Z');

  test('resolves "On Monday" to most recent past Monday', () => {
    const res = resolveDates('On Monday we shortlisted 5 CRM tools for a 20-person sales team', fixedNow, 'UTC');
    assert.strictEqual(res.nowFormatted, '2026-11-12 (Thu)');
    assert.ok(res.resolved.length >= 1);
    const match = res.resolved.find(r => r.expression.toLowerCase().includes('monday'));
    assert.ok(match, 'Should find Monday expression');
    assert.strictEqual(match.isoDate, '2026-11-09');
    assert.strictEqual(match.weekday, 'Mon');
    assert.ok(match.assumption?.includes('Resolved to most recent past Mon'));
  });

  test('resolves absolute date "on 3 November"', () => {
    const res = resolveDates('What did I ask you on 3 November? Is your answer still correct today?', fixedNow, 'UTC');
    const match = res.resolved.find(r => r.expression.toLowerCase().includes('3 november'));
    assert.ok(match, 'Should find 3 November');
    assert.strictEqual(match.isoDate, '2026-11-03');
    assert.strictEqual(match.weekday, 'Tue');
  });

  test('resolves "Last Tuesday" with ambiguity note', () => {
    const res = resolveDates('Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?', fixedNow, 'UTC');
    const match = res.resolved.find(r => r.expression.toLowerCase().includes('last tuesday'));
    assert.ok(match, 'Should find Last Tuesday');
    // Nov 10 is the immediate past Tuesday, Nov 3 is Tuesday of previous week
    assert.strictEqual(match.isoDate, '2026-11-10');
    assert.strictEqual(match.weekday, 'Tue');
    assert.ok(match.alternativeIsoDate === '2026-11-03', 'Should provide 2026-11-03 as alternate interpretation');
  });

  test('resolves "since then" when priorTurnDate is provided', () => {
    const res = resolveDates('Has any pricing changed since then?', fixedNow, 'UTC', '2026-11-03T10:00:00Z');
    const match = res.resolved.find(r => r.expression === 'since then');
    assert.ok(match, 'Should resolve since then');
    assert.strictEqual(match.isoDate, '2026-11-03');
    assert.strictEqual(match.weekday, 'Tue');
  });

  test('resolves "yesterday"', () => {
    const res = resolveDates('Did we talk yesterday about Redis?', fixedNow, 'UTC');
    const match = res.resolved.find(r => r.expression.toLowerCase().includes('yesterday'));
    assert.ok(match);
    assert.strictEqual(match.isoDate, '2026-11-11');
    assert.strictEqual(match.weekday, 'Wed');
  });

  test('generates structured promptBlock with assumptions', () => {
    const res = resolveDates('On Monday we talked about Stripe', fixedNow, 'UTC');
    assert.ok(res.promptBlock.includes('### Resolved Dates'));
    assert.ok(res.promptBlock.includes('2026-11-09 (Mon)'));
  });

  test('formats timezone correctly', () => {
    const ymd = formatYMD(fixedNow, 'America/New_York');
    assert.strictEqual(ymd, '2026-11-12');
  });
});

