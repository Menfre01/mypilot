import type { DevicePlatform, APNEnvironment } from '../../shared/protocol.js';
import type { PersistedDevice } from './gateway-state.js';

export type { DevicePlatform };

export interface DeviceInfo {
  deviceId: string;
  platform: DevicePlatform;
  connected: boolean;
  pushToken?: string;
  pushEnvironment?: APNEnvironment;
  lastSeen: number;
  locale?: string;
}

export class DeviceStore {
  private devices = new Map<string, DeviceInfo>();

  constructor(initialDevices?: PersistedDevice[]) {
    if (initialDevices) {
      for (const d of initialDevices) {
        this.devices.set(d.deviceId, {
          deviceId: d.deviceId,
          platform: d.platform,
          connected: false,
          pushToken: d.pushToken,
          pushEnvironment: d.pushEnvironment,
          lastSeen: 0,
          locale: d.locale,
        });
      }
    }
  }

  register(deviceId: string, platform: DevicePlatform, locale?: string): DeviceInfo {
    const existing = this.devices.get(deviceId);
    if (existing) {
      existing.platform = platform;
      if (locale !== undefined) existing.locale = locale;
      existing.lastSeen = Date.now();
      return existing;
    }
    const device: DeviceInfo = {
      deviceId,
      platform,
      connected: true,
      lastSeen: Date.now(),
      locale,
    };
    this.devices.set(deviceId, device);
    return device;
  }

  setConnected(deviceId: string, connected: boolean): void {
    const device = this.devices.get(deviceId);
    if (device && device.connected !== connected) {
      device.connected = connected;
      device.lastSeen = Date.now();
    }
  }

  setPushToken(deviceId: string, token: string, environment?: APNEnvironment): boolean {
    const device = this.devices.get(deviceId);
    if (!device) return false;
    if (device.pushToken === token) return false;

    // 同一个 pushToken 只能属于一个设备，删除旧 deviceId 记录
    for (const [id, d] of this.devices) {
      if (id !== deviceId && d.pushToken === token) {
        this.devices.delete(id);
        break;
      }
    }

    device.pushToken = token;
    device.pushEnvironment = environment;
    device.lastSeen = Date.now();
    return true;
  }

  clearPushToken(deviceId: string): boolean {
    const device = this.devices.get(deviceId);
    if (!device || !device.pushToken) return false;
    device.pushToken = undefined;
    device.pushEnvironment = undefined;
    device.lastSeen = Date.now();
    return true;
  }

  getTakeoverIOSDevice(takeoverOwner: string | null): DeviceInfo | undefined {
    if (!takeoverOwner) return undefined;
    const device = this.devices.get(takeoverOwner);
    if (device?.platform === 'ios') return device;
    return undefined;
  }

  touch(deviceId: string): void {
    const device = this.devices.get(deviceId);
    if (device) {
      device.lastSeen = Date.now();
    }
  }

  remove(deviceId: string): void {
    this.devices.delete(deviceId);
  }

  getAll(): DeviceInfo[] {
    return Array.from(this.devices.values());
  }
}
