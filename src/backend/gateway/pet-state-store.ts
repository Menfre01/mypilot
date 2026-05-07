import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import type { PetStatePayload, PetStage, PetHealth, TokenUsage } from '../../shared/protocol.js';

const PET_STATE_FILE = 'pet-state.json';

const TOKEN_WEIGHT_INPUT = 0.5;
const TOKEN_WEIGHT_OUTPUT = 1.0;
const TOKEN_WEIGHT_CACHE_READ = 0.05;
const TOKEN_WEIGHT_CACHE_CREATION = 0.05;

const SATIETY_MAX = 100;
const SATIETY_DENOMINATOR = 1_000_000;
const DECAY_RATE_NORMAL = 16 / 24;
const DECAY_RATE_OVERWORK = 32 / 24;

const HEALTHY_MIN = 68;
const SICK_MIN = 30;
const CRITICAL_MIN = 1;

const BABY_MIN_TOKENS = 50_000_000;
const ADULT_MIN_TOKENS = 500_000_000;

const FEED_GAP_RESET_MS = 600_000;
const OVERWORK_WINDOW_MS = 7_200_000;

const SATIETY_PER_HEART = 2.5;
const HEART_INCREMENT = 0.25;

interface InternalState {
  totalTokens: number;
  satiety: number;
  stage: PetStage;
  health: PetHealth;
  lastDecayAt: number | null;
  isOverwork: boolean;
  overworkStartedAt: number | null;
  feedWindowStart: number | null;
  lastFeedAtMs: number | null;
}

const DEFAULT_STATE: InternalState = {
  totalTokens: 0,
  satiety: 100,
  stage: 'egg',
  health: 'healthy',
  lastDecayAt: null,
  isOverwork: false,
  overworkStartedAt: null,
  feedWindowStart: null,
  lastFeedAtMs: null,
};

function msToISO(ms: number | null): string | null {
  return ms != null ? new Date(ms).toISOString() : null;
}

export class PetStateStore {
  private state: InternalState;
  private filePath: string;
  private dirty = false;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(pidDir: string) {
    this.filePath = join(pidDir, PET_STATE_FILE);
    mkdirSync(dirname(this.filePath), { recursive: true });
    this.state = this._load();
  }

  getState(now = Date.now()): PetStatePayload {
    this._applyDecay(now);
    this._updateHealth();
    if (this.dirty) this._schedulePersist();
    return this._toPayload();
  }

  feed(usage: TokenUsage, now = Date.now()): PetStatePayload {
    this._applyDecay(now);
    this._checkOverwork(now);

    const weightedTokens =
      usage.input_tokens * TOKEN_WEIGHT_INPUT +
      usage.output_tokens * TOKEN_WEIGHT_OUTPUT +
      (usage.cache_read_input_tokens ?? 0) * TOKEN_WEIGHT_CACHE_READ +
      (usage.cache_creation_input_tokens ?? 0) * TOKEN_WEIGHT_CACHE_CREATION;

    const satietyGain = weightedTokens / SATIETY_DENOMINATOR;
    this.state.satiety = Math.min(SATIETY_MAX, this.state.satiety + Math.round(satietyGain));
    this.state.totalTokens = Math.round(this.state.totalTokens + weightedTokens);
    this.state.lastDecayAt = now;

    this._updateHealth();
    this._updateStage();
    this._schedulePersist();
    return this._toPayload();
  }

  readopt(): PetStatePayload {
    this.state = { ...DEFAULT_STATE };
    this._schedulePersist();
    return this._toPayload();
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

  private _applyDecay(now: number): void {
    if (this.state.lastDecayAt == null) return;

    const hoursElapsed = (now - this.state.lastDecayAt) / 3_600_000;
    if (hoursElapsed <= 0) return;

    const rate = this.state.isOverwork ? DECAY_RATE_OVERWORK : DECAY_RATE_NORMAL;
    const newSatiety = Math.max(0, Math.round(this.state.satiety - hoursElapsed * rate));
    if (newSatiety === this.state.satiety) return;

    this.state.satiety = newSatiety;
    this.state.lastDecayAt = now;
    this._schedulePersist();
  }

  private _updateHealth(): void {
    const s = this.state.satiety;
    if (s >= HEALTHY_MIN) this.state.health = 'healthy';
    else if (s >= SICK_MIN) this.state.health = 'sick';
    else if (s >= CRITICAL_MIN) this.state.health = 'critical';
    else this.state.health = 'dead';
  }

  private _updateStage(): void {
    const t = this.state.totalTokens;
    if (t >= ADULT_MIN_TOKENS) this.state.stage = 'adult';
    else if (t >= BABY_MIN_TOKENS) this.state.stage = 'baby';
    else this.state.stage = 'egg';
  }

  private _checkOverwork(now: number): void {
    if (this.state.lastFeedAtMs === null) {
      this.state.feedWindowStart = now;
      this.state.lastFeedAtMs = now;
      return;
    }

    const gap = now - this.state.lastFeedAtMs;

    if (gap > FEED_GAP_RESET_MS) {
      if (this.state.isOverwork) {
        this.state.isOverwork = false;
        this.state.overworkStartedAt = null;
        this.state.satiety = Math.min(SATIETY_MAX, this.state.satiety + 1);
      }
      this.state.feedWindowStart = now;
    } else if (this.state.feedWindowStart != null) {
      const windowDuration = now - this.state.feedWindowStart;
      if (windowDuration >= OVERWORK_WINDOW_MS && !this.state.isOverwork) {
        this.state.isOverwork = true;
        this.state.overworkStartedAt = now;
      }
    }

    this.state.lastFeedAtMs = now;
  }

  private _toPayload(): PetStatePayload {
    return {
      totalTokens: this.state.totalTokens,
      satiety: this.state.satiety,
      hearts: Math.round(this.state.satiety / SATIETY_PER_HEART) * HEART_INCREMENT,
      stage: this.state.stage,
      health: this.state.health,
      lastFedAt: msToISO(this.state.lastFeedAtMs),
      isOverwork: this.state.isOverwork,
      overworkStartedAt: msToISO(this.state.overworkStartedAt),
      feedWindowStart: msToISO(this.state.feedWindowStart),
    };
  }

  private _load(): InternalState {
    try {
      const content = readFileSync(this.filePath, 'utf-8');
      const parsed = JSON.parse(content);
      if (typeof parsed.totalTokens !== 'number' || typeof parsed.satiety !== 'number') {
        return { ...DEFAULT_STATE };
      }
      return {
        ...DEFAULT_STATE,
        ...parsed,
        lastDecayAt: toEpochMs(parsed.lastDecayAt ?? parsed.lastFedAt),
        overworkStartedAt: toEpochMs(parsed.overworkStartedAt),
        feedWindowStart: toEpochMs(parsed.feedWindowStart),
      };
    } catch {
      return { ...DEFAULT_STATE };
    }
  }

  private _schedulePersist(): void {
    this.dirty = true;
    if (this.persistTimer == null) {
      this.persistTimer = setTimeout(() => {
        this.persistTimer = null;
        if (this.dirty) this._persist();
      }, 5000);
    }
  }

  private _persist(): void {
    this.dirty = false;
    writeFileSync(this.filePath, JSON.stringify(this.state, null, 2), 'utf-8');
  }
}

function toEpochMs(v: unknown): number | null {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const ms = new Date(v).getTime();
    return Number.isNaN(ms) ? null : ms;
  }
  return null;
}
