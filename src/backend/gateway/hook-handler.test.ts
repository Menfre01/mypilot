import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { HookHandler } from './hook-handler.js';
import { SessionStore } from './session-store.js';
import { PendingStore } from './pending-store.js';
import { DeviceStore } from './device-store.js';
import { WsBus } from './ws-bus.js';
import type { GatewayMessage, ModelFeedback } from '../../shared/protocol.js';
import { makeTranscriptLine } from './ws-test-helpers.js';

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
  let deviceStore: DeviceStore;
  let wsBus: WsBus;
  let handler: HookHandler;

  beforeEach(() => {
    sessionStore = new SessionStore();
    pendingStore = new PendingStore();
    deviceStore = new DeviceStore();
    wsBus = new WsBus(randomBytes(32));
    handler = new HookHandler(sessionStore, pendingStore, deviceStore, wsBus);
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

  // ── Multi-device mutual exclusion ──

  it('switching takeover from device A to device B releases pending', async () => {
    handler.setMode('takeover', 'device-a');

    // Device A has a pending event
    const promise = handler.handleEvent(makeEvent('PermissionRequest', 's1'));

    // Device B takes over — should release all pending from A
    handler.setMode('takeover', 'device-b');

    // The pending promise should resolve with {}
    const result = await promise;
    expect(result).toEqual({});
    expect(handler.getTakeoverOwner()).toBe('device-b');
  });

  it('same device re-taking over is no-op', () => {
    const broadcasts = captureBroadcasts(wsBus);

    handler.setMode('takeover', 'device-a');
    const msgsAfterFirst = broadcasts.length;

    handler.setMode('takeover', 'device-a');
    expect(broadcasts.length).toBe(msgsAfterFirst); // no extra broadcast
    expect(handler.getTakeoverOwner()).toBe('device-a');
  });

  it('broadcasts takeoverOwner in mode_changed', () => {
    const broadcasts = captureBroadcasts(wsBus);

    handler.setMode('takeover', 'device-a');

    const modeChanged = broadcasts.filter(m => m.type === 'mode_changed');
    const last = modeChanged[modeChanged.length - 1];
    expect(last).toBeDefined();
    if (last!.type === 'mode_changed') {
      expect(last!.takeoverOwner).toBe('device-a');
    }
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

  // ── Transcript enrichment ──

  it('broadcasts event without model_feedback when transcript_path points to non-existent file', async () => {
    const broadcasts = captureBroadcasts(wsBus);
    const transcriptPath = '/fake/transcript.jsonl';

    await handler.handleEvent(
      makeEvent('PreToolUse', 's1', {
        transcript_path: transcriptPath,
        tool_use_id: 'call_test123',
      }),
    );

    // Event should be broadcast immediately without model_feedback (enrichment is async)
    const eventMsg = broadcasts.find((m) => m.type === 'event')!;
    const evt = (eventMsg as { type: 'event'; event: Record<string, unknown> }).event;
    expect(evt.event_name).toBe('PreToolUse');
    expect(evt.transcript_path).toBe(transcriptPath);
    expect(evt.model_feedback).toBeUndefined();
  });

  it('event without transcript_path has no model_feedback', async () => {
    const broadcasts = captureBroadcasts(wsBus);

    await handler.handleEvent(makeEvent('SessionStart', 's1'));

    const eventMsg = broadcasts.find((m) => m.type === 'event')!;
    const evt = (eventMsg as { type: 'event'; event: Record<string, unknown> }).event;
    expect(evt.model_feedback).toBeUndefined();
  });

  it('event with transcript_path but non-existent file still broadcasts successfully', async () => {
    const broadcasts = captureBroadcasts(wsBus);

    await handler.handleEvent(
      makeEvent('PostToolUse', 's1', {
        transcript_path: '/nonexistent/path.jsonl',
        tool_use_id: 'call_doesnotexist',
      }),
    );

    // Event should still be broadcast even though transcript reading failed
    const eventMsg = broadcasts.find((m) => m.type === 'event')!;
    expect(eventMsg).toBeDefined();
    const evt = (eventMsg as { type: 'event'; event: Record<string, unknown> }).event;
    expect(evt.event_name).toBe('PostToolUse');
    expect(evt.model_feedback).toBeUndefined();
  });

  it('event without tool_use_id skips enrichment even with transcript_path', async () => {
    const broadcasts = captureBroadcasts(wsBus);

    await handler.handleEvent(
      makeEvent('UserPromptSubmit', 's1', {
        transcript_path: '/fake/transcript.jsonl',
        prompt: 'hello',
      }),
    );

    const eventMsg = broadcasts.find((m) => m.type === 'event')!;
    const evt = (eventMsg as { type: 'event'; event: Record<string, unknown> }).event;
    expect(evt.model_feedback).toBeUndefined();
    expect(evt.prompt).toBe('hello');
  });

  // ── Async enrichment ──

  describe('async enrichment', () => {
    let tempDir: string;
    let transcriptPath: string;

    const toolUseId = 'call_enrich_test';

    function setupTranscript(): string {
      tempDir = mkdtempSync(join(tmpdir(), 'mypilot-hh-test-'));
      transcriptPath = join(tempDir, 'transcript.jsonl');

      const lines = [
        makeTranscriptLine({
          type: 'assistant',
          message: {
            model: 'claude-opus-4-7',
            usage: { input_tokens: 1000, output_tokens: 200 },
            content: [
              { type: 'thinking', thinking: 'I should read the file first' },
              { type: 'text', text: 'Let me check the configuration.' },
              { type: 'tool_use', id: toolUseId, name: 'Read', input: {} },
            ],
          },
        }),
        makeTranscriptLine({
          type: 'user',
          message: {
            content: [
              { type: 'tool_result', tool_use_id: toolUseId, content: '{"port": 8080}', isError: false },
            ],
          },
        }),
      ];

      writeFileSync(transcriptPath, lines.join(''), 'utf-8');
      return transcriptPath;
    }

    afterEach(() => {
      try { rmSync(tempDir, { recursive: true, force: true }); } catch {}
    });

    it('sends event_enrichment for PreToolUse with thinking and text', async () => {
      const path = setupTranscript();
      const broadcasts = captureBroadcasts(wsBus);

      const promise = handler.handleEvent(
        makeEvent('PreToolUse', 's1', {
          transcript_path: path,
          tool_use_id: toolUseId,
          tool_name: 'Read',
        }),
      );

      // handleEvent returns immediately (sync path for bystander PreToolUse)
      const result = await promise;
      expect(result).toEqual({});

      // Event was broadcast without model_feedback
      const eventMsg = broadcasts.find((m) => m.type === 'event')!;
      expect(eventMsg).toBeDefined();
      const evt = (eventMsg as { type: 'event'; event: Record<string, unknown> }).event;
      expect(evt.model_feedback).toBeUndefined();

      // Wait for async enrichment to complete (it's fire-and-forget)
      await vi.waitFor(() => {
        const enrichment = broadcasts.find((m) => m.type === 'event_enrichment');
        expect(enrichment).toBeDefined();
      }, { timeout: 2000, interval: 50 });

      const enrichment = broadcasts.find((m) => m.type === 'event_enrichment')!;
      const mf = (enrichment as { type: 'event_enrichment'; model_feedback: ModelFeedback }).model_feedback;
      expect(mf.model).toBe('claude-opus-4-7');
      expect(mf.thinking).toBe('I should read the file first');
      expect(mf.text).toBe('Let me check the configuration.');
      expect(mf.usage).toBeDefined();
    });

    it('sends event_enrichment for PostToolUse with tool_result only', async () => {
      const path = setupTranscript();
      const broadcasts = captureBroadcasts(wsBus);

      const promise = handler.handleEvent(
        makeEvent('PostToolUse', 's1', {
          transcript_path: path,
          tool_use_id: toolUseId,
          tool_name: 'Read',
        }),
      );

      await promise;

      await vi.waitFor(() => {
        const enrichment = broadcasts.find((m) => m.type === 'event_enrichment');
        expect(enrichment).toBeDefined();
      }, { timeout: 2000, interval: 50 });

      const enrichment = broadcasts.find((m) => m.type === 'event_enrichment')!;
      const mf = (enrichment as { type: 'event_enrichment'; model_feedback: ModelFeedback }).model_feedback;
      expect(mf.model).toBe('claude-opus-4-7');
      expect(mf.tool_result).toBe('{"port": 8080}');
      // PostToolUse strips thinking and text
      expect(mf.thinking).toBeUndefined();
      expect(mf.text).toBeUndefined();
    });

    it('does not send event_enrichment when transcript has no matching entry', async () => {
      tempDir = mkdtempSync(join(tmpdir(), 'mypilot-hh-test-'));
      transcriptPath = join(tempDir, 'transcript.jsonl');
      // Write a transcript without the tool_use we reference
      writeFileSync(transcriptPath, makeTranscriptLine({
        type: 'assistant',
        message: {
          model: 'old-model',
          usage: {},
          content: [{ type: 'tool_use', id: 'some_other_call', name: 'Bash', input: {} }],
        },
      }), 'utf-8');

      const broadcasts = captureBroadcasts(wsBus);

      await handler.handleEvent(
        makeEvent('PreToolUse', 's1', {
          transcript_path: transcriptPath,
          tool_use_id: 'non_matching_call',
          tool_name: 'Bash',
        }),
      );

      // Give async enrichment time to fail
      await new Promise((r) => setTimeout(r, 600));

      // Only the event broadcast, no event_enrichment
      const enrichmentMsgs = broadcasts.filter((m) => m.type === 'event_enrichment');
      expect(enrichmentMsgs).toHaveLength(0);
    });

    it('enrichment updates event in history for reconnecting clients', async () => {
      const path = setupTranscript();
      const broadcasts = captureBroadcasts(wsBus);

      await handler.handleEvent(
        makeEvent('PreToolUse', 's1', {
          transcript_path: path,
          tool_use_id: toolUseId,
          tool_name: 'Read',
        }),
      );

      await vi.waitFor(() => {
        const enrichment = broadcasts.find((m) => m.type === 'event_enrichment');
        expect(enrichment).toBeDefined();
      }, { timeout: 2000, interval: 50 });

      // History now includes model_feedback
      const history = handler.getEventHistory();
      const enrichedEvent = history.find(
        (e) => e.event.event_id !== undefined && e.sessionId === 's1',
      );
      expect(enrichedEvent).toBeDefined();
      expect(enrichedEvent!.event.model_feedback).toBeDefined();
      expect(enrichedEvent!.event.model_feedback!.model).toBe('claude-opus-4-7');
    });

    it('gracefully handles enrichment errors without affecting event delivery', async () => {
      // Use a path that will cause extractModelFeedback to throw (directory as file)
      tempDir = mkdtempSync(join(tmpdir(), 'mypilot-hh-test-'));
      const path = join(tempDir, 'transcript.jsonl');
      // Create a directory with the same name to cause a read error
      mkdirSync(path);

      const broadcasts = captureBroadcasts(wsBus);

      const result = await handler.handleEvent(
        makeEvent('PreToolUse', 's1', {
          transcript_path: path,
          tool_use_id: 'call_whatever',
          tool_name: 'Bash',
        }),
      );

      // Event was still broadcast
      expect(result).toEqual({});
      const eventMsg = broadcasts.find((m) => m.type === 'event');
      expect(eventMsg).toBeDefined();

      // Give async enrichment time to try and fail
      await new Promise((r) => setTimeout(r, 600));

      // No enrichment message sent
      const enrichmentMsgs = broadcasts.filter((m) => m.type === 'event_enrichment');
      expect(enrichmentMsgs).toHaveLength(0);
    });
  });

  it('adds timestamp to every event', async () => {
    const broadcasts = captureBroadcasts(wsBus);

    await handler.handleEvent(makeEvent('SessionStart', 's1'));

    const eventMsg = broadcasts.find((m) => m.type === 'event')!;
    const evt = (eventMsg as { type: 'event'; event: Record<string, unknown> }).event;
    expect(evt.timestamp).toBeTypeOf('number');
    expect(evt.timestamp).toBeGreaterThan(0);
  });

  it('timestamp is monotonically increasing', async () => {
    const broadcasts = captureBroadcasts(wsBus);

    await handler.handleEvent(makeEvent('PreToolUse', 's1'));
    await handler.handleEvent(makeEvent('PostToolUse', 's1'));

    const eventMsgs = broadcasts.filter(m => m.type === 'event');
    const t1 = (eventMsgs[0].event as Record<string, unknown>).timestamp as number;
    const t2 = (eventMsgs[1].event as Record<string, unknown>).timestamp as number;
    expect(t2).toBeGreaterThanOrEqual(t1);
  });
});
