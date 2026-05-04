import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MessagePipeline } from './message-pipeline.js';

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

async function createTailer(
  pipeline: MessagePipeline,
  seqFn: () => number,
  options?: { pollIntervalMs?: number; catchUpRetryDelaysMs?: number[] },
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

    const pipeline = new MessagePipeline({ capacity: 20 });
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

    const pipeline = new MessagePipeline({ capacity: 20 });
    let seq = 0;
    const tailer = await createTailer(pipeline, () => ++seq);
    await tailer.start();

    const msgs = pipeline.pull(10);
    expect(msgs).toHaveLength(2);
    expect(msgs[0].seq).toBe(1);
    expect(msgs[1].seq).toBe(2);
  });

  it('start 文件不存在时重试后放弃', async () => {
    const pipeline = new MessagePipeline({ capacity: 20 });
    let seq = 0;
    const tailer = await createTailer(pipeline, () => ++seq, {
      catchUpRetryDelaysMs: [10, 20, 40],
    });

    await tailer.start();
    expect(pipeline.size).toBe(0);
  }, 10000);

  it('start 在重试中文件出现后成功读取', async () => {
    const pipeline = new MessagePipeline({ capacity: 20 });
    let seq = 0;
    const tailer = await createTailer(pipeline, () => ++seq, {
      catchUpRetryDelaysMs: [50, 100],
    });

    const startPromise = tailer.start();

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

    const pipeline = new MessagePipeline({ capacity: 20 });
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

    const pipeline = new MessagePipeline({ capacity: 20 });
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

    const pipeline = new MessagePipeline({ capacity: 20 });
    let seq = 0;
    const tailer = await createTailer(pipeline, () => ++seq, { pollIntervalMs: 50 });
    await tailer.start();

    pipeline.pull(10);
    expect(pipeline.size).toBe(0);

    appendFileSync(transcriptPath,
      makeTranscriptLine({ type: 'assistant', message: { content: [{ type: 'text', text: 'Second' }] } }),
    );

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

    const pipeline = new MessagePipeline({ capacity: 20 });
    let seq = 0;
    const tailer = await createTailer(pipeline, () => ++seq, { pollIntervalMs: 50 });
    await tailer.start();

    pipeline.pull(10);

    const partial = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Partial' }] } });
    appendFileSync(transcriptPath, partial.slice(0, 10));

    await new Promise(r => setTimeout(r, 150));
    expect(pipeline.size).toBe(0);

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

    const pipeline = new MessagePipeline({ capacity: 20 });
    let seq = 0;
    const tailer = await createTailer(pipeline, () => ++seq, { pollIntervalMs: 50 });
    await tailer.start();
    pipeline.pull(10);

    writeFileSync(transcriptPath,
      makeTranscriptLine({ type: 'assistant', message: { content: [{ type: 'text', text: 'New' }] } }),
    );

    await new Promise(r => setTimeout(r, 150));

    const msgs = pipeline.pull(10);
    expect(msgs.some(m => m.entry?.blocks.some(b => b.text === 'New'))).toBe(true);
  }, 10000);

  // ── 环形缓冲满时正常 push ──

  it('环形缓冲满时 push 逐出最旧并正常继续', async () => {
    writeFileSync(transcriptPath,
      makeTranscriptLine({ type: 'assistant', message: { content: [{ type: 'text', text: 'One' }] } }),
    );

    // 小容量管道
    const pipeline = new MessagePipeline({ capacity: 3 });
    let seq = 0;
    const tailer = await createTailer(pipeline, () => ++seq, {
      pollIntervalMs: 50,
    });
    await tailer.start();

    pipeline.pull(10);

    // 填满管道
    for (let i = 0; i < 3; i++) {
      pipeline.push({
        sessionId: 's1', seq: 100 + i, timestamp: Date.now(), source: 'hook',
        event: { session_id: 's1', event_name: 'Notification' },
      });
    }
    expect(pipeline.size).toBe(3);

    // 追加新数据 — 即使管道满也不拒绝，逐出最旧
    appendFileSync(transcriptPath,
      makeTranscriptLine({ type: 'assistant', message: { content: [{ type: 'text', text: 'Two' }] } }),
    );

    await new Promise(r => setTimeout(r, 200));

    // tailer 的消息已推入管道（环形缓冲逐出最旧后正常接受）
    const msgs = pipeline.pull(10);
    expect(msgs.some(m => m.source === 'transcript')).toBe(true);
  }, 10000);

  // ── stop ──

  it('stop 阻止后续读取', async () => {
    writeFileSync(transcriptPath,
      makeTranscriptLine({ type: 'assistant', message: { content: [{ type: 'text', text: 'Before' }] } }),
    );

    const pipeline = new MessagePipeline({ capacity: 20 });
    let seq = 0;
    const tailer = await createTailer(pipeline, () => ++seq, { pollIntervalMs: 50 });
    await tailer.start();
    pipeline.pull(10);

    tailer.stop();
    expect(tailer.stopped).toBe(true);

    appendFileSync(transcriptPath,
      makeTranscriptLine({ type: 'assistant', message: { content: [{ type: 'text', text: 'After' }] } }),
    );

    await new Promise(r => setTimeout(r, 150));
    expect(pipeline.size).toBe(0);
  }, 10000);

  // ── stopped getter ──

  it('stopped getter 反映停止状态', async () => {
    const pipeline = new MessagePipeline({ capacity: 20 });
    let seq = 0;
    const tailer = await createTailer(pipeline, () => ++seq);
    expect(tailer.stopped).toBe(false);

    tailer.stop();
    expect(tailer.stopped).toBe(true);
  });

  // ── 重试耗尽后文件出现 ──

  it('start 重试耗尽后文件出现时通过监控捕获', async () => {
    const pipeline = new MessagePipeline({ capacity: 20 });
    let seq = 0;
    const tailer = await createTailer(pipeline, () => ++seq, {
      catchUpRetryDelaysMs: [10, 20],
      pollIntervalMs: 50,
    });

    await tailer.start();
    expect(pipeline.size).toBe(0);
    expect(tailer.stopped).toBe(false);

    await new Promise(r => setTimeout(r, 30));
    writeFileSync(transcriptPath,
      makeTranscriptLine({ type: 'assistant', message: { content: [{ type: 'text', text: 'Late' }] } }),
    );

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

    const pipeline = new MessagePipeline({ capacity: 20 });
    let seq = 0;
    const tailer = await createTailer(pipeline, () => ++seq, { pollIntervalMs: 50 });
    await tailer.start();
    pipeline.pull(10);

    const completeLine = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'NoNewline' }] } });
    appendFileSync(transcriptPath, completeLine);

    await new Promise(r => setTimeout(r, 150));
    expect(pipeline.size).toBe(0);

    tailer.stop();

    const msgs = pipeline.pull(10);
    expect(msgs.some(m => m.entry?.blocks.some(b => b.text === 'NoNewline'))).toBe(true);
  }, 10000);

  // ── _finalFlush 刷新缓冲残余 ──

  it('_finalFlush 在 stop 时刷新残余消息（管道满时逐出最旧后正常接受）', async () => {
    writeFileSync(transcriptPath,
      makeTranscriptLine({ type: 'assistant', message: { content: [{ type: 'text', text: 'Initial' }] } }),
    );

    const pipeline = new MessagePipeline({ capacity: 20 });
    let seq = 0;
    const tailer = await createTailer(pipeline, () => ++seq);

    await tailer.start();
    pipeline.pull(10);

    // 追加新条目
    appendFileSync(transcriptPath,
      makeTranscriptLine({ type: 'assistant', message: { content: [{ type: 'text', text: 'FlushTest' }] } }),
    );

    // 填满管道
    for (let i = 0; i < 20; i++) {
      pipeline.push({
        sessionId: 's1', seq: 200 + i, timestamp: Date.now(), source: 'hook',
        event: { session_id: 's1', event_name: 'Notification' },
      });
    }

    // stop 触发 _finalFlush → 环形缓冲逐出最旧后接受
    tailer.stop();

    const msgs = pipeline.pull(50);
    expect(msgs.some(m => m.entry?.blocks.some(b => b.text === 'FlushTest'))).toBe(true);
  }, 10000);
});
