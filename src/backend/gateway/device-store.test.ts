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

    it('stores locale on new device', () => {
      const device = store.register('device1', 'ios', 'zh-CN');
      expect(device.locale).toBe('zh-CN');
    });

    it('updates locale on re-register when provided', () => {
      store.register('device1', 'ios', 'en');
      const device = store.register('device1', 'ios', 'zh-CN');
      expect(device.locale).toBe('zh-CN');
    });

    it('preserves locale on re-register when not provided', () => {
      store.register('device1', 'ios', 'zh-CN');
      const device = store.register('device1', 'ios');
      expect(device.locale).toBe('zh-CN');
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

    it('removes old device when same pushToken registered under new deviceId', () => {
      store.register('device1', 'ios');
      store.setPushToken('device1', 'token123');
      store.register('device2', 'ios');
      store.setPushToken('device2', 'token123');

      const all = store.getAll();
      expect(all).toHaveLength(1);
      expect(all[0].deviceId).toBe('device2');
    });

    it('does nothing for same deviceId and same pushToken', () => {
      store.register('device1', 'ios');
      store.setPushToken('device1', 'token123');
      const changed = store.setPushToken('device1', 'token123');
      expect(changed).toBe(false);
      expect(store.getAll()).toHaveLength(1);
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

  describe('constructor with initial devices', () => {
    it('restores locale from persisted devices', () => {
      const s = new DeviceStore([
        { deviceId: 'd1', platform: 'ios', pushToken: 'tok', locale: 'zh-CN' },
      ]);
      const device = s.getAll()[0];
      expect(device.locale).toBe('zh-CN');
      expect(device.pushToken).toBe('tok');
    });
  });
});
