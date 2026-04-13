// ── Event classification ──

const USER_INTERACTION_EVENTS: ReadonlySet<string> = new Set([
  'PermissionRequest',
  'Stop',
  'Elicitation',
]);

export function isUserInteractionEvent(eventName: string): boolean {
  return USER_INTERACTION_EVENTS.has(eventName);
}

// ── Interactive tool detection (selective PreToolUse blocking) ──

const INTERACTIVE_TOOL_NAMES: ReadonlySet<string> = new Set([
  'AskUserQuestion',
  'ExitPlanMode',
]);

export function isInteractivePreToolUse(eventName: string, event: Record<string, unknown>): boolean {
  if (eventName !== 'PreToolUse') return false;
  const toolName = event.tool_name as string | undefined;
  return !!toolName && INTERACTIVE_TOOL_NAMES.has(toolName);
}
