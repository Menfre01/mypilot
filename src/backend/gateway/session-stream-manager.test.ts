import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventLogger } from './event-logger.js';
import { WsBus } from './ws-bus.js';
import { SessionStreamManager } from './session-stream-manager.js';
import type { SessionMessage } from '../../shared/protocol.js';

function makeHookMsg(sessionId: string, seq: number): SessionMessage {
  return {
    sessionId, seq, timestamp: Date.now(), source: 'hook',
    event: { session_id: sessionId, event_name: 'PreToolUse' },
  };
}

describe('SessionStreamManager', () => {
  let tempDir: string;
  let eventLogger: EventLogger;
  let wsBus: WsBus;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'mypilot-ssm-'));
    eventLogger = new EventLogger(tempDir);
    wsBus = new WsBus(Buffer.from('0123456789abcdef0123456789abcdef', 'utf-8')); // 32-byte key for AES-256-GCM
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  // ── push / pull 委托 ──

  it('push 委托给管道（永不拒绝）', () => {
    const ssm = new SessionStreamManager(eventLogger, wsBus, { pipelineCapacity: 10 });
    const msg = makeHookMsg('s1', 1);
    ssm.push(msg);
    // push 返回 void，不抛异常即为成功
  });

  it('pull 委托给管道', () => {
    const ssm = new SessionStreamManager(eventLogger, wsBus, { pipelineCapacity: 10 });
    ssm.push(makeHookMsg('s1', 1));
    ssm.push(makeHookMsg('s2', 2));
    ssm.push(makeHookMsg('s3', 3));

    const msgs = ssm.pull(2);
    expect(msgs).toHaveLength(2);
    expect(msgs[0].seq).toBe(1);
    expect(msgs[1].seq).toBe(2);
  });

  it('getBufferedMessages 委托给管道', () => {
    const ssm = new SessionStreamManager(eventLogger, wsBus, { pipelineCapacity: 10 });
    ssm.push(makeHookMsg('s1', 1));
    ssm.push(makeHookMsg('s1', 2));
    ssm.push(makeHookMsg('s1', 3));

    const result = ssm.getBufferedMessages('s1', 1);
    expect(result).toHaveLength(2);
    expect(result[0].seq).toBe(2);
    expect(result[1].seq).toBe(3);
  });

  // ── 环形缓冲驱逐 ──

  it('管道满时驱逐最旧消息，push 永不拒绝', () => {
    const ssm = new SessionStreamManager(eventLogger, wsBus, { pipelineCapacity: 3 });
    ssm.push(makeHookMsg('s1', 1));
    ssm.push(makeHookMsg('s1', 2));
    ssm.push(makeHookMsg('s1', 3));
    // 满时不拒绝，驱逐最旧
    ssm.push(makeHookMsg('s1', 4));

    const msgs = ssm.pull(10);
    expect(msgs).toHaveLength(3);
    expect(msgs[0].seq).toBe(2); // seq 1 被驱逐
    expect(msgs[1].seq).toBe(3);
    expect(msgs[2].seq).toBe(4);
  });

  // ── nextSeqFn ──

  it('nextSeqFn 返回单调递增序号', () => {
    const ssm = new SessionStreamManager(eventLogger, wsBus);
    expect(ssm.nextSeqFn()).toBe(1);
    expect(ssm.nextSeqFn()).toBe(2);
    expect(ssm.nextSeqFn()).toBe(3);
  });

  // ── startSession / stopSession ──

  it('startSession 创建并启动 TranscriptTailer', () => {
    const ssm = new SessionStreamManager(eventLogger, wsBus);
    expect(() => ssm.startSession('s1', '/nonexistent/path/transcript.jsonl')).not.toThrow();
  });

  it('stopSession 停止 tailer', () => {
    const ssm = new SessionStreamManager(eventLogger, wsBus);
    ssm.startSession('s1', '/nonexistent/path/transcript.jsonl');
    expect(() => ssm.stopSession('s1')).not.toThrow();
  });

  it('startSession 同一路径幂等：重复调用不抛异常', () => {
    const ssm = new SessionStreamManager(eventLogger, wsBus);
    const testPath = join(tempDir, 'transcript.jsonl');

    ssm.startSession('s1', testPath);
    expect(() => ssm.startSession('s1', testPath)).not.toThrow();
  });

  it('startSession 不同路径会重建 tailer', () => {
    const ssm = new SessionStreamManager(eventLogger, wsBus);
    const path1 = join(tempDir, 't1.jsonl');
    const path2 = join(tempDir, 't2.jsonl');

    ssm.startSession('s1', path1);
    expect(() => ssm.startSession('s1', path2)).not.toThrow();
  });

  // ── replayHistory ──

  it('replayHistory fromSeq=0 加载历史并通过 WsBus 广播', async () => {
    const broadcastSpy = vi.spyOn(wsBus, 'broadcast');

    const ssm = new SessionStreamManager(eventLogger, wsBus);
    eventLogger.logSessionMessage({
      sessionId: 's1', seq: 1, timestamp: Date.now(), source: 'hook',
      event: { session_id: 's1', event_name: 'SessionStart' },
    });
    eventLogger.logSessionMessage({
      sessionId: 's1', seq: 2, timestamp: Date.now(), source: 'hook',
      event: { session_id: 's1', event_name: 'PreToolUse', tool_use_id: 'tu1' },
    });

    await ssm.replayHistory('s1', 0, 'device-1');

    expect(broadcastSpy).toHaveBeenCalledTimes(2);
    expect(broadcastSpy).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'event' }),
      'device-1',
    );
  });

  it('replayHistory fromSeq>0 先查管道缓冲区（热路径）', async () => {
    const broadcastSpy = vi.spyOn(wsBus, 'broadcast');

    const ssm = new SessionStreamManager(eventLogger, wsBus, { pipelineCapacity: 20 });
    ssm.push(makeHookMsg('s1', 1));
    ssm.push(makeHookMsg('s1', 2));
    ssm.push(makeHookMsg('s1', 3));

    await ssm.replayHistory('s1', 1, 'device-1');

    expect(broadcastSpy).toHaveBeenCalledTimes(2);
  });

  it('replayHistory fromSeq>0 缓冲区未命中时回退磁盘', async () => {
    const broadcastSpy = vi.spyOn(wsBus, 'broadcast');

    eventLogger.logSessionMessage({
      sessionId: 's1', seq: 1, timestamp: Date.now(), source: 'hook',
      event: { session_id: 's1', event_name: 'PreToolUse', tool_use_id: 'tu1' },
    });
    eventLogger.logSessionMessage({
      sessionId: 's1', seq: 2, timestamp: Date.now(), source: 'hook',
      event: { session_id: 's1', event_name: 'PostToolUse', tool_use_id: 'tu1' },
    });

    const ssm = new SessionStreamManager(eventLogger, wsBus, { pipelineCapacity: 20 });

    await ssm.replayHistory('s1', 0, 'device-2');

    expect(broadcastSpy).toHaveBeenCalled();
  });

  // ── drain 事件 ──

  it('onDrain 和 offDrain 管理 drain 事件监听', () => {
    const ssm = new SessionStreamManager(eventLogger, wsBus);
    const handler = vi.fn();

    ssm.onDrain(handler);
    ssm.push(makeHookMsg('s1', 1));
    expect(handler).toHaveBeenCalledTimes(1);

    ssm.offDrain(handler);
    ssm.push(makeHookMsg('s2', 2));
    expect(handler).toHaveBeenCalledTimes(1);
  });

  // ── shutdown ──

  it('shutdown 停止所有 tailer 并销毁管道', () => {
    const ssm = new SessionStreamManager(eventLogger, wsBus);
    ssm.push(makeHookMsg('s1', 1));
    expect(ssm.pull(10)).toHaveLength(1);

    ssm.shutdown();

    // 销毁后 push 无操作
    ssm.push(makeHookMsg('s2', 2));
    expect(ssm.pull(10)).toHaveLength(0);
  });

  // ── getBySource ──

  it('getBySource 返回管道中指定 source 的消息', () => {
    const ssm = new SessionStreamManager(eventLogger, wsBus, { pipelineCapacity: 20 });

    ssm.push({
      sessionId: 's1', seq: 1, timestamp: Date.now(), source: 'transcript',
      entry: { index: 0, type: 'assistant', timestamp: Date.now(), blocks: [{ type: 'text', text: 'A' }] },
    });
    ssm.push({
      sessionId: 's2', seq: 2, timestamp: Date.now(), source: 'transcript',
      entry: { index: 0, type: 'assistant', timestamp: Date.now(), blocks: [{ type: 'text', text: 'B' }] },
    });
    ssm.push(makeHookMsg('s1', 3));

    const entries = ssm.getBySource('transcript');
    expect(entries).toHaveLength(2);
    expect(entries.every(e => e.source === 'transcript')).toBe(true);
  });

  // ── recoverSeq ──

  it('recoverSeq 从磁盘恢复 _nextSeq', () => {
    eventLogger.logSessionMessage({
      sessionId: 's1', seq: 7, timestamp: Date.now(), source: 'hook',
      event: { session_id: 's1', event_name: 'PreToolUse' },
    });
    eventLogger.logSessionMessage({
      sessionId: 's1', seq: 8, timestamp: Date.now(), source: 'transcript',
      entry: { index: 0, type: 'assistant', timestamp: Date.now(), blocks: [] },
    });

    const ssm = new SessionStreamManager(eventLogger, wsBus);
    ssm.recoverSeq(eventLogger);

    expect(ssm.nextSeqFn()).toBe(9);
  });

  it('recoverSeq 空日志不影响初始 seq', () => {
    const ssm = new SessionStreamManager(eventLogger, wsBus);
    ssm.recoverSeq(eventLogger);

    expect(ssm.nextSeqFn()).toBe(1);
  });

  // ── holdInteractive（交互式 PreToolUse 暂存） ──

  it('交互式 PreToolUse（AskUserQuestion）暂存等待 transcript 条目，到达后释放', () => {
    const ssm = new SessionStreamManager(eventLogger, wsBus, { pipelineCapacity: 20 });

    // 调用 holdInteractive 暂存
    ssm.holdInteractive({
      sessionId: 's1', seq: 1, timestamp: Date.now(), source: 'hook',
      event: {
        session_id: 's1',
        event_name: 'PreToolUse',
        tool_name: 'AskUserQuestion',
        tool_use_id: 'tu-ask-1',
      },
    });

    // 管道中不应有此消息（被暂存）
    expect(ssm.pull(10)).toHaveLength(0);

    // 推入对应的 transcript 条目（含 tool_use block）
    ssm.push({
      sessionId: 's1', seq: 2, timestamp: Date.now(), source: 'transcript',
      entry: {
        index: 1,
        type: 'assistant',
        timestamp: Date.now(),
        blocks: [{ type: 'tool_use', id: 'tu-ask-1', name: 'AskUserQuestion', input: {} }],
      },
    });

    // 暂存的消息应被释放到管道，pull 按 seq 升序排列
    const msgs = ssm.pull(10);
    expect(msgs).toHaveLength(2);
    // hook 释放时 seq 被重新分配（nextSeqFn 首次调用返回 1），transcript seq=2
    expect(msgs[0].source).toBe('hook');
    expect(msgs[1].source).toBe('transcript');
    expect(msgs[0].seq).toBeLessThan(msgs[1].seq);
  });

  it('交互式 PreToolUse（ExitPlanMode）同样暂存并在对应 transcript 到达后释放', () => {
    const ssm = new SessionStreamManager(eventLogger, wsBus, { pipelineCapacity: 20 });

    ssm.holdInteractive({
      sessionId: 's1', seq: 1, timestamp: Date.now(), source: 'hook',
      event: {
        session_id: 's1',
        event_name: 'PreToolUse',
        tool_name: 'ExitPlanMode',
        tool_use_id: 'tu-epm-1',
      },
    });

    expect(ssm.pull(10)).toHaveLength(0);

    ssm.push({
      sessionId: 's1', seq: 2, timestamp: Date.now(), source: 'transcript',
      entry: {
        index: 1, type: 'assistant', timestamp: Date.now(),
        blocks: [{ type: 'tool_use', id: 'tu-epm-1', name: 'ExitPlanMode', input: {} }],
      },
    });

    const msgs = ssm.pull(10);
    expect(msgs).toHaveLength(2);
    // hook 释放后 seq 小于 transcript seq
    expect(msgs[0].source).toBe('hook');
    expect(msgs[1].source).toBe('transcript');
  });

  it('缺少 tool_use_id 的交互式事件直接进入管道', () => {
    const ssm = new SessionStreamManager(eventLogger, wsBus, { pipelineCapacity: 20 });

    ssm.push({
      sessionId: 's1', seq: 1, timestamp: Date.now(), source: 'hook',
      event: {
        session_id: 's1',
        event_name: 'PreToolUse',
        tool_name: 'AskUserQuestion',
        // 缺少 tool_use_id
      },
    });

    const msgs = ssm.pull(10);
    expect(msgs).toHaveLength(1);
  });

  it('非交互式 PreToolUse（如 Bash）直接进入管道', () => {
    const ssm = new SessionStreamManager(eventLogger, wsBus, { pipelineCapacity: 20 });

    ssm.push({
      sessionId: 's1', seq: 1, timestamp: Date.now(), source: 'hook',
      event: {
        session_id: 's1',
        event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_use_id: 'tu-bash-1',
      },
    });

    const msgs = ssm.pull(10);
    expect(msgs).toHaveLength(1);
  });

  it('非 PreToolUse 事件直接进入管道（不会被暂存）', () => {
    const ssm = new SessionStreamManager(eventLogger, wsBus, { pipelineCapacity: 20 });

    ssm.push({
      sessionId: 's1', seq: 1, timestamp: Date.now(), source: 'hook',
      event: {
        session_id: 's1',
        event_name: 'Notification',
      },
    });

    const msgs = ssm.pull(10);
    expect(msgs).toHaveLength(1);
  });

  it('暂存的交互式事件超时后自动释放到管道', () => {
    vi.useFakeTimers();

    const ssm = new SessionStreamManager(eventLogger, wsBus, { pipelineCapacity: 20 });

    ssm.holdInteractive({
      sessionId: 's1', seq: 1, timestamp: Date.now(), source: 'hook',
      event: {
        session_id: 's1',
        event_name: 'PreToolUse',
        tool_name: 'AskUserQuestion',
        tool_use_id: 'tu-timeout-1',
      },
    });

    expect(ssm.pull(10)).toHaveLength(0);

    // 快进超过 INTERACTIVE_HOLD_TIMEOUT_MS (2000ms)
    vi.advanceTimersByTime(2100);

    const msgs = ssm.pull(10);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].source).toBe('hook');

    vi.useRealTimers();
  });

  it('不同 session 的同名 tool_use_id 不会相互干扰', () => {
    const ssm = new SessionStreamManager(eventLogger, wsBus, { pipelineCapacity: 20 });

    // session s1 的交互式事件
    ssm.holdInteractive({
      sessionId: 's1', seq: 1, timestamp: Date.now(), source: 'hook',
      event: {
        session_id: 's1',
        event_name: 'PreToolUse',
        tool_name: 'AskUserQuestion',
        tool_use_id: 'tu-same-id',
      },
    });

    // session s2 的交互式事件（相同 tool_use_id）
    ssm.holdInteractive({
      sessionId: 's2', seq: 2, timestamp: Date.now(), source: 'hook',
      event: {
        session_id: 's2',
        event_name: 'PreToolUse',
        tool_name: 'AskUserQuestion',
        tool_use_id: 'tu-same-id',
      },
    });

    // 释放 s1 的对应 transcript
    ssm.push({
      sessionId: 's1', seq: 3, timestamp: Date.now(), source: 'transcript',
      entry: {
        index: 1, type: 'assistant', timestamp: Date.now(),
        blocks: [{ type: 'tool_use', id: 'tu-same-id', name: 'AskUserQuestion', input: {} }],
      },
    });

    const msgs = ssm.pull(10);
    // s1 的 hook 应被释放，s2 的仍暂存
    const hookMsgs = msgs.filter(m => m.source === 'hook');
    expect(hookMsgs).toHaveLength(1);
    expect(hookMsgs[0].sessionId).toBe('s1');
  });
});
