import { describe, it, expect, vi, beforeEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import { HookHandler } from './hook-handler.js';
import { SessionStore } from './session-store.js';
import { PendingStore } from './pending-store.js';
import { WsBus } from './ws-bus.js';
import type { GatewayMessage } from '../../shared/protocol.js';

// ── Helpers ──

function makeEvent(hook_event_name: string, sessionId = 'session-1', extra?: Record<string, unknown>): string {
  return JSON.stringify({ session_id: sessionId, hook_event_name, ...extra });
}

function captureBroadcasts(bus: WsBus): GatewayMessage[] {
  const messages: GatewayMessage[] = [];
  const orig = bus.broadcast.bind(bus);
  bus.broadcast = (msg: GatewayMessage) => {
    messages.push(msg);
    orig(msg);
  };
  return messages;
}

// ── Tests ──

describe('HookHandler', () => {
  let sessionStore: SessionStore;
  let pendingStore: PendingStore;
  let wsBus: WsBus;
  let handler: HookHandler;

  beforeEach(() => {
    sessionStore = new SessionStore();
    pendingStore = new PendingStore();
    wsBus = new WsBus(randomBytes(32));
    handler = new HookHandler(sessionStore, pendingStore, wsBus);
  });

  // ── Mode management ──

  it('defaults to bystander mode', () => {
    expect(handler.getMode()).toBe('bystander');
  });

  it('setMode switches mode', () => {
    handler.setMode('takeover');
    expect(handler.getMode()).toBe('takeover');

    handler.setMode('bystander');
    expect(handler.getMode()).toBe('bystander');
  });

  // ── Bystander mode: all events return {} immediately ──

  it('bystander mode returns {} for PermissionRequest', async () => {
    const result = await handler.handleEvent(makeEvent('PermissionRequest'));
    expect(result).toEqual({});
  });

  it('bystander mode returns {} for PostToolUse', async () => {
    const result = await handler.handleEvent(makeEvent('PostToolUse'));
    expect(result).toEqual({});
  });

  it('bystander mode returns {} for SessionStart', async () => {
    const result = await handler.handleEvent(makeEvent('SessionStart'));
    expect(result).toEqual({});
  });

  it('bystander mode returns {} for Notification', async () => {
    const result = await handler.handleEvent(makeEvent('Notification'));
    expect(result).toEqual({});
  });

  it('bystander mode returns {} for PreToolUse', async () => {
    const result = await handler.handleEvent(makeEvent('PreToolUse'));
    expect(result).toEqual({});
  });

  it('bystander mode still broadcasts events to frontend', async () => {
    const broadcasts = captureBroadcasts(wsBus);

    await handler.handleEvent(makeEvent('PreToolUse', 's1', { tool_name: 'Bash' }));

    expect(broadcasts.length).toBeGreaterThanOrEqual(1);
    const eventMsg = broadcasts.find((m) => m.type === 'event');
    expect(eventMsg).toBeDefined();
    expect(eventMsg!.type).toBe('event');
    if (eventMsg!.type === 'event') {
      expect(eventMsg!.sessionId).toBe('s1');
      expect(eventMsg!.event.session_id).toBe('s1');
    }
  });

  // ── Takeover mode ──

  describe('takeover mode', () => {
    beforeEach(() => {
      handler.setMode('takeover');
    });

    // User interaction events: blocks and waits for response

    it('PermissionRequest blocks and waits for response', async () => {
      const broadcasts = captureBroadcasts(wsBus);
      const promise = handler.handleEvent(makeEvent('PermissionRequest', 's2', { message: 'Allow?' }));

      await Promise.resolve();

      const taggedMsg = broadcasts.filter(m => m.type === 'event').find(m => (m.event as any).event_id);
      expect(taggedMsg).toBeDefined();
      expect(taggedMsg!.sessionId).toBe('s2');
      expect((taggedMsg!.event as any).message).toBe('Allow?');

      const eventId = (taggedMsg!.event as any).event_id;
      pendingStore.resolve('s2', eventId, { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } });

      const result = await promise;
      expect(result).toEqual({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } });
    });

    it('Stop blocks and waits for response', async () => {
      const broadcasts = captureBroadcasts(wsBus);
      const promise = handler.handleEvent(makeEvent('Stop', 's1'));

      await Promise.resolve();

      const taggedMsg = broadcasts.filter(m => m.type === 'event').find(m => (m.event as any).event_id);
      expect(taggedMsg).toBeDefined();

      const eventId = (taggedMsg!.event as any).event_id;
      pendingStore.resolve('s1', eventId, { decision: 'block', reason: 'keep going' });

      const result = await promise;
      expect(result).toEqual({ decision: 'block', reason: 'keep going' });
    });

    it('Elicitation blocks and waits for response', async () => {
      const broadcasts = captureBroadcasts(wsBus);
      const promise = handler.handleEvent(makeEvent('Elicitation', 's1', { message: 'Name?' }));

      await Promise.resolve();

      const taggedMsg = broadcasts.filter(m => m.type === 'event').find(m => (m.event as any).event_id);
      expect(taggedMsg).toBeDefined();

      const eventId = (taggedMsg!.event as any).event_id;
      pendingStore.resolve('s1', eventId, { hookSpecificOutput: { hookEventName: 'Elicitation', action: 'accept', content: { answer: 'Alice' } } });

      const result = await promise;
      expect(result).toEqual({ hookSpecificOutput: { hookEventName: 'Elicitation', action: 'accept', content: { answer: 'Alice' } } });
    });

    // AskUserQuestion (PreToolUse) — selective blocking

    it('PreToolUse[AskUserQuestion] blocks in takeover mode', async () => {
      const broadcasts = captureBroadcasts(wsBus);
      const promise = handler.handleEvent(makeEvent('PreToolUse', 's1', { tool_name: 'AskUserQuestion' }));

      await Promise.resolve();

      const taggedMsg = broadcasts.filter(m => m.type === 'event').find(m => (m.event as any).event_id);
      expect(taggedMsg).toBeDefined();

      const eventId = (taggedMsg!.event as any).event_id;
      pendingStore.resolve('s1', eventId, { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } });

      const result = await promise;
      expect(result).toEqual({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } });
    });

    it('PreToolUse[Bash] does NOT block in takeover mode', async () => {
      const result = await handler.handleEvent(makeEvent('PreToolUse', 's1', { tool_name: 'Bash' }));
      expect(result).toEqual({});
    });

    it('PreToolUse[Edit] does NOT block in takeover mode', async () => {
      const result = await handler.handleEvent(makeEvent('PreToolUse', 's1', { tool_name: 'Edit' }));
      expect(result).toEqual({});
    });

    // Category 2: auto-approve — returns {} immediately

    it('PostToolUse returns {} immediately', async () => {
      const result = await handler.handleEvent(makeEvent('PostToolUse'));
      expect(result).toEqual({});
    });

    it('PostToolUse broadcasts to frontend', async () => {
      const broadcasts = captureBroadcasts(wsBus);
      await handler.handleEvent(makeEvent('PostToolUse', 's1'));
      const eventMsg = broadcasts.find((m) => m.type === 'event');
      expect(eventMsg).toBeDefined();
    });

    // Category 3: info — returns {} immediately

    it('Notification returns {} immediately', async () => {
      const result = await handler.handleEvent(makeEvent('Notification'));
      expect(result).toEqual({});
    });

    it('SubagentStop returns {} immediately (not interactive)', async () => {
      const result = await handler.handleEvent(makeEvent('SubagentStop', 's1'));
      expect(result).toEqual({});
    });

    it('Notification broadcasts to frontend', async () => {
      const broadcasts = captureBroadcasts(wsBus);
      await handler.handleEvent(makeEvent('Notification', 's1'));
      const eventMsg = broadcasts.find((m) => m.type === 'event');
      expect(eventMsg).toBeDefined();
    });
  });

  // ── Session management ──

  it('registers session on first event from new session_id', async () => {
    expect(sessionStore.has('new-session')).toBe(false);

    await handler.handleEvent(makeEvent('Notification', 'new-session'));

    expect(sessionStore.has('new-session')).toBe(true);
  });

  it('session_start broadcast for SessionStart event', async () => {
    const broadcasts = captureBroadcasts(wsBus);

    await handler.handleEvent(makeEvent('SessionStart', 's-start'));

    const startMsg = broadcasts.find((m) => m.type === 'session_start');
    expect(startMsg).toBeDefined();
    if (startMsg!.type === 'session_start') {
      expect(startMsg!.session.id).toBe('s-start');
    }
  });

  it('session_end unregisters session on SessionEnd event', async () => {
    // Register first
    await handler.handleEvent(makeEvent('SessionStart', 's-end'));
    expect(sessionStore.has('s-end')).toBe(true);

    // End session
    await handler.handleEvent(makeEvent('SessionEnd', 's-end'));
    expect(sessionStore.has('s-end')).toBe(false);
  });

  it('session_end broadcasts session_end message', async () => {
    const broadcasts = captureBroadcasts(wsBus);

    await handler.handleEvent(makeEvent('SessionEnd', 's-end'));

    const endMsg = broadcasts.find((m) => m.type === 'session_end');
    expect(endMsg).toBeDefined();
    if (endMsg!.type === 'session_end') {
      expect(endMsg!.sessionId).toBe('s-end');
    }
  });

  // ── Mode switching ──

  it('switching from takeover to bystander releases all pending', async () => {
    handler.setMode('takeover');

    // Create a pending event that blocks
    const promise = handler.handleEvent(makeEvent('PermissionRequest', 's1'));

    // Switch to bystander — should release all pending
    handler.setMode('bystander');

    // The pending promise should resolve with {}
    const result = await promise;
    expect(result).toEqual({});
  });

  it('takeover to bystander releases multiple pending across sessions', async () => {
    handler.setMode('takeover');

    const p1 = handler.handleEvent(makeEvent('PermissionRequest', 's1'));
    const p2 = handler.handleEvent(makeEvent('Stop', 's2'));
    const p3 = handler.handleEvent(makeEvent('Elicitation', 's3'));

    handler.setMode('bystander');

    await expect(p1).resolves.toEqual({});
    await expect(p2).resolves.toEqual({});
    await expect(p3).resolves.toEqual({});
  });

  it('bystander mode never blocks even after takeover mode was active', async () => {
    handler.setMode('takeover');
    handler.setMode('bystander');

    // PermissionRequest should return {} in bystander mode
    const result = await handler.handleEvent(makeEvent('PermissionRequest'));
    expect(result).toEqual({});
  });

  it('takeover mode blocking event broadcasts only once', async () => {
    handler.setMode('takeover');
    const broadcasts = captureBroadcasts(wsBus);

    const promise = handler.handleEvent(makeEvent('PermissionRequest', 's1'));
    await Promise.resolve();

    // Should be exactly 1 event broadcast (with event_id), not 2
    const eventMsgs = broadcasts.filter((m) => m.type === 'event');
    expect(eventMsgs).toHaveLength(1);
    expect((eventMsgs[0].event as any).event_id).toBeDefined();

    // Clean up
    const eventId = (eventMsgs[0].event as any).event_id;
    pendingStore.resolve('s1', eventId, {});
    await promise;
  });

  // ── Error handling ──

  it('throws on invalid JSON body', async () => {
    await expect(handler.handleEvent('not json')).rejects.toThrow();
  });

  it('throws on missing session_id', async () => {
    await expect(handler.handleEvent(JSON.stringify({ hook_event_name: 'Notification' }))).rejects.toThrow();
  });

  // ── Event with extra fields preserved ──

  it('preserves all fields from the original event in broadcast', async () => {
    const broadcasts = captureBroadcasts(wsBus);

    await handler.handleEvent(makeEvent('PreToolUse', 's1', { tool_name: 'Bash', input: { command: 'ls' } }));

    const eventMsg = broadcasts.find((m) => m.type === 'event');
    expect(eventMsg).toBeDefined();
    if (eventMsg!.type === 'event') {
      expect((eventMsg!.event as any).tool_name).toBe('Bash');
      expect((eventMsg!.event as any).input).toEqual({ command: 'ls' });
    }
  });

  // ── Sequence numbers ──

  it('assigns monotonically increasing event_id (base36 seq)', async () => {
    const broadcasts = captureBroadcasts(wsBus);

    await handler.handleEvent(makeEvent('PreToolUse', 's1'));
    await handler.handleEvent(makeEvent('PostToolUse', 's1'));
    await handler.handleEvent(makeEvent('Notification', 's1'));

    const eventMsgs = broadcasts.filter(m => m.type === 'event');
    const ids = eventMsgs.map(m => (m.event as any).event_id as string);

    // Parse base36 and verify increasing
    const seqs = ids.map(id => parseInt(id, 36));
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i]).toBeGreaterThan(seqs[i - 1]);
    }
  });

  it('event_id is parseable as base36 integer', async () => {
    const broadcasts = captureBroadcasts(wsBus);
    await handler.handleEvent(makeEvent('Notification', 's1'));

    // First broadcast is session_start (new session auto-registration), second is the event
    const eventMsg = broadcasts.find((m) => m.type === 'event')!;
    const eventId = ((eventMsg as { type: 'event'; event: any }).event).event_id as string;
    const seq = parseInt(eventId, 36);
    expect(seq).toBeGreaterThan(0);
    expect(Number.isInteger(seq)).toBe(true);
  });

  it('event history returns events with seq-based event_ids', async () => {
    await handler.handleEvent(makeEvent('SessionStart', 's1'));
    await handler.handleEvent(makeEvent('PreToolUse', 's1'));
    await handler.handleEvent(makeEvent('PostToolUse', 's1'));

    const history = handler.getEventHistory();
    expect(history.length).toBe(3);

    const seqs = history.map(e => parseInt(e.event.event_id as string, 36));
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i]).toBeGreaterThan(seqs[i - 1]);
    }
  });
});
