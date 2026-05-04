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
import type { GatewayMessage } from '../../shared/protocol.js';
import { makeTranscriptLine } from './ws-test-helpers.js';
import { EventLogger } from './event-logger.js';
import { SessionStreamManager } from './session-stream-manager.js';
import { PushService } from './push-service.js';

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
  let logDir: string;
  let eventLogger: EventLogger;
  let streamManager: SessionStreamManager;

  beforeEach(() => {
    sessionStore = new SessionStore();
    pendingStore = new PendingStore();
    deviceStore = new DeviceStore();
    wsBus = new WsBus(randomBytes(32));
    logDir = mkdtempSync(join(tmpdir(), 'mypilot-hh-log-'));
    eventLogger = new EventLogger(logDir);
    streamManager = new SessionStreamManager(eventLogger, wsBus, {
      pipelineCapacity: 20,
    });
    handler = new HookHandler(sessionStore, pendingStore, deviceStore, wsBus);
    handler.setStreamManager(streamManager);
  });

  afterEach(() => {
    if (logDir) rmSync(logDir, { recursive: true, force: true });
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

  it('bystander mode 事件推送到管道', async () => {
    await handler.handleEvent(makeEvent('PreToolUse', 's1', { tool_name: 'Bash' }));

    const msgs = streamManager.pull(10);
    const eventMsg = msgs.find(m => m.source === 'hook');
    expect(eventMsg).toBeDefined();
    expect(eventMsg!.sessionId).toBe('s1');
    if (eventMsg!.event) {
      expect(eventMsg!.event.tool_name).toBe('Bash');
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
      const promise = handler.handleEvent(makeEvent('PermissionRequest', 's2', { message: 'Allow?' }));

      await Promise.resolve();

      const msgs = streamManager.pull(10);
      const taggedMsg = msgs.find(m => m.source === 'hook');
      expect(taggedMsg).toBeDefined();
      expect(taggedMsg!.sessionId).toBe('s2');
      expect(taggedMsg!.event!.message).toBe('Allow?');

      const eventId = taggedMsg!.event!.event_id as string;
      pendingStore.resolve('s2', eventId, { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } });

      const result = await promise;
      expect(result).toEqual({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } });
    });

    it('Stop blocks and waits for response', async () => {
      const promise = handler.handleEvent(makeEvent('Stop', 's1'));

      await Promise.resolve();

      const msgs = streamManager.pull(10);
      const taggedMsg = msgs.find(m => m.source === 'hook');
      expect(taggedMsg).toBeDefined();

      const eventId = taggedMsg!.event!.event_id as string;
      pendingStore.resolve('s1', eventId, { decision: 'block', reason: 'keep going' });

      const result = await promise;
      expect(result).toEqual({ decision: 'block', reason: 'keep going' });
    });

    it('Elicitation blocks and waits for response', async () => {
      const promise = handler.handleEvent(makeEvent('Elicitation', 's1', { message: 'Name?' }));

      await Promise.resolve();

      const msgs = streamManager.pull(10);
      const taggedMsg = msgs.find(m => m.source === 'hook');
      expect(taggedMsg).toBeDefined();

      const eventId = taggedMsg!.event!.event_id as string;
      pendingStore.resolve('s1', eventId, { hookSpecificOutput: { hookEventName: 'Elicitation', action: 'accept', content: { answer: 'Alice' } } });

      const result = await promise;
      expect(result).toEqual({ hookSpecificOutput: { hookEventName: 'Elicitation', action: 'accept', content: { answer: 'Alice' } } });
    });

    // AskUserQuestion (PreToolUse) — selective blocking

    it('PreToolUse[AskUserQuestion] blocks in takeover mode', async () => {
      const promise = handler.handleEvent(makeEvent('PreToolUse', 's1', { tool_name: 'AskUserQuestion' }));

      await Promise.resolve();

      const msgs = streamManager.pull(10);
      const taggedMsg = msgs.find(m => m.source === 'hook');
      expect(taggedMsg).toBeDefined();

      const eventId = taggedMsg!.event!.event_id as string;
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

    it('PostToolUse 推送到管道', async () => {
      await handler.handleEvent(makeEvent('PostToolUse', 's1'));
      const msgs = streamManager.pull(10);
      const eventMsg = msgs.find(m => m.source === 'hook');
      expect(eventMsg).toBeDefined();
      expect(eventMsg!.event?.event_name).toBe('PostToolUse');
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

    it('Notification 推送到管道', async () => {
      await handler.handleEvent(makeEvent('Notification', 's1'));
      const msgs = streamManager.pull(10);
      const eventMsg = msgs.find(m => m.source === 'hook');
      expect(eventMsg).toBeDefined();
      expect(eventMsg!.event?.event_name).toBe('Notification');
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

  it('takeover 模式阻塞事件只推入管道一次', async () => {
    handler.setMode('takeover');

    const promise = handler.handleEvent(makeEvent('PermissionRequest', 's1'));
    await Promise.resolve();

    // 应该恰好一条消息在管道中
    const msgs = streamManager.pull(10);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].event?.event_id).toBeDefined();

    // Clean up
    const eventId = msgs[0].event!.event_id as string;
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

  it('保留原始事件中的所有字段', async () => {
    await handler.handleEvent(makeEvent('PreToolUse', 's1', { tool_name: 'Bash', input: { command: 'ls' } }));

    const msgs = streamManager.pull(10);
    const msg = msgs.find(m => m.source === 'hook');
    expect(msg).toBeDefined();
    expect(msg!.event?.tool_name).toBe('Bash');
    expect(msg!.event?.input).toEqual({ command: 'ls' });
  });

  // ── Sequence numbers ──

  it('hook 和 transcript 共享统一的 seq 计数器', async () => {
    // hook 事件使用 streamManager.nextSeqFn() 获取 seq
    await handler.handleEvent(makeEvent('PreToolUse', 's1'));

    // transcript entry 也使用 streamManager.nextSeqFn() 获取 seq
    const transcriptSeq = streamManager.nextSeqFn();
    streamManager.push({
      sessionId: 's1', seq: transcriptSeq, timestamp: Date.now(), source: 'transcript',
      entry: { index: 0, type: 'assistant', timestamp: Date.now(), blocks: [] },
    });

    // 再一个 hook 事件
    await handler.handleEvent(makeEvent('PostToolUse', 's1'));

    const msgs = streamManager.pull(10);
    // 顺序应为: hook(seq=1), transcript(seq=2), hook(seq=3)
    expect(msgs).toHaveLength(3);
    expect(msgs[0].seq).toBe(1);
    expect(msgs[0].source).toBe('hook');
    expect(msgs[1].seq).toBe(2);
    expect(msgs[1].source).toBe('transcript');
    expect(msgs[2].seq).toBe(3);
    expect(msgs[2].source).toBe('hook');
  });

  it('分配单调递增的 event_id (base36 seq)', async () => {
    await handler.handleEvent(makeEvent('PreToolUse', 's1'));
    await handler.handleEvent(makeEvent('PostToolUse', 's1'));
    await handler.handleEvent(makeEvent('Notification', 's1'));

    const msgs = streamManager.pull(10);
    const hookMsgs = msgs.filter(m => m.source === 'hook');
    const ids = hookMsgs.map(m => m.event!.event_id as string);

    const seqs = ids.map(id => parseInt(id, 36));
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i]).toBeGreaterThan(seqs[i - 1]);
    }
  });

  it('event_id 可解析为 base36 整数', async () => {
    await handler.handleEvent(makeEvent('Notification', 's1'));

    const msgs = streamManager.pull(10);
    const hookMsg = msgs.find(m => m.source === 'hook')!;
    const eventId = hookMsg.event!.event_id as string;
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

  // ── 事件推送到管道 ──

  it('有 transcript_path 时事件推送到管道', async () => {
    const transcriptPath = '/fake/transcript.jsonl';

    await handler.handleEvent(
      makeEvent('PreToolUse', 's1', {
        transcript_path: transcriptPath,
        tool_use_id: 'call_test123',
      }),
    );

    const msgs = streamManager.pull(10);
    const hookMsg = msgs.find(m => m.source === 'hook');
    expect(hookMsg).toBeDefined();
    expect(hookMsg!.event?.event_name).toBe('PreToolUse');
    expect(hookMsg!.event?.transcript_path).toBe(transcriptPath);
  });

  it('SessionStart 事件推送到管道', async () => {
    await handler.handleEvent(makeEvent('SessionStart', 's1'));

    const msgs = streamManager.pull(10);
    const hookMsg = msgs.find(m => m.source === 'hook');
    expect(hookMsg).toBeDefined();
  });

  it('无 tool_use_id 的事件推送到管道', async () => {
    await handler.handleEvent(
      makeEvent('UserPromptSubmit', 's1', {
        transcript_path: '/fake/transcript.jsonl',
        prompt: 'hello',
      }),
    );

    const msgs = streamManager.pull(10);
    const hookMsg = msgs.find(m => m.source === 'hook');
    expect(hookMsg).toBeDefined();
    expect(hookMsg!.event?.prompt).toBe('hello');
  });

  it('为每个事件添加 timestamp', async () => {
    await handler.handleEvent(makeEvent('SessionStart', 's1'));

    const msgs = streamManager.pull(10);
    const hookMsg = msgs.find(m => m.source === 'hook')!;
    expect(hookMsg.timestamp).toBeTypeOf('number');
    expect(hookMsg.timestamp).toBeGreaterThan(0);
  });

  it('timestamp 单调递增', async () => {
    await handler.handleEvent(makeEvent('PreToolUse', 's1'));
    await handler.handleEvent(makeEvent('PostToolUse', 's1'));

    const msgs = streamManager.pull(10);
    const hookMsgs = msgs.filter(m => m.source === 'hook');
    expect(hookMsgs.length).toBeGreaterThanOrEqual(2);
    expect(hookMsgs[1].timestamp).toBeGreaterThanOrEqual(hookMsgs[0].timestamp);
  });

  // ── 消息管道推送 ──

  describe('消息管道推送', () => {
    it('hook 事件推送到管道（非直接广播）', async () => {
      await handler.handleEvent(makeEvent('PreToolUse', 's1', {
        tool_name: 'Bash',
        tool_use_id: 'tu1',
      }));

      // 事件进入管道，不再直接广播
      const msgs = streamManager.pull(10);
      expect(msgs.length).toBeGreaterThanOrEqual(1);
      const hookMsg = msgs.find(m => m.source === 'hook');
      expect(hookMsg).toBeDefined();
      expect(hookMsg!.sessionId).toBe('s1');
      expect(hookMsg!.event?.event_name).toBe('PreToolUse');
    });

    it('Notification 推送到管道', async () => {
      await handler.handleEvent(makeEvent('Notification', 's1'));

      const msgs = streamManager.pull(10);
      expect(msgs.some(m => m.event?.event_name === 'Notification')).toBe(true);
    });

    it('SessionStart 触发 streamManager.startSession', async () => {
      const spy = vi.spyOn(streamManager, 'startSession');

      await handler.handleEvent(makeEvent('SessionStart', 's1', {
        transcript_path: '/tmp/transcript.jsonl',
      }));

      expect(spy).toHaveBeenCalledWith('s1', '/tmp/transcript.jsonl');
    });

    it('SessionEnd 触发 streamManager.stopSession', async () => {
      const spy = vi.spyOn(streamManager, 'stopSession');

      await handler.handleEvent(makeEvent('SessionEnd', 's1'));

      expect(spy).toHaveBeenCalledWith('s1');
    });

    it('SessionEnd 仍然广播 session_end', async () => {
      const broadcasts = captureBroadcasts(wsBus);
      // 先注册 session
      await handler.handleEvent(makeEvent('SessionStart', 's1'));

      await handler.handleEvent(makeEvent('SessionEnd', 's1'));

      const endMsg = broadcasts.find((m) => m.type === 'session_end');
      expect(endMsg).toBeDefined();
    });

    it('交互式 PreToolUse (AskUserQuestion) 仍推送到管道并阻塞 takeover', async () => {
      handler.setMode('takeover');

      const promise = handler.handleEvent(makeEvent('PreToolUse', 's1', {
        tool_use_id: 'tu_aq',
        tool_name: 'AskUserQuestion',
        transcript_path: '/tmp/transcript.jsonl',
      }));

      await Promise.resolve();

      // 事件进入管道
      const msgs = streamManager.pull(10);
      expect(msgs.some(m => m.event?.tool_name === 'AskUserQuestion')).toBe(true);

      // takeover 模式下阻塞等待
      const pending = handler.getPendingInteractions();
      expect(pending.length).toBeGreaterThanOrEqual(1);

      // 恢复 pending
      const eventId = pending[0].eventId;
      pendingStore.resolve('s1', eventId, { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } });
      const result = await promise;
      expect(result).toEqual({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } });
    });

    it('环形缓冲满时不拒绝 push', async () => {
      // 填满管道
      for (let i = 1; i <= 15; i++) {
        streamManager.push({
          sessionId: 'filler', seq: i, timestamp: Date.now(), source: 'hook',
          event: { session_id: 'filler', event_name: 'Notification' },
        });
      }

      // hook event 推入应成功（永不拒绝，环形缓冲驱逐最旧）
      await expect(
        handler.handleEvent(makeEvent('PreToolUse', 's1', { tool_name: 'Bash' })),
      ).resolves.toBeDefined();
    });

    it('新 session 仍广播 session_start', async () => {
      const broadcasts = captureBroadcasts(wsBus);

      await handler.handleEvent(makeEvent('SessionStart', 'new-session'));

      const startMsg = broadcasts.find((m) => m.type === 'session_start');
      expect(startMsg).toBeDefined();
      if (startMsg!.type === 'session_start') {
        expect(startMsg!.session.id).toBe('new-session');
      }
    });

    // ── agent_transcript_path（子代理 transcript） ──

    it('SubagentStop 携带 agent_transcript_path 时启动子代理 tailer', async () => {
      const spy = vi.spyOn(streamManager, 'startSession');

      await handler.handleEvent(makeEvent('SubagentStop', 's1', {
        transcript_path: '/tmp/main-transcript.jsonl',
        agent_id: 'agent-001',
        agent_transcript_path: '/tmp/agent-transcript.jsonl',
      }));

      expect(spy).toHaveBeenCalledWith('agent-001', '/tmp/agent-transcript.jsonl');
    });

    it('SubagentStop 将 agent 标记为隐藏并注册到 SessionStore（用于清理追踪）', async () => {
      const hiddenSpy = vi.spyOn(sessionStore, 'markHidden');

      await handler.handleEvent(makeEvent('SubagentStop', 's1', {
        agent_id: 'agent-002',
        agent_transcript_path: '/tmp/agent-transcript.jsonl',
      }));

      expect(hiddenSpy).toHaveBeenCalledWith('agent-002');
      expect(sessionStore.has('agent-002')).toBe(true);
    });

    it('SubagentStop 不广播 agent 的 session_start', async () => {
      const broadcasts = captureBroadcasts(wsBus);

      await handler.handleEvent(makeEvent('SubagentStop', 's1', {
        agent_id: 'agent-003',
        agent_transcript_path: '/tmp/agent-transcript.jsonl',
      }));

      const agentStartMsg = broadcasts.find((m) =>
        m.type === 'session_start' && (m as { session: { id: string } }).session.id === 'agent-003',
      );
      expect(agentStartMsg).toBeUndefined();
      expect(sessionStore.has('agent-003')).toBe(true);
    });

    it('重复 SubagentStop 幂等标记隐藏', async () => {
      const spy = vi.spyOn(sessionStore, 'markHidden');

      await handler.handleEvent(makeEvent('SubagentStop', 's1', {
        agent_id: 'agent-004',
        agent_transcript_path: '/tmp/agent-transcript.jsonl',
      }));
      await handler.handleEvent(makeEvent('SubagentStop', 's1', {
        agent_id: 'agent-004',
        agent_transcript_path: '/tmp/agent-transcript.jsonl',
      }));

      expect(spy).toHaveBeenCalledTimes(2);
    });

    it('SubagentStart 没有 agent_transcript_path 时不启动子代理 tailer', async () => {
      const spy = vi.spyOn(streamManager, 'startSession');

      await handler.handleEvent(makeEvent('SubagentStart', 's1', {
        transcript_path: '/tmp/main-transcript.jsonl',
        agent_id: 'agent-005',
      }));

      // 应该只调用了主会话的 startSession，没有调用 agent_id 的
      const agentCalls = spy.mock.calls.filter(([sessionId]: [string, ...any[]]) => sessionId === 'agent-005');
      expect(agentCalls).toHaveLength(0);
    });
  });

  // ── Push notification behaviour ──

  describe('push with full pipeline', () => {
    it('环形缓冲满时推送发送仍然正常工作', async () => {
      const pushService = new PushService('https://push.example.com', 'test-key', 'gw-1');
      const pushSpy = vi.spyOn(pushService, 'sendPush').mockResolvedValue({ ok: true });
      const handlerWithPush = new HookHandler(
        sessionStore, pendingStore, deviceStore, wsBus, eventLogger, pushService,
      );
      handlerWithPush.setStreamManager(streamManager);

      deviceStore.register('ios-device', 'ios', 'en');
      deviceStore.setPushToken('ios-device', 'device-token-abc', 'sandbox');
      deviceStore.setConnected('ios-device', false);
      handlerWithPush.setMode('takeover', 'ios-device');

      // 填满管道
      for (let i = 1; i <= 15; i++) {
        streamManager.push({
          sessionId: 'filler', seq: i, timestamp: Date.now(), source: 'hook',
          event: { session_id: 'filler', event_name: 'Notification' },
        });
      }

      // 发起交互事件 — PermissionRequest 在 takeover 模式下阻塞
      const handlePromise = handlerWithPush.handleEvent(makeEvent('PermissionRequest', 's1', { tool_name: 'Bash' }));

      // 推送应已发出（管道满时不拒绝 push）
      expect(pushSpy).toHaveBeenCalledTimes(1);
      expect(pushSpy).toHaveBeenCalledWith(
        'device-token-abc',
        expect.objectContaining({ eventName: 'PermissionRequest' }),
        expect.any(AbortSignal),
      );

      // 释放阻塞交互，让 handleEvent 完成
      pendingStore.releaseAll();
      await expect(handlePromise).resolves.toBeDefined();
    });
  });

  describe('push cancellation', () => {
    it('SessionEnd 取消该 session 的推送', async () => {
      const pushService = new PushService('https://push.example.com', 'test-key', 'gw-1');
      // 永不 resolve，模拟推送进行中
      const pushSpy = vi.spyOn(pushService, 'sendPush').mockReturnValue(
        new Promise(() => {}),
      );
      const handlerWithPush = new HookHandler(
        sessionStore, pendingStore, deviceStore, wsBus, eventLogger, pushService,
      );
      handlerWithPush.setStreamManager(streamManager);

      deviceStore.register('ios-device', 'ios', 'en');
      deviceStore.setPushToken('ios-device', 'token-abc', 'sandbox');
      deviceStore.setConnected('ios-device', false);
      handlerWithPush.setMode('takeover', 'ios-device');

      // 发送交互事件，触发推送（不 await，让它在后台运行）
      handlerWithPush.handleEvent(
        makeEvent('PermissionRequest', 's1', { tool_name: 'Bash' }),
      );

      // 等待推送被调用
      await vi.waitFor(() => { expect(pushSpy).toHaveBeenCalled(); }, { timeout: 2000 });

      // 获取传递的 signal
      const signal = pushSpy.mock.calls[0][2] as AbortSignal;
      expect(signal.aborted).toBe(false);

      // 发送 SessionEnd 应该取消推送
      await handlerWithPush.handleEvent(makeEvent('SessionEnd', 's1'));

      // signal 应该被 abort
      expect(signal.aborted).toBe(true);
    });

    it('离开 takeover 模式时取消所有推送', async () => {
      const pushService = new PushService('https://push.example.com', 'test-key', 'gw-1');
      const pushSpy = vi.spyOn(pushService, 'sendPush').mockReturnValue(
        new Promise(() => {}),
      );
      const handlerWithPush = new HookHandler(
        sessionStore, pendingStore, deviceStore, wsBus, eventLogger, pushService,
      );
      handlerWithPush.setStreamManager(streamManager);

      deviceStore.register('ios-device', 'ios', 'en');
      deviceStore.setPushToken('ios-device', 'token-abc', 'sandbox');
      deviceStore.setConnected('ios-device', false);
      handlerWithPush.setMode('takeover', 'ios-device');

      // 发送交互事件
      handlerWithPush.handleEvent(
        makeEvent('PermissionRequest', 's1', { tool_name: 'Bash' }),
      );

      await vi.waitFor(() => { expect(pushSpy).toHaveBeenCalled(); }, { timeout: 2000 });
      const signal = pushSpy.mock.calls[0][2] as AbortSignal;
      expect(signal.aborted).toBe(false);

      // 切换到 bystander 应该取消所有推送
      handlerWithPush.setMode('bystander');

      expect(signal.aborted).toBe(true);
    });
  });
});
