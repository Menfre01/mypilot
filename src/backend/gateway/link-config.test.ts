import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  loadLinksConfig,
  saveLinksConfig,
  createDefaultLink,
} from './link-config.js';

describe('link-config', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mypilot-links-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('loadLinksConfig', () => {
    it('returns default LAN link when file does not exist', () => {
      const links = loadLinksConfig(tmpDir, '192.168.1.100', 16321);

      expect(links).toHaveLength(1);
      expect(links[0]).toEqual({
        id: 'lan-default',
        type: 'lan',
        label: 'LAN Direct',
        url: 'ws://192.168.1.100:16321',
        enabled: true,
      });

      // Should create the file
      const filePath = join(tmpDir, 'links.json');
      const content = readFileSync(filePath, 'utf-8');
      const data = JSON.parse(content);
      expect(data.links).toHaveLength(1);
    });

    it('parses valid config with multiple link types', () => {
      const filePath = join(tmpDir, 'links.json');
      const config = {
        links: [
          {
            id: 'lan-default',
            type: 'lan',
            label: 'Home LAN',
            url: 'ws://192.168.1.100:16321',
            enabled: true,
          },
          {
            id: 'ngrok-1',
            type: 'tunnel',
            label: 'ngrok Tunnel',
            url: 'wss://abc123.ngrok-free.app',
            enabled: true,
          },
          {
            id: 'wss-production',
            type: 'wss',
            label: 'Production WSS',
            url: 'wss://mypilot.example.com',
            enabled: false,
          },
        ],
      };
      writeFileSync(filePath, JSON.stringify(config, null, 2) + '\n', 'utf-8');

      const links = loadLinksConfig(tmpDir, '192.168.1.100', 16321);

      expect(links).toHaveLength(3);
      expect(links[0]).toEqual(config.links[0]);
      expect(links[1]).toEqual(config.links[1]);
      expect(links[2]).toEqual(config.links[2]);
    });

    it('handles corrupt JSON gracefully (falls back to default)', () => {
      const filePath = join(tmpDir, 'links.json');
      writeFileSync(filePath, '{ invalid json }', 'utf-8');

      const links = loadLinksConfig(tmpDir, '192.168.1.100', 16321);

      // Should return default link
      expect(links).toHaveLength(1);
      expect(links[0].id).toBe('lan-default');
      expect(links[0].type).toBe('lan');

      // Should overwrite the corrupt file with valid default
      const content = readFileSync(filePath, 'utf-8');
      expect(() => JSON.parse(content)).not.toThrow();
    });

    it('normalizes partial link data', () => {
      const filePath = join(tmpDir, 'links.json');
      const config = {
        links: [
          {
            id: 'test-1',
            type: 'tunnel',
            url: 'wss://test.example.com',
            // missing label and enabled
          },
        ],
      };
      writeFileSync(filePath, JSON.stringify(config), 'utf-8');

      const links = loadLinksConfig(tmpDir, '192.168.1.100', 16321);

      expect(links).toHaveLength(1);
      expect(links[0]).toEqual({
        id: 'test-1',
        type: 'tunnel',
        label: 'tunnel', // normalized from type
        url: 'wss://test.example.com',
        enabled: true, // defaults to true
      });
    });

    it('handles empty links array', () => {
      const filePath = join(tmpDir, 'links.json');
      writeFileSync(filePath, JSON.stringify({ links: [] }), 'utf-8');

      const links = loadLinksConfig(tmpDir, '192.168.1.100', 16321);

      // Empty array is valid, should return empty
      expect(links).toHaveLength(0);
    });
  });

  describe('saveLinksConfig', () => {
    it('writes links to file with proper formatting', () => {
      const links = [
        {
          id: 'lan-1',
          type: 'lan' as const,
          label: 'Local LAN',
          url: 'ws://192.168.1.50:16321',
          enabled: true,
        },
        {
          id: 'tunnel-1',
          type: 'tunnel' as const,
          label: 'Cloud Tunnel',
          url: 'wss://tunnel.example.com',
          enabled: false,
        },
      ];

      saveLinksConfig(tmpDir, links);

      const filePath = join(tmpDir, 'links.json');
      const content = readFileSync(filePath, 'utf-8');

      // Check formatting
      expect(content).toContain('  "links"'); // 2-space indent
      expect(content.endsWith('\n')).toBe(true);

      // Check content
      const data = JSON.parse(content);
      expect(data.links).toEqual(links);
    });

    it('overwrites existing file', () => {
      const filePath = join(tmpDir, 'links.json');
      writeFileSync(filePath, JSON.stringify({ links: [{ old: 'data' }] }));

      const links = [
        {
          id: 'new-1',
          type: 'lan' as const,
          label: 'New Link',
          url: 'ws://new.example.com',
          enabled: true,
        },
      ];

      saveLinksConfig(tmpDir, links);

      const content = readFileSync(filePath, 'utf-8');
      const data = JSON.parse(content);
      expect(data.links).toHaveLength(1);
      expect(data.links[0].id).toBe('new-1');
    });
  });

  describe('round-trip save/load', () => {
    it('preserves all data without loss', () => {
      const original = [
        {
          id: 'lan-default',
          type: 'lan' as const,
          label: 'LAN Direct',
          url: 'ws://192.168.1.100:16321',
          enabled: true,
        },
        {
          id: 'relay-official',
          type: 'relay-official' as const,
          label: 'Official Relay',
          url: 'wss://relay.mypilot.app',
          enabled: false,
        },
        {
          id: 'custom-wss',
          type: 'wss' as const,
          label: 'Custom WSS Server',
          url: 'wss://custom.example.com:8443',
          enabled: true,
        },
        {
          id: 'cloudflare-relay',
          type: 'cloudflare' as const,
          label: 'Cloudflare Tunnel',
          url: 'wss://mypilot-relay.workers.dev/gateway',
          enabled: true,
        },
      ];

      saveLinksConfig(tmpDir, original);
      const loaded = loadLinksConfig(tmpDir, '192.168.1.100', 16321);

      expect(loaded).toEqual(original);
    });
  });

  describe('createDefaultLink', () => {
    it('produces correct URL format', () => {
      const link = createDefaultLink('192.168.1.100', 16321);

      expect(link).toEqual({
        id: 'lan-default',
        type: 'lan',
        label: 'LAN Direct',
        url: 'ws://192.168.1.100:16321',
        enabled: true,
      });
    });

    it('uses different host and port', () => {
      const link = createDefaultLink('10.0.0.5', 8080);

      expect(link.url).toBe('ws://10.0.0.5:8080');
      expect(link.type).toBe('lan');
      expect(link.enabled).toBe(true);
    });

    it('handles localhost', () => {
      const link = createDefaultLink('localhost', 3000);

      expect(link.url).toBe('ws://localhost:3000');
    });
  });
});
