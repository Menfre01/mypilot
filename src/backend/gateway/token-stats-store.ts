import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { SYNTHETIC_MODEL, type TokenBreakdown, type TokenStatsPayload } from '../../shared/protocol.js';
import { getLocalDate, getWeekStart, getMonthStart } from '../../shared/date-utils.js';

const TOKEN_STATS_FILE = 'token-stats.json';
const MAX_RETENTION_DAYS = 90;

const BRAND_PREFIXES: [string, string][] = [
  ['claude-', 'anthropic'],
  ['deepseek-', 'deepseek'],
  ['gpt-', 'openai'],
  ['o1-', 'openai'],
  ['o3-', 'openai'],
  ['gemini-', 'google'],
  ['mimo-', 'xiaomi'],
  ['glm-', 'zhipu'],
  ['kimi-', 'moonshot'],
];

const brandCache = new Map<string, string>();

export function parseBrand(model: string): string {
  const cached = brandCache.get(model);
  if (cached !== undefined) return cached;
  for (const [prefix, brand] of BRAND_PREFIXES) {
    if (model.startsWith(prefix)) {
      brandCache.set(model, brand);
      return brand;
    }
  }
  brandCache.set(model, 'unknown');
  return 'unknown';
}

interface InternalRecords {
  [date: string]: {
    [brand: string]: {
      [model: string]: TokenBreakdown;
    };
  };
}

interface InternalState {
  records: InternalRecords;
  lastUpdated: string;
}

const DEFAULT_STATE: InternalState = {
  records: {},
  lastUpdated: '',
};

export class TokenStatsStore {
  private state: InternalState;
  private filePath: string;
  private dirty = false;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(pidDir: string) {
    this.filePath = join(pidDir, TOKEN_STATS_FILE);
    mkdirSync(dirname(this.filePath), { recursive: true });
    this.state = this._load();
  }

  private _load(): InternalState {
    try {
      const content = readFileSync(this.filePath, 'utf-8');
      const parsed = JSON.parse(content) as InternalState;
      if (typeof parsed !== 'object' || parsed == null) return { ...DEFAULT_STATE };
      if (typeof parsed.records !== 'object') return { ...DEFAULT_STATE };
      return {
        records: parsed.records,
        lastUpdated: parsed.lastUpdated ?? '',
      };
    } catch {
      return { ...DEFAULT_STATE };
    }
  }

  private _schedulePersist(): void {
    this.dirty = true;
    if (this.persistTimer != null) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      if (this.dirty) {
        this._persist();
      }
    }, 5000);
  }

  private _persist(): void {
    this.dirty = false;
    this.state.lastUpdated = new Date().toISOString();
    try {
      writeFileSync(this.filePath, JSON.stringify(this.state, null, 2), 'utf-8');
    } catch (err) {
      console.error('[TokenStatsStore] Failed to persist state: %s', err instanceof Error ? err.message : err);
    }
  }

  flush(): void {
    if (this.persistTimer != null) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    if (this.dirty) {
      this._persist();
    }
  }

  record(date: string, brand: string, model: string, usage: TokenBreakdown): void {
    if (model === SYNTHETIC_MODEL) return;
    const dateRecords = this.state.records[date];
    if (!dateRecords) {
      this.state.records[date] = { [brand]: { [model]: { ...usage } } };
      this._pruneOldRecords();
      this._schedulePersist();
      return;
    }
    const brandRecords = dateRecords[brand];
    if (!brandRecords) {
      dateRecords[brand] = { [model]: { ...usage } };
      this._schedulePersist();
      return;
    }
    const existing = brandRecords[model];
    if (existing) {
      brandRecords[model] = {
        input: existing.input + usage.input,
        output: existing.output + usage.output,
        cacheRead: existing.cacheRead + usage.cacheRead,
        cacheCreation: existing.cacheCreation + usage.cacheCreation,
      };
    } else {
      brandRecords[model] = { ...usage };
    }
    this._schedulePersist();
  }

  getStats(range: 'today' | 'week' | 'month'): TokenStatsPayload {
    const today = getLocalDate();

    if (range === 'today') {
      const todayRecords = this.state.records[today];
      return {
        records: todayRecords ? { [today]: todayRecords } : {},
        lastUpdated: this.state.lastUpdated,
      };
    }

    const cutoffDate = range === 'week' ? getWeekStart() : getMonthStart();

    const filtered: InternalRecords = {};
    for (const [date, brands] of Object.entries(this.state.records)) {
      if (date >= cutoffDate) filtered[date] = brands;
    }

    return {
      records: filtered,
      lastUpdated: this.state.lastUpdated,
    };
  }

  private _pruneOldRecords(): void {
    const cutoffMs = Date.now() - MAX_RETENTION_DAYS * 86400000;
    const cutoffDate = getLocalDate(new Date(cutoffMs));
    for (const date of Object.keys(this.state.records)) {
      if (date < cutoffDate) {
        delete this.state.records[date];
      }
    }
  }
}
