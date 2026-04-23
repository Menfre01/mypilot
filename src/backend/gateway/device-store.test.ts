import { describe, it, expect, beforeEach } from 'vitest';
import { DeviceStore } from './device-store.js';

describe('DeviceStore', () => {
  let store: DeviceStore;

  beforeEach(() => {
    store = new DeviceStore();
  });

  describe('register', () => {
    it('registers a new device', () => {
      const device = store.register('device1', 'ios');
      expect(device.deviceId).toBe('device1');
      expect(device.platform).toBe('ios');
      expect(device.connected).toBe(true);
      expect(device.pushToken).toBeUndefined();
    });

    it('updates existing device on re-register', () => {
      store.register('device1', 'ios');
      const device = store.register('device1', 'android');
      expect(device.platform).toBe('android');
    });
  });

  describe('setConnected', () => {
    it('updates connection status', () => {
      store.register('device1', 'ios');
      store.setConnected('device1', false);
      expect(store.getAll()[0].connected).toBe(false);
    });

    it('ignores unknown device', () => {
      store.setConnected('unknown', false);
    });
  });

  describe('setPushToken', () => {
    it('sets push token for device', () => {
      store.register('device1', 'ios');
      store.setPushToken('device1', 'token123');
      expect(store.getAll()[0].pushToken).toBe('token123');
    });
  });

  describe('getTakeoverIOSDevice', () => {
    it('returns iOS device when it is takeover owner', () => {
      store.register('device1', 'ios');
      const device = store.getTakeoverIOSDevice('device1');
      expect(device?.deviceId).toBe('device1');
    });

    it('returns undefined when takeover owner is not iOS', () => {
      store.register('device1', 'android');
      const device = store.getTakeoverIOSDevice('device1');
      expect(device).toBeUndefined();
    });

    it('returns undefined when no takeover owner', () => {
      store.register('device1', 'ios');
      const device = store.getTakeoverIOSDevice(null);
      expect(device).toBeUndefined();
    });

    it('returns undefined when takeover owner not found', () => {
      const device = store.getTakeoverIOSDevice('unknown');
      expect(device).toBeUndefined();
    });
  });

  describe('remove', () => {
    it('removes device', () => {
      store.register('device1', 'ios');
      store.remove('device1');
      expect(store.getAll()).toHaveLength(0);
    });
  });

  describe('getAll', () => {
    it('returns all devices', () => {
      store.register('device1', 'ios');
      store.register('device2', 'android');
      const all = store.getAll();
      expect(all).toHaveLength(2);
    });
  });
});
