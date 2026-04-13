import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  buildHooksConfig,
  mergeHooksIntoSettings,
  MYPILOT_HOOK_COMMAND,
  BLOCKING_HOOK_EVENTS,
  INFO_HOOK_EVENTS,
} from './hooks-config.js';

describe('hooks-config', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mypilot-hooks-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('buildHooksConfig', () => {
    it('generates all hook events', () => {
      const config = buildHooksConfig();
      const events = Object.keys(config);
      // Should cover all HookEventName values
      expect(events.length).toBeGreaterThanOrEqual(20);
    });

    it('blocking events have timeout', () => {
      const config = buildHooksConfig();
      for (const event of BLOCKING_HOOK_EVENTS) {
        const entries = config[event];
        expect(entries).toBeDefined();
        const hook = entries[0].hooks[0];
        expect(hook.timeout).toBe(999999);
      }
    });

    it('info events do not have timeout', () => {
      const config = buildHooksConfig();
      for (const event of INFO_HOOK_EVENTS) {
        const entries = config[event];
        expect(entries).toBeDefined();
        const hook = entries[0].hooks[0];
        expect(hook.timeout).toBeUndefined();
      }
    });

    it('all hooks use the mypilot curl command', () => {
      const config = buildHooksConfig();
      for (const [, entries] of Object.entries(config)) {
        for (const entry of entries) {
          for (const hook of entry.hooks) {
            expect(hook.command).toBe(MYPILOT_HOOK_COMMAND);
            expect(hook.type).toBe('command');
          }
        }
      }
    });
  });

  describe('mergeHooksIntoSettings', () => {
    it('creates settings.json with hooks when file does not exist', () => {
      const settingsPath = join(tmpDir, 'settings.json');
      const result = mergeHooksIntoSettings(settingsPath);

      expect(result.added.length).toBeGreaterThan(0);
      expect(result.skipped).toEqual([]);

      const written = JSON.parse(readFileSync(settingsPath, 'utf-8'));
      expect(written.hooks).toBeDefined();
      expect(Object.keys(written.hooks).length).toBeGreaterThan(0);
    });

    it('preserves existing non-hook settings', () => {
      const settingsPath = join(tmpDir, 'settings.json');
      writeFileSync(settingsPath, JSON.stringify({
        permissions: { allow: ['Read'] },
        someOtherSetting: true,
      }));

      mergeHooksIntoSettings(settingsPath);

      const written = JSON.parse(readFileSync(settingsPath, 'utf-8'));
      expect(written.permissions).toEqual({ allow: ['Read'] });
      expect(written.someOtherSetting).toBe(true);
      expect(written.hooks).toBeDefined();
    });

    it('adds missing hook events without touching existing ones', () => {
      const settingsPath = join(tmpDir, 'settings.json');
      // Pre-existing hooks from another tool
      const existingHooks = {
        PreToolUse: [
          {
            matcher: 'Bash',
            hooks: [{ type: 'command', command: 'some-other-tool' }],
          },
        ],
      };
      writeFileSync(settingsPath, JSON.stringify({ hooks: existingHooks }));

      const result = mergeHooksIntoSettings(settingsPath);

      // Should add mypilot hook alongside existing one
      expect(result.added).toContain('PreToolUse');

      const written = JSON.parse(readFileSync(settingsPath, 'utf-8'));
      // Existing hook entry should be preserved, mypilot appended
      expect(written.hooks.PreToolUse).toHaveLength(2);
      expect(written.hooks.PreToolUse[0].hooks[0].command).toBe('some-other-tool');
      expect(written.hooks.PreToolUse[1].hooks[0].command).toBe(MYPILOT_HOOK_COMMAND);
    });

    it('skips events that already have the mypilot command', () => {
      const settingsPath = join(tmpDir, 'settings.json');
      const config = buildHooksConfig();
      // Simulate user already has Notification hook from mypilot
      writeFileSync(settingsPath, JSON.stringify({
        hooks: {
          Notification: config.Notification,
        },
      }));

      const result = mergeHooksIntoSettings(settingsPath);

      expect(result.skipped).toContain('Notification');

      const written = JSON.parse(readFileSync(settingsPath, 'utf-8'));
      // Should not duplicate
      expect(written.hooks.Notification).toHaveLength(1);
    });

    it('returns added events list', () => {
      const settingsPath = join(tmpDir, 'settings.json');
      const result = mergeHooksIntoSettings(settingsPath);

      expect(result.added.length).toBeGreaterThan(10);
      // Should include common events
      expect(result.added).toContain('PreToolUse');
      expect(result.added).toContain('Notification');
      expect(result.added).toContain('SessionStart');
    });

    it('handles malformed JSON gracefully', () => {
      const settingsPath = join(tmpDir, 'settings.json');
      mkdirSync(join(tmpDir, 'claude'), { recursive: true });
      writeFileSync(settingsPath, '{ invalid json }');

      expect(() => mergeHooksIntoSettings(settingsPath)).toThrow(/invalid json/i);
    });

    it('handles settings with no hooks field', () => {
      const settingsPath = join(tmpDir, 'settings.json');
      writeFileSync(settingsPath, JSON.stringify({ permissions: {} }));

      const result = mergeHooksIntoSettings(settingsPath);

      expect(result.added.length).toBeGreaterThan(0);
      const written = JSON.parse(readFileSync(settingsPath, 'utf-8'));
      expect(written.hooks).toBeDefined();
      expect(written.permissions).toEqual({});
    });

    it('writes formatted JSON with 2-space indent', () => {
      const settingsPath = join(tmpDir, 'settings.json');
      mergeHooksIntoSettings(settingsPath);

      const content = readFileSync(settingsPath, 'utf-8');
      expect(content).toContain('  "hooks"');
      expect(content.endsWith('\n')).toBe(true);
    });
  });
});
