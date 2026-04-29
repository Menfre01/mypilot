import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { HookEventName } from '../../shared/protocol.js';

// ── Constants ──

export const MYPILOT_HOOK_COMMAND =
  "curl --noproxy localhost --noproxy 127.0.0.1 -s -X POST 'http://127.0.0.1:16321/hook' -H 'Content-Type: application/json' -d @-";

/** Hook events that may block (need timeout). */
export const BLOCKING_HOOK_EVENTS: readonly HookEventName[] = [
  'PreToolUse',
  'PermissionRequest',
  'UserPromptSubmit',
  'Elicitation',
  'Stop',
];

/** Hook events that are informational (no timeout). */
export const INFO_HOOK_EVENTS: readonly HookEventName[] = [
  'PostToolUse',
  'PostToolUseFailure',
  'SessionStart',
  'SessionEnd',
  'InstructionsLoaded',
  'Notification',
  'SubagentStart',
  'SubagentStop',
  'StopFailure',
  'PermissionDenied',
  'ConfigChange',
  'CwdChanged',
  'FileChanged',
  'TaskCreated',
  'TaskCompleted',
  'TeammateIdle',
  'ElicitationResult',
  'WorktreeCreate',
  'WorktreeRemove',
  'PreCompact',
  'PostCompact',
];

// ── Types ──

interface HookEntry {
  type: 'command';
  command: string;
  timeout?: number;
}

interface MatcherGroup {
  matcher: string;
  hooks: HookEntry[];
}

type HooksMap = Record<string, MatcherGroup[]>;

export interface MergeResult {
  added: string[];
  skipped: string[];
}

// ── Build hooks config ──

function makeMatcherGroup(event: HookEventName): MatcherGroup {
  const hook: HookEntry = {
    type: 'command',
    command: MYPILOT_HOOK_COMMAND,
  };
  if ((BLOCKING_HOOK_EVENTS as readonly string[]).includes(event)) {
    hook.timeout = 999999;
  }
  return { matcher: '', hooks: [hook] };
}

/** Generate the full MyPilot hooks config. */
export function buildHooksConfig(): HooksMap {
  const config: HooksMap = {};
  const allEvents = [...BLOCKING_HOOK_EVENTS, ...INFO_HOOK_EVENTS];
  for (const event of allEvents) {
    config[event] = [makeMatcherGroup(event)];
  }
  return config;
}

// ── Merge into settings.json ──

const DEFAULT_SETTINGS_PATH = join(homedir(), '.claude', 'settings.json');

/** Check if a MatcherGroup array already contains the mypilot command. */
function hasMypilotHook(entries: MatcherGroup[]): boolean {
  return entries.some((entry) =>
    entry.hooks.some((hook) => hook.command === MYPILOT_HOOK_COMMAND),
  );
}

/**
 * Merge MyPilot hooks into a Claude Code settings.json file.
 * Preserves all existing configuration. Only adds hooks that are missing.
 *
 * @param settingsPath Path to settings.json (defaults to ~/.claude/settings.json)
 * @returns Lists of added and skipped event names
 */
export function mergeHooksIntoSettings(
  settingsPath: string = DEFAULT_SETTINGS_PATH,
): MergeResult {
  // Read existing settings
  let settings: Record<string, unknown>;
  try {
    const raw = readFileSync(settingsPath, 'utf-8');
    settings = JSON.parse(raw);
  } catch (err: unknown) {
    if (err instanceof SyntaxError) {
      throw new SyntaxError(`Invalid JSON in ${settingsPath}: ${err.message}`);
    }
    // File doesn't exist — start fresh
    settings = {};
  }

  // Ensure hooks field exists
  if (!settings.hooks || typeof settings.hooks !== 'object') {
    settings.hooks = {};
  }

  const hooks = settings.hooks as HooksMap;
  const mypilotConfig = buildHooksConfig();
  const added: string[] = [];
  const skipped: string[] = [];

  for (const [event, entries] of Object.entries(mypilotConfig)) {
    if (!hooks[event]) {
      // Event not configured at all — add it
      hooks[event] = entries;
      added.push(event);
    } else if (hasMypilotHook(hooks[event])) {
      // Already has the mypilot command — skip
      skipped.push(event);
    } else {
      // Has other hooks but not mypilot — append
      hooks[event] = [...hooks[event], ...entries];
      added.push(event);
    }
  }

  // Write back
  const dir = join(settingsPath, '..');
  mkdirSync(dir, { recursive: true });
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf-8');

  return { added, skipped };
}
