import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { getOrCreateKey } from './token-store.js';

export interface PushConfigFile {
  relayUrl: string;
  apiKey: string;
  gatewayId: string;
}

export interface PushUserInfo {
  email: string;
  plan: 'free' | 'pro';
  pushCount: number;
  pushLimit: number;
  todayCount: number;
}

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

async function postJson<T>(url: string, body: unknown, apiKey?: string): Promise<T | null> {
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
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

export async function registerAccount(
  relayUrl: string,
  email: string,
): Promise<RegisterResult | null> {
  const data = await postJson<RegisterResult>(
    `${relayUrl}/api/register`,
    { email },
  );
  if (!data?.apiKey) return null;
  return data;
}

export async function getUserInfo(
  relayUrl: string,
  apiKey: string,
): Promise<PushUserInfo | null> {
  return postJson<PushUserInfo>(`${relayUrl}/api/user/info`, { apiKey }, apiKey);
}
