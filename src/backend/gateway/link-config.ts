import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LinkConfig } from '../../shared/protocol.js';

export function loadLinksConfig(
  configDir: string,
  defaultHost: string,
  defaultPort: number,
): LinkConfig[] {
  const filePath = join(configDir, 'links.json');
  try {
    const raw = readFileSync(filePath, 'utf-8');
    const data = JSON.parse(raw);
    return (data.links as LinkConfig[]).map(normalizeLink);
  } catch (err) {
    const errno = err as NodeJS.ErrnoException;
    if (errno.code !== 'ENOENT' && !(err instanceof SyntaxError)) throw err;
    const defaults = [createDefaultLink(defaultHost, defaultPort)];
    saveLinksConfig(configDir, defaults);
    return defaults;
  }
}

export function saveLinksConfig(configDir: string, links: LinkConfig[]): void {
  const filePath = join(configDir, 'links.json');
  writeFileSync(filePath, JSON.stringify({ links }, null, 2) + '\n', 'utf-8');
}

export function createDefaultLink(host: string, port: number): LinkConfig {
  return {
    id: 'lan-default',
    type: 'lan',
    label: 'LAN Direct',
    url: `ws://${host}:${port}`,
    enabled: true,
  };
}

function normalizeLink(raw: Partial<LinkConfig>): LinkConfig {
  return {
    id: raw.id ?? 'unknown',
    type: raw.type ?? 'lan',
    label: raw.label ?? raw.type ?? 'Unknown',
    url: raw.url ?? '',
    enabled: raw.enabled ?? true,
  };
}
