import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadLinksConfig, saveLinksConfig, createDefaultLink } from './link-config.js';

const testDir = join(tmpdir(), 'mypilot-link-config-test');

beforeEach(() => {
  mkdirSync(testDir, { recursive: true });
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

describe('link-config', () => {
  describe('createDefaultLink', () => {
    it('creates a LAN link with ws://host:port', () => {
      const link = createDefaultLink('192.168.1.100', 16321);
      expect(link).toEqual({
        id: 'lan-default',
        type: 'lan',
        label: 'LAN Direct',
        url: 'ws://192.168.1.100:16321',
        enabled: true,
      });
    });
  });

  describe('loadLinksConfig', () => {
    it('creates default config when no file exists', () => {
      const links = loadLinksConfig(testDir, '10.0.0.1', 8080);
      expect(links).toHaveLength(1);
      expect(links[0]).toEqual({
        id: 'lan-default',
        type: 'lan',
        label: 'LAN Direct',
        url: 'ws://10.0.0.1:8080',
        enabled: true,
      });
    });

    it('persists default config to disk', () => {
      loadLinksConfig(testDir, '10.0.0.1', 8080);
      const raw = readFileSync(join(testDir, 'links.json'), 'utf-8');
      const data = JSON.parse(raw);
      expect(data.links).toHaveLength(1);
    });

    it('loads existing config from file', () => {
      const existing = {
        links: [
          { id: 'lan-default', type: 'lan' as const, label: 'LAN', url: 'ws://10.0.0.1:8080', enabled: true },
          { id: 'tunnel-1', type: 'tunnel' as const, label: 'ngrok', url: 'wss://abc.ngrok-free.app', enabled: true },
        ],
      };
      saveLinksConfig(testDir, existing.links);
      const links = loadLinksConfig(testDir, '10.0.0.1', 8080);
      expect(links).toHaveLength(2);
      expect(links[1]!.type).toBe('tunnel');
    });

    it('normalizes partial link data', () => {
      const partial = [
        { id: 'tunnel-x', type: 'tunnel' as const, url: 'wss://example.com' },
      ];
      saveLinksConfig(testDir, partial as any);
      const links = loadLinksConfig(testDir, '10.0.0.1', 8080);
      expect(links).toHaveLength(1);
      expect(links[0]!.label).toBe('tunnel');
      expect(links[0]!.enabled).toBe(true);
    });
  });

  describe('saveLinksConfig', () => {
    it('writes valid JSON with links array', () => {
      const links = [
        createDefaultLink('192.168.1.100', 16321),
        { id: 'tunnel-1', type: 'tunnel' as const, label: 'ngrok', url: 'wss://abc.ngrok-free.app', enabled: true },
      ];
      saveLinksConfig(testDir, links);
      const raw = readFileSync(join(testDir, 'links.json'), 'utf-8');
      const data = JSON.parse(raw);
      expect(data.links).toHaveLength(2);
    });
  });
});
