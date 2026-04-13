import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { networkInterfaces } from 'node:os';

const TOKEN_FILE = 'token';

/**
 * Get or create a persistent gateway token.
 * Stored in `{dir}/token` as plain text.
 */
export function getOrCreateToken(dir: string): string {
  const tokenPath = join(dir, TOKEN_FILE);

  try {
    const token = readFileSync(tokenPath, 'utf-8').trim();
    if (token) return token;
  } catch {
    // File doesn't exist or unreadable — create new token below
  }

  const token = randomUUID();
  writeFileSync(tokenPath, token, 'utf-8');
  return token;
}

/**
 * Detect the machine's LAN IP address.
 * Uses LAN_IP env var if set (for Docker deployments), otherwise auto-detects.
 * Auto-detection prioritizes physical interfaces (en0, eth0, wlan0) over virtual ones.
 */
export function detectLanIP(): string {
  // Allow manual override via environment variable (for Docker, multi-NIC, etc.)
  if (process.env.LAN_IP) {
    return process.env.LAN_IP;
  }

  const interfaces = networkInterfaces();

  const ifaceScore = (name: string): number => {
    // Physical interfaces (macOS: en0/en1, Linux: eth0/wlan0)
    if (/^en\d+$/.test(name)) return 200;
    if (/^(eth\d+|wlan\d+)$/.test(name)) return 200;
    // Virtual / bridge / tunnel — deprioritize
    if (/^(bridge|utun|docker|veth|br-|vmnet|vnic|lo)/.test(name)) return -100;
    return 0;
  };

  const ipScore = (ip: string): number => {
    if (ip.startsWith('192.168.')) return 100;
    if (ip.startsWith('10.')) return 80;
    if (ip.startsWith('172.')) {
      const part = parseInt(ip.split('.')[1], 10);
      if (part >= 16 && part <= 31) return 70;
    }
    return 0;
  };

  let best: { ip: string; priority: number } | undefined;

  for (const [name, iface] of Object.entries(interfaces)) {
    if (!iface) continue;
    for (const addr of iface) {
      if (addr.family === 'IPv4' && !addr.internal) {
        const priority = ifaceScore(name) + ipScore(addr.address);
        if (!best || priority > best.priority) {
          best = { ip: addr.address, priority };
        }
      }
    }
  }

  return best?.ip ?? '127.0.0.1';
}
