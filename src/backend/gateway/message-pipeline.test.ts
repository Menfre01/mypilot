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
    pipeline = new MessagePipeline({ capacity: 10, highWatermark: 8, lowWatermark: 3 });
  });

  // ── 基本 push / pull ──

  it('push 接受并缓冲消息', () => {
    const msg = makeHookMsg('s1', 1, 'tu1');
    expect(pipeline.push(msg)).toBe(true);
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

  // ── 背压 ──

  it('push 在达到 highWatermark 时返回 false', () => {
    const small = new MessagePipeline({ capacity: 5, highWatermark: 3, lowWatermark: 1 });
    expect(small.push(makeHookMsg('s1', 1, 'tu1'))).toBe(true);
    expect(small.push(makeHookMsg('s1', 2, 'tu2'))).toBe(true);
    expect(small.push(makeHookMsg('s2', 3, 'tu3'))).toBe(true);
    expect(small.size).toBe(3);
    // 第4条触发背压
    expect(small.push(makeHookMsg('s2', 4, 'tu4'))).toBe(false);
    expect(small.size).toBe(3);
    expect(small.isBackpressured()).toBe(true);
  });

  it('pull 排空到 lowWatermark 以下后 push 恢复', () => {
    const small = new MessagePipeline({ capacity: 5, highWatermark: 3, lowWatermark: 1 });
    small.push(makeHookMsg('s1', 1, 'tu1'));
    small.push(makeHookMsg('s1', 2, 'tu2'));
    small.push(makeHookMsg('s2', 3, 'tu3'));
    // 背压中
    expect(small.isBackpressured()).toBe(true);
    expect(small.push(makeHookMsg('s2', 4, 'tu4'))).toBe(false);

    // 排空到 lowWatermark 以下
    small.pull(3);
    expect(small.isBackpressured()).toBe(false);
    expect(small.size).toBe(0);

    // 现在可以 push
    expect(small.push(makeHookMsg('s3', 5, 'tu5'))).toBe(true);
    expect(small.size).toBe(1);
  });

  it('capacity 是硬上限', () => {
    for (let i = 0; i < 8; i++) {
      pipeline.push(makeHookMsg('s1', i + 1, `tu${i + 1}`));
    }
    expect(pipeline.size).toBe(8);
    // 第9条被拒绝
    expect(pipeline.push(makeHookMsg('s2', 9, 'tu9'))).toBe(false);
    expect(pipeline.size).toBe(8);
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
    // hook 保留
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
    const t2 = makeTranscriptEntry('s1', 2, 0); // 同 index，更新版本
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

    // transcript entry 包含两个 tool_use_id
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

    // user type entry with tool_result，携带 tool_use_id
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

    // 纯文本 entry，没有 tool_use_id
    const transcript = makeTranscriptEntry('s1', 2, 0, undefined);
    pipeline.push(transcript);

    const result = pipeline.pull(10);
    expect(result).toHaveLength(2);
    // hook 和 transcript 都保留（无 tool_use_id 交叉）
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

  it('push 失败（背压）时不触发 drain', () => {
    const handler = vi.fn();
    pipeline.on('drain', handler);

    // 填满到 highWatermark
    for (let i = 0; i < 8; i++) {
      pipeline.push(makeHookMsg('s1', i + 1, `tu${i + 1}`));
    }
    expect(handler).toHaveBeenCalledTimes(8);

    // 背压，这次应该失败
    pipeline.push(makeHookMsg('s2', 9, 'tu9'));
    expect(handler).toHaveBeenCalledTimes(8); // 未增加
  });

  it('off 取消 drain 事件监听', () => {
    const handler = vi.fn();
    pipeline.on('drain', handler);
    pipeline.off('drain', handler);

    pipeline.push(makeHookMsg('s1', 1, 'tu1'));
    expect(handler).not.toHaveBeenCalled();
  });

  // ── destroy ──

  it('destroy 后 push 返回 false', () => {
    pipeline.destroy();
    expect(pipeline.push(makeHookMsg('s1', 1, 'tu1'))).toBe(false);
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
