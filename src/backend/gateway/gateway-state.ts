import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DevicePlatform, GatewayMode, APNEnvironment } from '../../shared/protocol.js';

export interface PersistedDevice {
  deviceId: string;
  platform: DevicePlatform;
  pushToken?: string;
  pushEnvironment?: APNEnvironment;
  locale?: string;
}

const MAX_RECENT_CWDS = 5;

export interface GatewayState {
  mode: GatewayMode;
  takeoverOwner: string | null;
  devices: PersistedDevice[];
  recentCwds?: string[];
}

const GATEWAY_STATE_FILE = 'gateway-state.json';

export function recordRecentCwd(pidDir: string, cwd: string): void {
  const state = loadGatewayState(pidDir);
  const recentCwds = (state?.recentCwds ?? []).filter(d => d !== cwd);
  recentCwds.unshift(cwd);
  saveGatewayState(pidDir, {
    mode: state?.mode ?? 'bystander',
    takeoverOwner: state?.takeoverOwner ?? null,
    devices: state?.devices ?? [],
    recentCwds: recentCwds.slice(0, MAX_RECENT_CWDS),
  });
}

export function loadGatewayState(pidDir: string): GatewayState | null {
  try {
    const content = readFileSync(join(pidDir, GATEWAY_STATE_FILE), 'utf-8');
    const state = JSON.parse(content) as GatewayState;
    if (typeof state.mode !== 'string' || !Array.isArray(state.devices)) return null;
    if (state.takeoverOwner != null && typeof state.takeoverOwner !== 'string') return null;
    return state;
  } catch {
    return null;
  }
}

export function saveGatewayState(pidDir: string, state: GatewayState): void {
  try {
    writeFileSync(join(pidDir, GATEWAY_STATE_FILE), JSON.stringify(state, null, 2), 'utf-8');
  } catch (err) {
    console.error('[GatewayState] Failed to save state: %s', err instanceof Error ? err.message : err);
  }
}

