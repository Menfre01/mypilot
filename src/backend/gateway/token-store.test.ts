import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getOrCreateToken, detectLanIP } from './token-store.js';

describe('token-store', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mypilot-token-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('getOrCreateToken', () => {
    it('creates a new token if none exists', () => {
      const token = getOrCreateToken(tmpDir);
      expect(token).toBeTruthy();
      expect(typeof token).toBe('string');
      expect(token.length).toBeGreaterThan(0);
    });

    it('persists token to file', () => {
      const token = getOrCreateToken(tmpDir);
      const tokenPath = join(tmpDir, 'token');
      expect(existsSync(tokenPath)).toBe(true);
      expect(readFileSync(tokenPath, 'utf-8').trim()).toBe(token);
    });

    it('returns existing token on subsequent calls', () => {
      const token1 = getOrCreateToken(tmpDir);
      const token2 = getOrCreateToken(tmpDir);
      expect(token1).toBe(token2);
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
