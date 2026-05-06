import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TailerStateStore } from './tailer-state-store.js';

describe('TailerStateStore', () => {
  let tmpDir: string;
  let store: TailerStateStore;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'tailer-state-test-'));
    store = new TailerStateStore(tmpDir);
  });

  afterEach(() => {
    store.flush();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns undefined for unknown paths', () => {
    expect(store.getLastKnownSize('/unknown/path')).toBeUndefined();
  });

  it('stores and retrieves lastKnownSize', () => {
    store.setLastKnownSize('/path/to/transcript.jsonl', 1024);
    expect(store.getLastKnownSize('/path/to/transcript.jsonl')).toBe(1024);
  });

  it('overwrites existing value', () => {
    store.setLastKnownSize('/path/to/transcript.jsonl', 1024);
    store.setLastKnownSize('/path/to/transcript.jsonl', 2048);
    expect(store.getLastKnownSize('/path/to/transcript.jsonl')).toBe(2048);
  });

  it('persists and loads from disk', () => {
    store.setLastKnownSize('/path/to/transcript.jsonl', 1024);
    store.flush();

    const store2 = new TailerStateStore(tmpDir);
    expect(store2.getLastKnownSize('/path/to/transcript.jsonl')).toBe(1024);
  });

  it('removes an entry', () => {
    store.setLastKnownSize('/path/to/transcript.jsonl', 1024);
    store.remove('/path/to/transcript.jsonl');
    expect(store.getLastKnownSize('/path/to/transcript.jsonl')).toBeUndefined();
  });

  it('handles multiple paths independently', () => {
    store.setLastKnownSize('/path/a.jsonl', 100);
    store.setLastKnownSize('/path/b.jsonl', 200);
    expect(store.getLastKnownSize('/path/a.jsonl')).toBe(100);
    expect(store.getLastKnownSize('/path/b.jsonl')).toBe(200);
  });
});
