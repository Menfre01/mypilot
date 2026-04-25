import type { DevicePlatform } from '../../shared/protocol.js';
import type { PersistedDevice } from './gateway-state.js';

export type { DevicePlatform };

export interface DeviceInfo {
  deviceId: string;
  platform: DevicePlatform;
  connected: boolean;
  pushToken?: string;
  lastSeen: number;
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
          lastSeen: 0,
        });
      }
    }
  }

  register(deviceId: string, platform: DevicePlatform): DeviceInfo {
    const existing = this.devices.get(deviceId);
    if (existing) {
      existing.platform = platform;
      existing.lastSeen = Date.now();
      return existing;
    }
    const device: DeviceInfo = {
      deviceId,
      platform,
      connected: true,
      lastSeen: Date.now(),
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

  setPushToken(deviceId: string, token: string): boolean {
    const device = this.devices.get(deviceId);
    if (!device) return false;
    if (device.pushToken === token) return false;
    device.pushToken = token;
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
