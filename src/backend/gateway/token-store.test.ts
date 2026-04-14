import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getOrCreateKey, detectLanIP } from './token-store.js';

describe('token-store', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mypilot-key-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('getOrCreateKey', () => {
    it('creates a 32-byte key if none exists', () => {
      const key = getOrCreateKey(tmpDir);
      expect(key).toBeInstanceOf(Buffer);
      expect(key.length).toBe(32);
    });

    it('persists key to file', () => {
      const key = getOrCreateKey(tmpDir);
      const keyPath = join(tmpDir, 'key');
      expect(existsSync(keyPath)).toBe(true);
      expect(readFileSync(keyPath)).toEqual(key);
    });

    it('returns existing key on subsequent calls', () => {
      const key1 = getOrCreateKey(tmpDir);
      const key2 = getOrCreateKey(tmpDir);
      expect(key1.equals(key2)).toBe(true);
    });
  });

  describe('detectLanIP', () => {
    it('returns a string', () => {
      const ip = detectLanIP();
      expect(typeof ip).toBe('string');
      expect(ip.length).toBeGreaterThan(0);
    });

    it('returns a valid IPv4 address format', () => {
      const ip = detectLanIP();
      expect(ip).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
    });
  });
});
