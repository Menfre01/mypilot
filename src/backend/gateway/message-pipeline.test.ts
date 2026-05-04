import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MessagePipeline } from './message-pipeline.js';
import type { SessionMessage } from '../../shared/protocol.js';

function makeHookMsg(
  sessionId: string,
  seq: number,
  toolUseId?: string,
  eventName?: string,
  toolName?: string,
): SessionMessage {
  return {
    sessionId,
    seq,
    timestamp: Date.now(),
    source: 'hook',
    event: {
      session_id: sessionId,
      event_name: eventName ?? 'PreToolUse',
      tool_use_id: toolUseId,
      tool_name: toolName,
    },
  };
}

function makeTranscriptEntry(
  sessionId: string,
  seq: number,
  index: number,
  toolUseIds?: string[],
  entryType: 'assistant' | 'user' = 'assistant',
): SessionMessage {
  const blocks: import('../../shared/protocol.js').TranscriptBlock[] = [];
  if (toolUseIds) {
    for (const id of toolUseIds) {
      blocks.push({ type: 'tool_use', id, name: 'test_tool', input: {} });
    }
  } else {
    blocks.push({ type: 'text', text: 'hello' });
  }

  return {
    sessionId,
    seq,
    timestamp: Date.now(),
    source: 'transcript',
    entry: {
      index,
      type: entryType,
      timestamp: Date.now(),
      blocks,
    },
  };
}

describe('MessagePipeline', () => {
  let pipeline: MessagePipeline;

  beforeEach(() => {
    pipeline = new MessagePipeline({ capacity: 10 });
  });

  // ── 基本 push / pull ──

  it('push 接受并缓冲消息', () => {
    const msg = makeHookMsg('s1', 1, 'tu1');
    pipeline.push(msg);
    expect(pipeline.size).toBe(1);
    expect(pipeline.isEmpty()).toBe(false);
  });

  it('pull 按插入顺序返回消息', () => {
    const m1 = makeHookMsg('s1', 1, 'tu1');
    const m2 = makeHookMsg('s1', 2, 'tu2');
    pipeline.push(m1);
    pipeline.push(m2);

    const result = pipeline.pull(10);
    expect(result).toHaveLength(2);
    expect(result[0].seq).toBe(1);
    expect(result[1].seq).toBe(2);
  });

  it('pull 缓冲区为空时返回空数组', () => {
    expect(pipeline.pull(10)).toEqual([]);
  });

  it('pull 尊重 maxCount 限制', () => {
    for (let i = 1; i <= 5; i++) {
      pipeline.push(makeHookMsg('s1', i, `tu${i}`));
    }
    const result = pipeline.pull(3);
    expect(result).toHaveLength(3);
    expect(pipeline.size).toBe(2);
  });

  it('多次 pull 逐步排空缓冲区', () => {
    for (let i = 1; i <= 5; i++) {
      pipeline.push(makeHookMsg('s1', i, `tu${i}`));
    }
    const r1 = pipeline.pull(2);
    expect(r1).toHaveLength(2);
    const r2 = pipeline.pull(10);
    expect(r2).toHaveLength(3);
    expect(pipeline.isEmpty()).toBe(true);
  });

  // ── 环形缓冲驱逐 ──

  it('push 在达到 capacity 时驱逐最旧消息', () => {
    const small = new MessagePipeline({ capacity: 3 });
    small.push(makeHookMsg('s1', 1, 'tu1'));
    small.push(makeHookMsg('s1', 2, 'tu2'));
    small.push(makeHookMsg('s2', 3, 'tu3'));
    expect(small.size).toBe(3);

    // 第4条触发驱逐，tu1 被移除
    small.push(makeHookMsg('s2', 4, 'tu4'));
    expect(small.size).toBe(3);

    const result = small.pull(10);
    expect(result).toHaveLength(3);
    expect(result[0].seq).toBe(2); // seq 1 已被驱逐
    expect(result[1].seq).toBe(3);
    expect(result[2].seq).toBe(4);
  });

  it('驱逐时清理对应索引条目', () => {
    const small = new MessagePipeline({ capacity: 3 });

    // 推入 hook（建立 toolUseIndex 条目）
    small.push(makeHookMsg('s1', 1, 'tu1', 'PreToolUse', 'test_tool'));

    // 填满并驱逐最旧的（tu1）
    small.push(makeHookMsg('s1', 2, 'tu2'));
    small.push(makeHookMsg('s1', 3, 'tu3'));
    small.push(makeHookMsg('s1', 4, 'tu4'));
    expect(small.size).toBe(3);

    // 再推入一条同 toolUseId 的 hook，不应去重（旧索引已清理）
    small.push(makeHookMsg('s1', 5, 'tu1', 'PreToolUse', 'test_tool'));
    expect(small.size).toBe(3);

    const result = small.pull(10);
    // tu1 的新版本应作为独立条目存在
    const tu1Entries = result.filter(m => m.event?.tool_use_id === 'tu1');
    expect(tu1Entries).toHaveLength(1);
    expect(tu1Entries[0].seq).toBe(5);
  });

  // ── 跨源去重：transcript 替代 hook ──

  it('transcript entry 替代同 tool_use_id 的 hook event', () => {
    const hook = makeHookMsg('s1', 1, 'tu1', 'PreToolUse', 'test_tool');
    pipeline.push(hook);

    const transcript = makeTranscriptEntry('s1', 2, 0, ['tu1']);
    pipeline.push(transcript);

    const result = pipeline.pull(10);
    expect(result).toHaveLength(1);
    expect(result[0].source).toBe('transcript');
    expect(result[0].seq).toBe(2);
  });

  it('交互式 PreToolUse (AskUserQuestion) hook 不被 transcript 替代', () => {
    const hook = makeHookMsg('s1', 1, 'tu1', 'PreToolUse', 'AskUserQuestion');
    pipeline.push(hook);

    const transcript = makeTranscriptEntry('s1', 2, 0, ['tu1']);
    pipeline.push(transcript);

    const result = pipeline.pull(10);
    expect(result).toHaveLength(2);
    expect(result.find(m => m.source === 'hook')).toBeDefined();
    expect(result.find(m => m.source === 'transcript')).toBeDefined();
  });

  it('交互式 PreToolUse (ExitPlanMode) hook 不被 transcript 替代', () => {
    const hook = makeHookMsg('s1', 1, 'tu1', 'PreToolUse', 'ExitPlanMode');
    pipeline.push(hook);

    const transcript = makeTranscriptEntry('s1', 2, 0, ['tu1']);
    pipeline.push(transcript);

    const result = pipeline.pull(10);
    expect(result).toHaveLength(2);
  });

  // ── entryIndex 去重 ──

  it('同 sessionId:index 的 transcript entry 保留最新', () => {
    const t1 = makeTranscriptEntry('s1', 1, 0);
    const t2 = makeTranscriptEntry('s1', 2, 0);
    pipeline.push(t1);
    pipeline.push(t2);

    const result = pipeline.pull(10);
    expect(result).toHaveLength(1);
    expect(result[0].seq).toBe(2);
  });

  // ── toolUseIndex 去重：hook 自身去重 ──

  it('同 sessionId:tool_use_id 的 hook 保留最新（安全网更新）', () => {
    const h1 = makeHookMsg('s1', 1, 'tu1', 'PreToolUse', 'test_tool');
    const h2 = makeHookMsg('s1', 2, 'tu1', 'PreToolUse', 'test_tool');
    pipeline.push(h1);
    pipeline.push(h2);

    const result = pipeline.pull(10);
    expect(result).toHaveLength(1);
    expect(result[0].seq).toBe(2);
  });

  // ── 多 tool_use_id 去重 ──

  it('一个 transcript entry 有多个 tool_use_id 时分别去重对应 hook', () => {
    const h1 = makeHookMsg('s1', 1, 'tu1', 'PreToolUse', 'tool_a');
    const h2 = makeHookMsg('s1', 2, 'tu2', 'PreToolUse', 'tool_b');
    pipeline.push(h1);
    pipeline.push(h2);

    const transcript: SessionMessage = {
      sessionId: 's1',
      seq: 3,
      timestamp: Date.now(),
      source: 'transcript',
      entry: {
        index: 0,
        type: 'assistant',
        timestamp: Date.now(),
        blocks: [
          { type: 'tool_use', id: 'tu1', name: 'tool_a', input: {} },
          { type: 'tool_use', id: 'tu2', name: 'tool_b', input: {} },
        ],
      },
    };
    pipeline.push(transcript);

    const result = pipeline.pull(10);
    expect(result).toHaveLength(1);
    expect(result[0].source).toBe('transcript');
    expect(result[0].seq).toBe(3);
  });

  // ── 仅替换 tool_use 相关的 hook ──

  it('transcript entry 只有 tool_use block 时替换对应 hook', () => {
    const hook = makeHookMsg('s1', 1, 'tu1', 'PostToolUse');
    pipeline.push(hook);

    const transcript: SessionMessage = {
      sessionId: 's1',
      seq: 2,
      timestamp: Date.now(),
      source: 'transcript',
      entry: {
        index: 1,
        type: 'user',
        timestamp: Date.now(),
        blocks: [
          { type: 'tool_result', tool_use_id: 'tu1', content: 'result' },
        ],
      },
    };
    pipeline.push(transcript);

    const result = pipeline.pull(10);
    expect(result).toHaveLength(1);
    expect(result[0].source).toBe('transcript');
    expect(result[0].seq).toBe(2);
  });

  it('transcript entry 无 tool_use_id 时不替换 hook event', () => {
    const hook = makeHookMsg('s1', 1, undefined, 'UserPromptSubmit');
    pipeline.push(hook);

    const transcript = makeTranscriptEntry('s1', 2, 0, undefined);
    pipeline.push(transcript);

    const result = pipeline.pull(10);
    expect(result).toHaveLength(2);
  });

  // ── getBufferedForSession ──

  it('getBufferedForSession 返回 fromSeq 之后的消息', () => {
    pipeline.push(makeHookMsg('s1', 1, 'tu1'));
    pipeline.push(makeHookMsg('s1', 2, 'tu2'));
    pipeline.push(makeHookMsg('s1', 3, 'tu3'));

    const result = pipeline.getBufferedForSession('s1', 1);
    expect(result).toHaveLength(2);
    expect(result[0].seq).toBe(2);
    expect(result[1].seq).toBe(3);
  });

  it('getBufferedForSession fromSeq 无匹配时返回空', () => {
    pipeline.push(makeHookMsg('s1', 1, 'tu1'));
    const result = pipeline.getBufferedForSession('s1', 10);
    expect(result).toHaveLength(0);
  });

  it('getBufferedForSession 不消费消息', () => {
    pipeline.push(makeHookMsg('s1', 1, 'tu1'));
    pipeline.getBufferedForSession('s1', 0);
    expect(pipeline.size).toBe(1);
  });

  // ── drain 事件 ──

  it('push 成功时触发 drain 事件', () => {
    const handler = vi.fn();
    pipeline.on('drain', handler);

    pipeline.push(makeHookMsg('s1', 1, 'tu1'));
    expect(handler).toHaveBeenCalledTimes(1);

    pipeline.push(makeHookMsg('s1', 2, 'tu2'));
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('push 始终触发 drain（含驱逐场景）', () => {
    const handler = vi.fn();
    const small = new MessagePipeline({ capacity: 3 });
    small.on('drain', handler);

    // 填满
    for (let i = 0; i < 3; i++) {
      small.push(makeHookMsg('s1', i + 1, `tu${i + 1}`));
    }
    expect(handler).toHaveBeenCalledTimes(3);

    // 触发驱逐，drain 仍然触发
    small.push(makeHookMsg('s2', 4, 'tu4'));
    expect(handler).toHaveBeenCalledTimes(4);
  });

  it('off 取消 drain 事件监听', () => {
    const handler = vi.fn();
    pipeline.on('drain', handler);
    pipeline.off('drain', handler);

    pipeline.push(makeHookMsg('s1', 1, 'tu1'));
    expect(handler).not.toHaveBeenCalled();
  });

  // ── destroy ──

  it('destroy 后 push 无操作', () => {
    pipeline.destroy();
    pipeline.push(makeHookMsg('s1', 1, 'tu1'));
    expect(pipeline.size).toBe(0);
  });

  it('destroy 清空缓冲区', () => {
    pipeline.push(makeHookMsg('s1', 1, 'tu1'));
    pipeline.push(makeHookMsg('s2', 2, 'tu2'));
    pipeline.destroy();
    expect(pipeline.size).toBe(0);
    expect(pipeline.isEmpty()).toBe(true);
  });

  // ── 多 session 并发 ──

  it('多 session 消息按 seq 交错排序', () => {
    pipeline.push(makeHookMsg('s1', 1, 'tu1'));
    pipeline.push(makeHookMsg('s2', 2, 'tu2'));
    pipeline.push(makeHookMsg('s1', 3, 'tu3'));
    pipeline.push(makeHookMsg('s3', 4, 'tu4'));

    const result = pipeline.pull(10);
    expect(result).toHaveLength(4);
    expect(result.map(m => m.seq)).toEqual([1, 2, 3, 4]);
    expect(result.map(m => m.sessionId)).toEqual(['s1', 's2', 's1', 's3']);
  });
});
