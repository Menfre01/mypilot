import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MessagePipeline } from './message-pipeline.js';
import type { SessionMessage } from '../../shared/protocol.js';

// ── helpers ──

function makeTranscriptLine(entry: Record<string, unknown>): string {
  return JSON.stringify(entry) + '\n';
}

let tempDir: string;
let transcriptPath: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'mypilot-tailer-'));
  transcriptPath = join(tempDir, 'transcript.jsonl');
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

// Dynamic import so we don't trigger the module cache for file-system-dependent tests
async function createTailer(
  pipeline: MessagePipeline,
  seqFn: () => number,
  options?: { pollIntervalMs?: number; catchUpRetryDelaysMs?: number[]; maxPushRetries?: number; pushRetryDelayMs?: number; onDrop?: (msg: SessionMessage) => void },
) {
  const { TranscriptTailer } = await import('./transcript-tailer.js');
  return new TranscriptTailer('s1', transcriptPath, pipeline, seqFn, options);
}

describe('TranscriptTailer', () => {
  // ── 追赶阶段 ──

  it('start 读取已有条目（追赶阶段）', async () => {
    const assistantEntry = {
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'Hello world' }], model: 'claude-4', usage: { input_tokens: 10 } },
    };
    writeFileSync(transcriptPath, makeTranscriptLine(assistantEntry));

    const pipeline = new MessagePipeline({ capacity: 20, highWatermark: 15, lowWatermark: 5 });
    let seq = 0;
    const tailer = await createTailer(pipeline, () => ++seq);
    await tailer.start();

    expect(pipeline.size).toBe(1);
    const msgs = pipeline.pull(10);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].source).toBe('transcript');
    expect(msgs[0].sessionId).toBe('s1');
    expect(msgs[0].entry?.type).toBe('assistant');
    expect(msgs[0].entry?.model).toBe('claude-4');
  });

  it('start 为追赶条目分配 seq', async () => {
    writeFileSync(transcriptPath,
      makeTranscriptLine({ type: 'assistant', message: { content: [{ type: 'text', text: 'A' }] } }) +
      makeTranscriptLine({ type: 'assistant', message: { content: [{ type: 'text', text: 'B' }] } }),
    );

    const pipeline = new MessagePipeline({ capacity: 20, highWatermark: 15, lowWatermark: 5 });
    let seq = 0;
    const tailer = await createTailer(pipeline, () => ++seq);
    await tailer.start();

    const msgs = pipeline.pull(10);
    expect(msgs).toHaveLength(2);
    expect(msgs[0].seq).toBe(1);
    expect(msgs[1].seq).toBe(2);
  });

  it('start 文件不存在时重试后放弃', async () => {
    const pipeline = new MessagePipeline({ capacity: 20, highWatermark: 15, lowWatermark: 5 });
    let seq = 0;
    const tailer = await createTailer(pipeline, () => ++seq, {
      catchUpRetryDelaysMs: [10, 20, 40],
    });

    // 文件不存在，所有重试耗尽后应该完成但不推送任何内容
    await tailer.start();
    expect(pipeline.size).toBe(0);
  }, 10000);

  it('start 在重试中文件出现后成功读取', async () => {
    const pipeline = new MessagePipeline({ capacity: 20, highWatermark: 15, lowWatermark: 5 });
    let seq = 0;
    const tailer = await createTailer(pipeline, () => ++seq, {
      catchUpRetryDelaysMs: [50, 100],
    });

    // 先启动（文件还不存在）
    const startPromise = tailer.start();

    // 延迟后创建文件
    await new Promise(r => setTimeout(r, 30));
    writeFileSync(transcriptPath,
      makeTranscriptLine({ type: 'assistant', message: { content: [{ type: 'text', text: 'Delayed' }] } }),
    );

    await startPromise;
    expect(pipeline.size).toBe(1);
  }, 10000);

  it('start 跳过非 assistant/user 类型的条目', async () => {
    const systemEntry = { type: 'system', message: { content: 'init' } };
    const validEntry = { type: 'assistant', message: { content: [{ type: 'text', text: 'Valid' }] } };
    writeFileSync(transcriptPath, makeTranscriptLine(systemEntry) + makeTranscriptLine(validEntry));

    const pipeline = new MessagePipeline({ capacity: 20, highWatermark: 15, lowWatermark: 5 });
    let seq = 0;
    const tailer = await createTailer(pipeline, () => ++seq);
    await tailer.start();

    expect(pipeline.size).toBe(1);
    const msgs = pipeline.pull(10);
    expect(msgs[0].entry?.type).toBe('assistant');
  });

  it('start 跳过畸形 JSON 行', async () => {
    writeFileSync(transcriptPath,
      'this is not json\n' +
      makeTranscriptLine({ type: 'assistant', message: { content: [{ type: 'text', text: 'OK' }] } }),
    );

    const pipeline = new MessagePipeline({ capacity: 20, highWatermark: 15, lowWatermark: 5 });
    let seq = 0;
    const tailer = await createTailer(pipeline, () => ++seq);
    await tailer.start();

    expect(pipeline.size).toBe(1);
  });

  // ── 增量读取 ──

  it('通过 poll 检测到追加的行', async () => {
    writeFileSync(transcriptPath,
      makeTranscriptLine({ type: 'assistant', message: { content: [{ type: 'text', text: 'First' }] } }),
    );

    const pipeline = new MessagePipeline({ capacity: 20, highWatermark: 15, lowWatermark: 5 });
    let seq = 0;
    const tailer = await createTailer(pipeline, () => ++seq, { pollIntervalMs: 50 });
    await tailer.start();

    // 排空追赶阶段的条目
    pipeline.pull(10);
    expect(pipeline.size).toBe(0);

    // 追加新行
    appendFileSync(transcriptPath,
      makeTranscriptLine({ type: 'assistant', message: { content: [{ type: 'text', text: 'Second' }] } }),
    );

    // 等待 poll 检测
    await new Promise(r => setTimeout(r, 150));

    expect(pipeline.size).toBeGreaterThanOrEqual(1);
    const msgs = pipeline.pull(10);
    const newMsgs = msgs.filter(m => m.entry?.blocks.some(b => b.text === 'Second'));
    expect(newMsgs).toHaveLength(1);
  }, 10000);

  it('partial line 缓冲：不完整行保留并在下次读取时拼接', async () => {
    writeFileSync(transcriptPath,
      makeTranscriptLine({ type: 'assistant', message: { content: [{ type: 'text', text: 'Complete' }] } }),
    );

    const pipeline = new MessagePipeline({ capacity: 20, highWatermark: 15, lowWatermark: 5 });
    let seq = 0;
    const tailer = await createTailer(pipeline, () => ++seq, { pollIntervalMs: 50 });
    await tailer.start();

    // 排空
    pipeline.pull(10);

    // 写入不完整行
    const partial = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Partial' }] } });
    appendFileSync(transcriptPath, partial.slice(0, 10));

    // 等待 poll
    await new Promise(r => setTimeout(r, 150));
    // 不完整行不应该产生新消息
    expect(pipeline.size).toBe(0);

    // 写入剩余部分
    appendFileSync(transcriptPath, partial.slice(10) + '\n');

    await new Promise(r => setTimeout(r, 150));

    expect(pipeline.size).toBeGreaterThanOrEqual(1);
    const msgs = pipeline.pull(10);
    expect(msgs.some(m => m.entry?.blocks.some(b => b.text === 'Partial'))).toBe(true);
  }, 10000);

  // ── 截断检测 ──

  it('文件截断时重新全量读取', async () => {
    writeFileSync(transcriptPath,
      makeTranscriptLine({ type: 'assistant', message: { content: [{ type: 'text', text: 'Original' }] } }),
    );

    const pipeline = new MessagePipeline({ capacity: 20, highWatermark: 15, lowWatermark: 5 });
    let seq = 0;
    const tailer = await createTailer(pipeline, () => ++seq, { pollIntervalMs: 50 });
    await tailer.start();
    pipeline.pull(10);

    // 文件被截断（变成空文件）
    writeFileSync(transcriptPath,
      makeTranscriptLine({ type: 'assistant', message: { content: [{ type: 'text', text: 'New' }] } }),
    );

    await new Promise(r => setTimeout(r, 150));

    // 管道去重保证同 index 的旧条目被替换
    const msgs = pipeline.pull(10);
    expect(msgs.some(m => m.entry?.blocks.some(b => b.text === 'New'))).toBe(true);
  }, 10000);

  // ── 背压 ──

  it('管道背压时暂停读取并重试', async () => {
    writeFileSync(transcriptPath,
      makeTranscriptLine({ type: 'assistant', message: { content: [{ type: 'text', text: 'One' }] } }),
    );

    // 小容量管道，容易触发背压
    const pipeline = new MessagePipeline({ capacity: 5, highWatermark: 2, lowWatermark: 1 });
    let seq = 0;
    const tailer = await createTailer(pipeline, () => ++seq, {
      pollIntervalMs: 50,
    });
    await tailer.start();

    // 排空管道
    pipeline.pull(10);

    // 塞满管道使其背压
    pipeline.push({
      sessionId: 's1', seq: 100, timestamp: Date.now(), source: 'hook',
      event: { session_id: 's1', event_name: 'Notification' },
    });
    pipeline.push({
      sessionId: 's1', seq: 101, timestamp: Date.now(), source: 'hook',
      event: { session_id: 's1', event_name: 'Notification' },
    });
    expect(pipeline.isBackpressured()).toBe(true);

    // 追加新数据
    appendFileSync(transcriptPath,
      makeTranscriptLine({ type: 'assistant', message: { content: [{ type: 'text', text: 'Two' }] } }),
    );

    // 等待 poll
    await new Promise(r => setTimeout(r, 200));

    // 消息因为背压无法推入 —— 在背压恢复前应该没有新增 transcript 条目
    // 排空后 tailer 会重试推入
    pipeline.pull(10);
    expect(pipeline.isBackpressured()).toBe(false);

    // 再等一次重试机会
    await new Promise(r => setTimeout(r, 200));
    const msgs = pipeline.pull(10);
    expect(msgs.some(m => m.source === 'transcript')).toBe(true);
  }, 10000);

  // ── stop ──

  it('stop 阻止后续读取', async () => {
    writeFileSync(transcriptPath,
      makeTranscriptLine({ type: 'assistant', message: { content: [{ type: 'text', text: 'Before' }] } }),
    );

    const pipeline = new MessagePipeline({ capacity: 20, highWatermark: 15, lowWatermark: 5 });
    let seq = 0;
    const tailer = await createTailer(pipeline, () => ++seq, { pollIntervalMs: 50 });
    await tailer.start();
    pipeline.pull(10);

    tailer.stop();
    expect(tailer.stopped).toBe(true);

    // 追加新行
    appendFileSync(transcriptPath,
      makeTranscriptLine({ type: 'assistant', message: { content: [{ type: 'text', text: 'After' }] } }),
    );

    await new Promise(r => setTimeout(r, 150));
    // 停止后不应有新的 transcript 条目
    expect(pipeline.size).toBe(0);
  }, 10000);

  // ── stopped getter ──

  it('stopped getter 反映停止状态', async () => {
    const pipeline = new MessagePipeline({ capacity: 20, highWatermark: 15, lowWatermark: 5 });
    let seq = 0;
    const tailer = await createTailer(pipeline, () => ++seq);
    expect(tailer.stopped).toBe(false);

    tailer.stop();
    expect(tailer.stopped).toBe(true);
  });

  // ── 重试耗尽后文件出现 ──

  it('start 重试耗尽后文件出现时通过监控捕获', async () => {
    const pipeline = new MessagePipeline({ capacity: 20, highWatermark: 15, lowWatermark: 5 });
    let seq = 0;
    const tailer = await createTailer(pipeline, () => ++seq, {
      catchUpRetryDelaysMs: [10, 20],
      pollIntervalMs: 50,
    });

    // 文件不存在，重试耗尽后会启动监控等待
    await tailer.start();
    expect(pipeline.size).toBe(0);
    expect(tailer.stopped).toBe(false); // 仍在监控中

    // 稍后创建文件
    await new Promise(r => setTimeout(r, 30));
    writeFileSync(transcriptPath,
      makeTranscriptLine({ type: 'assistant', message: { content: [{ type: 'text', text: 'Late' }] } }),
    );

    // 等待 poll 检测到文件
    await new Promise(r => setTimeout(r, 200));
    expect(pipeline.size).toBeGreaterThanOrEqual(1);
    const msgs = pipeline.pull(10);
    expect(msgs.some(m => m.source === 'transcript')).toBe(true);
  }, 10000);

  // ── stop 时刷新 partialLine ──

  it('stop 刷新缓冲的完整 partialLine（缺少尾部换行符）', async () => {
    writeFileSync(transcriptPath,
      makeTranscriptLine({ type: 'assistant', message: { content: [{ type: 'text', text: 'Complete' }] } }),
    );

    const pipeline = new MessagePipeline({ capacity: 20, highWatermark: 15, lowWatermark: 5 });
    let seq = 0;
    const tailer = await createTailer(pipeline, () => ++seq, { pollIntervalMs: 50 });
    await tailer.start();
    pipeline.pull(10);

    // 写入一个不带换行符的完整 JSON 行
    const completeLine = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'NoNewline' }] } });
    appendFileSync(transcriptPath, completeLine); // 无尾随 \n

    // 等待 poll 检测并缓冲为 partialLine
    await new Promise(r => setTimeout(r, 150));
    // partialLine 中有数据但尚未完成
    expect(pipeline.size).toBe(0);

    // stop 应该刷新 partialLine
    tailer.stop();

    const msgs = pipeline.pull(10);
    expect(msgs.some(m => m.entry?.blocks.some(b => b.text === 'NoNewline'))).toBe(true);
  }, 10000);

  // ── onDrop 回调 ──

  it('_pushWithRetry 重试耗尽后调用 onDrop 持久化消息', async () => {
    writeFileSync(transcriptPath,
      makeTranscriptLine({ type: 'assistant', message: { content: [{ type: 'text', text: 'DropTest' }] } }),
    );

    // 小容量管道，故意塞满触发背压
    const pipeline = new MessagePipeline({ capacity: 5, highWatermark: 2, lowWatermark: 1 });
    // 预填满管道
    for (let i = 0; i < 3; i++) {
      pipeline.push({
        sessionId: 's1', seq: 100 + i, timestamp: Date.now(), source: 'hook',
        event: { session_id: 's1', event_name: 'Notification' },
      });
    }
    expect(pipeline.isBackpressured()).toBe(true);

    const onDrop = vi.fn();
    let seq = 0;
    const tailer = await createTailer(pipeline, () => ++seq, {
      maxPushRetries: 2,
      pushRetryDelayMs: 10,
      onDrop,
    });

    await tailer.start();
    // 等待重试耗尽
    await new Promise(r => setTimeout(r, 100));

    // onDrop 应该被调用，参数包含被丢弃的消息
    expect(onDrop).toHaveBeenCalled();
    const droppedMsg = onDrop.mock.calls[0][0] as SessionMessage;
    expect(droppedMsg.source).toBe('transcript');
    expect(droppedMsg.sessionId).toBe('s1');
    expect(droppedMsg.entry?.blocks.some(b => b.text === 'DropTest')).toBe(true);
  }, 10000);

  it('maxPushRetries 默认为 10', async () => {
    const pipeline = new MessagePipeline({ capacity: 20, highWatermark: 15, lowWatermark: 5 });
    let seq = 0;
    const tailer = await createTailer(pipeline, () => ++seq);
    expect((tailer as any).maxPushRetries).toBe(10);
  });

  it('_finalFlush 在 pipeline 背压时将消息传递给 onDrop', async () => {
    writeFileSync(transcriptPath,
      makeTranscriptLine({ type: 'assistant', message: { content: [{ type: 'text', text: 'Initial' }] } }),
    );

    const pipeline = new MessagePipeline({ capacity: 20, highWatermark: 15, lowWatermark: 5 });
    const onDrop = vi.fn();
    let seq = 0;
    const tailer = await createTailer(pipeline, () => ++seq, { onDrop });

    await tailer.start();
    // 排空
    pipeline.pull(10);

    // 追加新条目
    appendFileSync(transcriptPath,
      makeTranscriptLine({ type: 'assistant', message: { content: [{ type: 'text', text: 'FlushTest' }] } }),
    );

    // 塞满管道
    for (let i = 0; i < 16; i++) {
      pipeline.push({
        sessionId: 's1', seq: 200 + i, timestamp: Date.now(), source: 'hook',
        event: { session_id: 's1', event_name: 'Notification' },
      });
    }
    expect(pipeline.isBackpressured()).toBe(true);

    // stop 触发 _finalFlush → push 失败 → onDrop
    tailer.stop();

    // onDrop 应该被调用，参数包含无法推入管道的消息
    const flushCalls = onDrop.mock.calls.filter(
      (call: unknown[]) => (call[0] as SessionMessage).source === 'transcript',
    );
    expect(flushCalls.length).toBeGreaterThanOrEqual(1);
    const flushedMsg = flushCalls[0][0] as SessionMessage;
    expect(flushedMsg.entry?.blocks.some(b => b.text === 'FlushTest')).toBe(true);
  }, 10000);
});
