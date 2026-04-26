import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { loadGatewayState, saveGatewayState, type GatewayState } from './gateway-state.js';

describe('gateway-state', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gw-state-test-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe('loadGatewayState', () => {
    it('returns null when file does not exist', () => {
      expect(loadGatewayState(dir)).toBeNull();
    });

    it('returns null for invalid JSON', () => {
      writeFileSync(join(dir, 'gateway-state.json'), 'not json');
      expect(loadGatewayState(dir)).toBeNull();
    });

    it('returns null when mode is missing', () => {
      writeFileSync(join(dir, 'gateway-state.json'), JSON.stringify({ devices: [] }));
      expect(loadGatewayState(dir)).toBeNull();
    });

    it('returns null when devices is not an array', () => {
      writeFileSync(join(dir, 'gateway-state.json'), JSON.stringify({ mode: 'bystander', devices: {} }));
      expect(loadGatewayState(dir)).toBeNull();
    });

    it('returns null when takeoverOwner is not a string', () => {
      writeFileSync(join(dir, 'gateway-state.json'), JSON.stringify({ mode: 'bystander', devices: [], takeoverOwner: 123 }));
      expect(loadGatewayState(dir)).toBeNull();
    });

    it('loads valid state with all fields', () => {
      const state: GatewayState = {
        mode: 'takeover',
        takeoverOwner: 'device-1',
        devices: [
          { deviceId: 'device-1', platform: 'ios', pushToken: 'abc', pushEnvironment: 'sandbox', locale: 'en' },
          { deviceId: 'device-2', platform: 'android' },
        ],
      };
      writeFileSync(join(dir, 'gateway-state.json'), JSON.stringify(state));

      const loaded = loadGatewayState(dir);
      expect(loaded).toEqual(state);
    });

    it('loads state without optional fields', () => {
      const state = {
        mode: 'bystander',
        takeoverOwner: null,
        devices: [{ deviceId: 'd1', platform: 'ios' }],
      };
      writeFileSync(join(dir, 'gateway-state.json'), JSON.stringify(state));

      const loaded = loadGatewayState(dir)!;
      expect(loaded.mode).toBe('bystander');
      expect(loaded.takeoverOwner).toBeNull();
      expect(loaded.devices[0].pushToken).toBeUndefined();
      expect(loaded.devices[0].pushEnvironment).toBeUndefined();
      expect(loaded.devices[0].locale).toBeUndefined();
    });

    it('loads old state without pushEnvironment (backward compat)', () => {
      const oldState = {
        mode: 'takeover',
        takeoverOwner: 'device-1',
        devices: [
          { deviceId: 'device-1', platform: 'ios', pushToken: 'old-token' },
        ],
      };
      writeFileSync(join(dir, 'gateway-state.json'), JSON.stringify(oldState));

      const loaded = loadGatewayState(dir)!;
      expect(loaded.devices[0].pushToken).toBe('old-token');
      expect(loaded.devices[0].pushEnvironment).toBeUndefined();
    });

    it('loads state without takeoverOwner', () => {
      const state = { mode: 'bystander', devices: [] };
      writeFileSync(join(dir, 'gateway-state.json'), JSON.stringify(state));

      const loaded = loadGatewayState(dir)!;
      expect(loaded.takeoverOwner).toBeUndefined();
    });
  });

  describe('saveGatewayState', () => {
    it('persists and reloads state', () => {
      const state: GatewayState = {
        mode: 'takeover',
        takeoverOwner: 'device-1',
        devices: [
          { deviceId: 'device-1', platform: 'ios', pushToken: 'tok', pushEnvironment: 'production', locale: 'zh-CN' },
        ],
      };

      saveGatewayState(dir, state);
      const loaded = loadGatewayState(dir);

      expect(loaded).toEqual(state);
    });
  });
});
