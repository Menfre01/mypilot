import { describe, it, expect } from 'vitest';
import {
  isUserInteractionEvent,
  isInteractivePreToolUse,
} from './events.js';
import type { HookEventName } from './protocol.js';
import { SESSION_COLORS } from '../backend/gateway/session-store.js';

describe('Hook event classification', () => {
  const userInteractionEvents: HookEventName[] = [
    'PermissionRequest',
    'Stop',
    'Elicitation',
  ];

  describe('isUserInteractionEvent', () => {
    it('returns true for every user interaction event', () => {
      for (const name of userInteractionEvents) {
        expect(isUserInteractionEvent(name), `${name} should be user interaction`).toBe(true);
      }
    });

    it('returns false for other events', () => {
      const others: HookEventName[] = [
        'PostToolUse', 'PostToolUseFailure', 'PreToolUse',
        'SessionStart', 'UserPromptSubmit', 'SessionEnd',
        'Notification', 'SubagentStart', 'SubagentStop',
      ];
      for (const name of others) {
        expect(isUserInteractionEvent(name), `${name} should not be user interaction`).toBe(false);
      }
    });

    it('returns false for unknown event names', () => {
      expect(isUserInteractionEvent('UnknownEvent')).toBe(false);
      expect(isUserInteractionEvent('')).toBe(false);
    });
  });

  describe('isInteractivePreToolUse', () => {
    it('returns true for PreToolUse[AskUserQuestion]', () => {
      expect(isInteractivePreToolUse('PreToolUse', { tool_name: 'AskUserQuestion' })).toBe(true);
    });

    it('returns false for PreToolUse[Bash]', () => {
      expect(isInteractivePreToolUse('PreToolUse', { tool_name: 'Bash' })).toBe(false);
    });

    it('returns false for PreToolUse[Edit]', () => {
      expect(isInteractivePreToolUse('PreToolUse', { tool_name: 'Edit' })).toBe(false);
    });

    it('returns true for PreToolUse[ExitPlanMode]', () => {
      expect(isInteractivePreToolUse('PreToolUse', { tool_name: 'ExitPlanMode' })).toBe(true);
    });

    it('returns false for non-PreToolUse events', () => {
      expect(isInteractivePreToolUse('PermissionRequest', { tool_name: 'AskUserQuestion' })).toBe(false);
      expect(isInteractivePreToolUse('Stop', {})).toBe(false);
    });

    it('returns false when tool_name is missing', () => {
      expect(isInteractivePreToolUse('PreToolUse', {})).toBe(false);
    });
  });
});

describe('SESSION_COLORS', () => {
  it('has exactly 8 colors', () => {
    expect(SESSION_COLORS).toHaveLength(8);
  });

  it('contains the correct Catppuccin Mocha palette', () => {
    expect(SESSION_COLORS).toEqual([
      '#89b4fa', '#a6e3a1', '#f38ba8', '#f9e2af',
      '#b4befe', '#89dceb', '#fab387', '#cba6f7',
    ]);
  });
});
