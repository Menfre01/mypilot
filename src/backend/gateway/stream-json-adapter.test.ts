import { describe, it, expect } from 'vitest';
import { adaptStreamJsonLine, extractInitSessionId } from './stream-json-adapter.js';

function makeSeq(): () => number {
  let n = 0;
  return () => ++n;
}

describe('adaptStreamJsonLine', () => {
  it('returns null for invalid JSON', () => {
    const result = adaptStreamJsonLine('not-json', makeSeq());
    expect(result).toBeNull();
  });

  it('returns null when session_id is missing', () => {
    const result = adaptStreamJsonLine(JSON.stringify({ type: 'assistant' }), makeSeq());
    expect(result).toBeNull();
  });

  // ── assistant / user messages ──

  it('adapts assistant message to transcript entry', () => {
    const line = JSON.stringify({
      type: 'assistant',
      session_id: 's1',
      message: {
        role: 'assistant',
        model: 'claude-sonnet-4-6',
        usage: { input_tokens: 100, output_tokens: 50 },
        content: [{ type: 'text', text: 'Hello!' }],
      },
    });

    const result = adaptStreamJsonLine(line, makeSeq());

    expect(result).not.toBeNull();
    expect(result!.sessionId).toBe('s1');
    expect(result!.seq).toBe(1);
    expect(result!.source).toBe('transcript');
    expect(result!.entry).toBeDefined();
    expect(result!.entry!.index).toBe(1); // 现在等于 seq 而不是 -1
    expect(result!.entry!.type).toBe('assistant');
    expect(result!.entry!.model).toBe('claude-sonnet-4-6');
    expect(result!.entry!.usage).toEqual({ input_tokens: 100, output_tokens: 50 });
    expect(result!.entry!.blocks).toBeDefined();
  });

  it('adapts user message to transcript entry with seq-based index', () => {
    const line = JSON.stringify({
      type: 'user',
      session_id: 's1',
      message: {
        role: 'user',
        content: [{ type: 'text', text: 'Hello Claude' }],
      },
    });

    const seqFn = makeSeq();
    seqFn(); // skip seq 1
    const result = adaptStreamJsonLine(line, seqFn);

    expect(result).not.toBeNull();
    expect(result!.seq).toBe(2);
    expect(result!.entry!.index).toBe(2);
    expect(result!.entry!.type).toBe('user');
  });

  it('returns null when classifyEntry fails for assistant message', () => {
    const line = JSON.stringify({
      type: 'assistant',
      session_id: 's1',
      message: null, // Will cause classifyEntry to fail
    });

    const result = adaptStreamJsonLine(line, makeSeq());
    expect(result).toBeNull();
  });

  // ── system / hook_started messages ──

  it('adapts hook_started system message to hook event', () => {
    const line = JSON.stringify({
      type: 'system',
      subtype: 'hook_started',
      session_id: 's1',
      hook_event: 'PreToolUse',
      hook_id: 'hook-123',
      hook_name: 'my-hook',
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
    });

    const result = adaptStreamJsonLine(line, makeSeq());

    expect(result).not.toBeNull();
    expect(result!.source).toBe('hook');
    expect(result!.event).toBeDefined();
    expect(result!.event!.event_name).toBe('PreToolUse');
    expect(result!.event!.event_id).toBe('hook-123');
    expect(result!.event!.hook_name).toBe('my-hook');
    expect(result!.event!.tool_name).toBe('Bash');
  });

  it('excludes stream-json internal fields from hook event', () => {
    const line = JSON.stringify({
      type: 'system',
      subtype: 'hook_started',
      session_id: 's1',
      hook_event: 'Notification',
      hook_id: 'h-1',
      // These fields should be excluded
      message: { some: 'data' },
      uuid: 'uuid-123',
      parent_tool_use_id: 'ptu-1',
      cwd: '/some/path',
      model: 'claude-sonnet-4-6',
      tools: ['Bash', 'Read'],
      usage: { input_tokens: 10 },
      duration_ms: 500,
      stop_reason: 'end_turn',
      // Custom hook field should be preserved
      custom_field: 'keep-me',
    });

    const result = adaptStreamJsonLine(line, makeSeq());

    expect(result).not.toBeNull();
    const event = result!.event!;
    // Internal fields excluded
    expect(event.message).toBeUndefined();
    expect(event.uuid).toBeUndefined();
    expect(event.parent_tool_use_id).toBeUndefined();
    expect(event.cwd).toBeUndefined();
    expect(event.model).toBeUndefined();
    expect(event.tools).toBeUndefined();
    expect(event.usage).toBeUndefined();
    expect(event.duration_ms).toBeUndefined();
    expect(event.stop_reason).toBeUndefined();
    // But type, subtype are also excluded (they're destructured)
    // Custom field preserved
    expect((event as any).custom_field).toBe('keep-me');
    // Core fields preserved
    expect(event.event_name).toBe('Notification');
    expect(event.event_id).toBe('h-1');
    expect(event.session_id).toBe('s1');
  });

  it('returns null for system message without hook_started subtype', () => {
    const line = JSON.stringify({
      type: 'system',
      subtype: 'init',
      session_id: 's1',
    });

    const result = adaptStreamJsonLine(line, makeSeq());
    expect(result).toBeNull();
  });

  it('returns null for hook_started without hook_event', () => {
    const line = JSON.stringify({
      type: 'system',
      subtype: 'hook_started',
      session_id: 's1',
    });

    const result = adaptStreamJsonLine(line, makeSeq());
    expect(result).toBeNull();
  });

  it('uses empty string for missing hook_id', () => {
    const line = JSON.stringify({
      type: 'system',
      subtype: 'hook_started',
      session_id: 's1',
      hook_event: 'Notification',
    });

    const result = adaptStreamJsonLine(line, makeSeq());
    expect(result!.event!.event_id).toBe('');
  });

  // ── result messages ──

  it('adapts result message to SessionEnd hook event', () => {
    const line = JSON.stringify({
      type: 'result',
      session_id: 's1',
      subtype: 'success',
      usage: { input_tokens: 200, output_tokens: 100 },
      duration_ms: 1500,
      stop_reason: 'end_turn',
    });

    const result = adaptStreamJsonLine(line, makeSeq());

    expect(result).not.toBeNull();
    expect(result!.source).toBe('hook');
    expect(result!.event!.event_name).toBe('SessionEnd');
    expect(result!.event!.subtype).toBe('success');
    expect(result!.event!.usage).toEqual({ input_tokens: 200, output_tokens: 100 });
    expect(result!.event!.duration_ms).toBe(1500);
    expect(result!.event!.stop_reason).toBe('end_turn');
  });

  it('result message without optional fields is still valid', () => {
    const line = JSON.stringify({
      type: 'result',
      session_id: 's1',
    });

    const result = adaptStreamJsonLine(line, makeSeq());

    expect(result).not.toBeNull();
    expect(result!.event!.event_name).toBe('SessionEnd');
    expect(result!.event!.event_id).toBe('');
  });

  // ── Unknown types ──

  it('returns null for unknown message type', () => {
    const line = JSON.stringify({
      type: 'unknown_type',
      session_id: 's1',
    });

    const result = adaptStreamJsonLine(line, makeSeq());
    expect(result).toBeNull();
  });

  // ── Timestamps ──

  it('includes timestamp in all adapted messages', () => {
    const before = Date.now();

    const line = JSON.stringify({
      type: 'system',
      subtype: 'hook_started',
      session_id: 's1',
      hook_event: 'Notification',
    });

    const result = adaptStreamJsonLine(line, makeSeq());

    expect(result!.timestamp).toBeGreaterThanOrEqual(before);
    expect(result!.event!.timestamp).toBeGreaterThanOrEqual(before);

    const after = Date.now();
    expect(result!.timestamp).toBeLessThanOrEqual(after);
  });
});

describe('extractInitSessionId', () => {
  it('extracts session_id from valid JSON', () => {
    const line = JSON.stringify({ type: 'system', subtype: 'init', session_id: 'abc-123' });
    expect(extractInitSessionId(line)).toBe('abc-123');
  });

  it('extracts session_id from hook_started message', () => {
    const line = JSON.stringify({
      type: 'system',
      subtype: 'hook_started',
      session_id: 'sess-456',
      hook_event: 'PreToolUse',
    });
    expect(extractInitSessionId(line)).toBe('sess-456');
  });

  it('returns null for invalid JSON', () => {
    expect(extractInitSessionId('not-json')).toBeNull();
  });

  it('returns null when session_id is missing', () => {
    expect(extractInitSessionId(JSON.stringify({ type: 'system' }))).toBeNull();
  });

  it('returns null when session_id is not a string', () => {
    expect(extractInitSessionId(JSON.stringify({ session_id: 123 }))).toBeNull();
  });
});
