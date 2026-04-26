import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { getOrCreateKey } from './token-store.js';

export interface PushConfigFile {
  relayUrl: string;
  apiKey: string;
  gatewayId: string;
}

export interface PushUserInfo {
  email?: string;
  gatewayId?: string;
  plan: 'free' | 'pro';
  pushCount: number;
  pushLimit: number;
  todayCount: number;
}

export const DEFAULT_RELAY_URL = 'https://mypilot-push-relay.menfre.workers.dev';

const PUSH_CONFIG_FILE = 'push.json';

export function loadPushConfig(pidDir: string): PushConfigFile | null {
  const configPath = join(pidDir, PUSH_CONFIG_FILE);

  try {
    const content = readFileSync(configPath, 'utf-8');
    const config = JSON.parse(content) as PushConfigFile;

    if (!config.relayUrl || !config.apiKey || !config.gatewayId) {
      return null;
    }

    return config;
  } catch {
    return null;
  }
}

export function savePushConfig(pidDir: string, config: PushConfigFile): void {
  const configPath = join(pidDir, PUSH_CONFIG_FILE);
  writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
}

export function deletePushConfig(pidDir: string): void {
  try {
    unlinkSync(join(pidDir, PUSH_CONFIG_FILE));
  } catch {
    // unlinkSync throws if file doesn't exist
  }
}

export function generateGatewayId(pidDir: string): string {
  const key = getOrCreateKey(pidDir);
  return key.toString('hex').slice(0, 16);
}

async function fetchJson<T>(url: string, options?: { method?: string; body?: unknown; apiKey?: string }): Promise<T | null> {
  try {
    const headers: Record<string, string> = {};
    if (options?.apiKey) headers['Authorization'] = `Bearer ${options.apiKey}`;
    if (options?.body !== undefined) headers['Content-Type'] = 'application/json';

    const response = await fetch(url, {
      method: options?.method ?? (options?.body !== undefined ? 'POST' : 'GET'),
      headers,
      body: options?.body !== undefined ? JSON.stringify(options.body) : undefined,
    });

    if (!response.ok) return null;

    const data = (await response.json()) as Record<string, unknown> & { ok?: boolean };
    if (data.ok === false) return null;

    return data as T;
  } catch {
    return null;
  }
}

export interface RegisterResult {
  apiKey: string;
  plan: 'free' | 'pro';
  pushLimit: number;
}

export async function autoRegisterPush(
  relayUrl: string,
  gatewayId: string,
): Promise<RegisterResult | null> {
  const data = await fetchJson<RegisterResult>(
    `${relayUrl}/api/auto-register`,
    { body: { gatewayId } },
  );
  if (!data?.apiKey) return null;
  return data;
}

export async function getUserInfo(
  relayUrl: string,
  apiKey: string,
): Promise<PushUserInfo | null> {
  return fetchJson<PushUserInfo>(`${relayUrl}/api/user/info`, { apiKey });
}
