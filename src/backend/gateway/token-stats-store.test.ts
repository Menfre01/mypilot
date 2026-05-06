import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TokenStatsStore, parseBrand } from './token-stats-store.js';

function getLocalDate(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

const TODAY = getLocalDate();
const YESTERDAY = getLocalDate(new Date(Date.now() - 86400000));
const THREE_DAYS_AGO = getLocalDate(new Date(Date.now() - 3 * 86400000));
const TEN_DAYS_AGO = getLocalDate(new Date(Date.now() - 10 * 86400000));

describe('parseBrand', () => {
  it('identifies known brands', () => {
    expect(parseBrand('claude-sonnet-4-20250514')).toBe('anthropic');
    expect(parseBrand('deepseek-chat')).toBe('deepseek');
    expect(parseBrand('gpt-4o')).toBe('openai');
    expect(parseBrand('gemini-pro')).toBe('google');
    expect(parseBrand('mimo-v2.5-pro')).toBe('xiaomi');
    expect(parseBrand('glm-4')).toBe('zhipu');
    expect(parseBrand('kimi-1.5')).toBe('moonshot');
    expect(parseBrand('llama-3')).toBe('unknown');
  });
});

describe('TokenStatsStore', () => {
  let tmpDir: string;
  let store: TokenStatsStore;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'token-stats-test-'));
    store = new TokenStatsStore(tmpDir);
  });

  afterEach(() => {
    store.flush();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns empty stats on first run', () => {
    const stats = store.getStats('today');
    expect(stats.records).toEqual({});
  });

  it('records and retrieves single entry', () => {
    store.record(TODAY, 'anthropic', 'model-a', {
      input: 100, output: 200, cacheRead: 50, cacheCreation: 10,
    });

    const stats = store.getStats('today');
    expect(stats.records[TODAY]!['anthropic']!['model-a']!.input).toBe(100);
    expect(stats.records[TODAY]!['anthropic']!['model-a']!.output).toBe(200);
  });

  it('aggregates same (date, brand, model)', () => {
    store.record(TODAY, 'anthropic', 'model-b', {
      input: 100, output: 200, cacheRead: 50, cacheCreation: 10,
    });
    store.record(TODAY, 'anthropic', 'model-b', {
      input: 300, output: 400, cacheRead: 0, cacheCreation: 0,
    });

    const stats = store.getStats('today');
    const entry = stats.records[TODAY]!['anthropic']!['model-b']!;
    expect(entry.input).toBe(400);
    expect(entry.output).toBe(600);
    expect(entry.cacheRead).toBe(50);
  });

  it('keeps different models separate', () => {
    store.record(TODAY, 'anthropic', 'model-x', {
      input: 100, output: 200, cacheRead: 0, cacheCreation: 0,
    });
    store.record(TODAY, 'anthropic', 'model-y', {
      input: 500, output: 600, cacheRead: 0, cacheCreation: 0,
    });

    const stats = store.getStats('today');
    expect(stats.records[TODAY]!['anthropic']!['model-x']!.input).toBe(100);
    expect(stats.records[TODAY]!['anthropic']!['model-y']!.input).toBe(500);
  });

  it('persists and loads from disk', () => {
    store.record(TODAY, 'anthropic', 'model-z', {
      input: 100, output: 200, cacheRead: 0, cacheCreation: 0,
    });
    store.flush();

    const store2 = new TokenStatsStore(tmpDir);
    const stats = store2.getStats('today');
    expect(stats.records[TODAY]!['anthropic']!['model-z']!.input).toBe(100);
  });

  it('getStats today returns only today', () => {
    store.record(TODAY, 'a', 'm', { input: 1, output: 0, cacheRead: 0, cacheCreation: 0 });
    store.flush();

    // Record yesterday in a separate store
    const store2 = new TokenStatsStore(tmpDir);
    store2.record(YESTERDAY, 'a', 'm', { input: 2, output: 0, cacheRead: 0, cacheCreation: 0 });
    store2.flush();

    const store3 = new TokenStatsStore(tmpDir);
    const stats = store3.getStats('today');
    expect(Object.keys(stats.records)).toEqual([TODAY]);
  });

  it('getStats week returns last 7 days', () => {
    store.record(TODAY, 'a', 'm', { input: 1, output: 0, cacheRead: 0, cacheCreation: 0 });
    store.record(THREE_DAYS_AGO, 'a', 'm', { input: 2, output: 0, cacheRead: 0, cacheCreation: 0 });
    store.record(TEN_DAYS_AGO, 'a', 'm', { input: 3, output: 0, cacheRead: 0, cacheCreation: 0 });

    const stats = store.getStats('week');
    expect(Object.keys(stats.records)).toContain(TODAY);
    expect(Object.keys(stats.records)).toContain(THREE_DAYS_AGO);
    expect(Object.keys(stats.records)).not.toContain(TEN_DAYS_AGO);
  });
});
