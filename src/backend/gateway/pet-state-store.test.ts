import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PetStateStore } from './pet-state-store.js';

describe('PetStateStore', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pet-state-test-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe('Persistence', () => {
    it('returns default state on first run', () => {
      const store = new PetStateStore(dir);
      const state = store.getState(0);
      expect(state.stage).toBe('egg');
      expect(state.satiety).toBe(100);
      expect(state.health).toBe('healthy');
      expect(state.totalTokens).toBe(0);
      expect(state.isOverwork).toBe(false);
    });

    it('persists and reloads state', () => {
      const store1 = new PetStateStore(dir);
      store1.feed({ input_tokens: 1_000_000, output_tokens: 1_000_000 }, 0);
      store1.flush();

      const store2 = new PetStateStore(dir);
      const state = store2.getState(24 * 3_600_000);
      expect(state.totalTokens).toBeGreaterThan(0);
      expect(state.satiety).toBeLessThan(100);
    });

    it('returns default state for corrupt file', () => {
      writeFileSync(join(dir, 'pet-state.json'), 'not json');
      const store = new PetStateStore(dir);
      const state = store.getState(0);
      expect(state.stage).toBe('egg');
      expect(state.satiety).toBe(100);
    });
  });

  describe('Lazy decay', () => {
    it('no decay right after feeding', () => {
      const store = new PetStateStore(dir);
      store.feed({ input_tokens: 0, output_tokens: 0 }, 1000);
      const state = store.getState(1000);
      expect(state.satiety).toBe(100);
    });

    it('decays 16 points after 24 hours', () => {
      const store = new PetStateStore(dir);
      store.feed({ input_tokens: 0, output_tokens: 0 }, 0);
      const state = store.getState(24 * 3_600_000);
      expect(state.satiety).toBe(84);
    });

    it('decays 16 points after 24 hours when overwork', () => {
      const store = new PetStateStore(dir);
      const start = 0;

      for (let i = 0; i < 26; i++) {
        store.feed({ input_tokens: 0, output_tokens: 0 }, start + i * 300_000);
      }

      const state = store.getState(start + 26 * 300_000 + 24 * 3_600_000);
      expect(state.satiety).toBeLessThan(92);
    });

    it('satiety does not go below 0', () => {
      const store = new PetStateStore(dir);
      store.feed({ input_tokens: 0, output_tokens: 0 }, 0);
      const state = store.getState(30 * 24 * 3_600_000);
      expect(state.satiety).toBe(0);
    });

    it('multiple getState calls do not double-decay', () => {
      const store = new PetStateStore(dir);
      store.feed({ input_tokens: 0, output_tokens: 0 }, 0);
      store.getState(24 * 3_600_000);
      const state2 = store.getState(24 * 3_600_000);
      expect(state2.satiety).toBe(84);
    });
  });

  describe('Health transitions', () => {
    it('satiety >= 68 → healthy', () => {
      const store = new PetStateStore(dir);
      store.feed({ input_tokens: 0, output_tokens: 0 }, 0);
      const state = store.getState(12 * 3_600_000);
      expect(state.health).toBe('healthy');
      expect(state.satiety).toBeGreaterThanOrEqual(68);
    });

    it('satiety 67 → sick', () => {
      const store = new PetStateStore(dir);
      store.feed({ input_tokens: 0, output_tokens: 0 }, 0);
      const state = store.getState(99 * 3_600_000);
      expect(state.satiety).toBeLessThan(68);
      expect(state.satiety).toBeGreaterThanOrEqual(30);
      expect(state.health).toBe('sick');
    });

    it('satiety 29 → critical', () => {
      const store = new PetStateStore(dir);
      store.feed({ input_tokens: 0, output_tokens: 0 }, 0);
      const state = store.getState(130 * 3_600_000);
      expect(state.satiety).toBeLessThan(30);
      expect(state.satiety).toBeGreaterThanOrEqual(1);
      expect(state.health).toBe('critical');
    });

    it('satiety 0 → dead', () => {
      const store = new PetStateStore(dir);
      store.feed({ input_tokens: 0, output_tokens: 0 }, 0);
      store.getState(300 * 3_600_000);
      const state = store.getState(301 * 3_600_000);
      expect(state.satiety).toBe(0);
      expect(state.health).toBe('dead');
    });
  });

  describe('Feeding', () => {
    it('1M weighted tokens = +1 satiety', () => {
      const store = new PetStateStore(dir);
      store.feed({ input_tokens: 0, output_tokens: 0 }, 0);
      store.getState(12 * 3_600_000);
      store.feed({ input_tokens: 0, output_tokens: 3_750_000 }, 12 * 3_600_000);
      const state = store.getState(12 * 3_600_000);
      expect(state.satiety).toBe(96);
    });

    it('satiety capped at 100', () => {
      const store = new PetStateStore(dir);
      store.feed({ input_tokens: 0, output_tokens: 10_000_000 }, 0);
      expect(store.getState(0).satiety).toBe(100);
    });

    it('totalTokens accumulates', () => {
      const store = new PetStateStore(dir);
      store.feed({ input_tokens: 1_000_000, output_tokens: 1_000_000 }, 0);
      store.feed({ input_tokens: 1_000_000, output_tokens: 1_000_000 }, 600_001);
      const state = store.getState(600_001);
      expect(state.totalTokens).toBe(2 * (1_000_000 * 0.5 + 1_000_000 * 1.0));
    });

    it('stage transitions: egg → baby → adult', () => {
      const store = new PetStateStore(dir);
      expect(store.getState(0).stage).toBe('egg');

      store.feed({ input_tokens: 0, output_tokens: 50_000_000 }, 0);
      expect(store.getState(0).stage).toBe('baby');

      store.feed({ input_tokens: 0, output_tokens: 450_000_000 }, 600_001);
      expect(store.getState(600_001).stage).toBe('adult');
    });
  });

  describe('Overwork', () => {
    it('triggers overwork after 2+ hours of continuous feeding within 10min intervals', () => {
      const store = new PetStateStore(dir);
      const start = 0;

      for (let i = 0; i < 26; i++) {
        store.feed({ input_tokens: 0, output_tokens: 0 }, start + i * 300_000);
      }

      const state = store.getState(start + 26 * 300_000);
      expect(state.isOverwork).toBe(true);
    });

    it('clears overwork after gap > 10 minutes', () => {
      const store = new PetStateStore(dir);
      const start = 0;

      for (let i = 0; i < 26; i++) {
        store.feed({ input_tokens: 0, output_tokens: 0 }, start + i * 300_000);
      }

      store.feed({ input_tokens: 0, output_tokens: 0 }, start + 26 * 300_000 + 700_000);
      const state = store.getState(start + 26 * 300_000 + 700_000);
      expect(state.isOverwork).toBe(false);
    });

    it('awards +1 satiety on rest (overwork cleared)', () => {
      const store = new PetStateStore(dir);
      const start = 0;

      for (let i = 0; i < 26; i++) {
        store.feed({ input_tokens: 0, output_tokens: 0 }, start + i * 300_000);
      }

      const overworkState = store.getState(start + 26 * 300_000);
      const satietyBeforeRest = overworkState.satiety;

      const restTime = start + 26 * 300_000 + 700_000;
      store.feed({ input_tokens: 0, output_tokens: 0 }, restTime);
      const afterRest = store.getState(restTime);
      expect(afterRest.satiety).toBe(Math.min(100, satietyBeforeRest + 1));
    });
  });

  describe('Readopt', () => {
    it('resets to egg with full satiety', () => {
      const store = new PetStateStore(dir);
      store.feed({ input_tokens: 0, output_tokens: 100_000_000 }, 0);

      const state = store.readopt();
      expect(state.stage).toBe('egg');
      expect(state.satiety).toBe(100);
      expect(state.totalTokens).toBe(0);
      expect(state.health).toBe('healthy');
      expect(state.isOverwork).toBe(false);
    });
  });
});
