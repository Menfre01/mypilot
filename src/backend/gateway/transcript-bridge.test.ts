import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TranscriptBridge } from './transcript-bridge.js';
import { EventLogger } from './event-logger.js';
import { WsBus } from './ws-bus.js';
import { SessionStreamManager } from './session-stream-manager.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('TranscriptBridge', () => {
  let tempDir: string;
  let streamManager: SessionStreamManager;
  let bridge: TranscriptBridge;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'mypilot-tb-'));
    const eventLogger = new EventLogger(tempDir);
    const wsBus = new WsBus(Buffer.from('0123456789abcdef0123456789abcdef', 'utf-8'));
    streamManager = new SessionStreamManager(eventLogger, wsBus, { pipelineCapacity: 20 });
    bridge = new TranscriptBridge(streamManager);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  // ── startSession ──

  it('startSession 委托给 streamManager', () => {
    const spy = vi.spyOn(streamManager, 'startSession');
    bridge.startSession('s1', '/tmp/transcript.jsonl');
    expect(spy).toHaveBeenCalledWith('s1', '/tmp/transcript.jsonl');
  });

  // ── stopSession ──

  it('stopSession 委托给 streamManager', () => {
    const spy = vi.spyOn(streamManager, 'stopSession');
    bridge.stopSession('s2');
    expect(spy).toHaveBeenCalledWith('s2');
  });

  // ── getRecentTranscriptEntries ──

  it('从管道缓冲区获取 transcript entries', () => {
    // 先推入一些 transcript 消息到管道
    streamManager.push({
      sessionId: 's1', seq: 1, timestamp: Date.now(), source: 'transcript',
      entry: { index: 0, type: 'assistant', timestamp: Date.now(), blocks: [{ type: 'text', text: 'A' }] },
    });
    streamManager.push({
      sessionId: 's1', seq: 2, timestamp: Date.now(), source: 'transcript',
      entry: { index: 1, type: 'user', timestamp: Date.now(), blocks: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'OK' }] },
    });

    const entries = bridge.getRecentTranscriptEntries(0, 10);
    expect(entries).toHaveLength(2);
    expect(entries[0].seq).toBe(1);
    expect(entries[0].entry.type).toBe('assistant');
    expect(entries[1].seq).toBe(2);
  });

  it('getRecentTranscriptEntries 尊重 afterSeq 过滤', () => {
    streamManager.push({
      sessionId: 's1', seq: 1, timestamp: Date.now(), source: 'transcript',
      entry: { index: 0, type: 'assistant', timestamp: Date.now(), blocks: [{ type: 'text', text: 'A' }] },
    });
    streamManager.push({
      sessionId: 's2', seq: 2, timestamp: Date.now(), source: 'transcript',
      entry: { index: 0, type: 'assistant', timestamp: Date.now(), blocks: [{ type: 'text', text: 'B' }] },
    });

    const entries = bridge.getRecentTranscriptEntries(1, 10);
    expect(entries).toHaveLength(1);
    expect(entries[0].seq).toBe(2);
  });

  it('getRecentTranscriptEntries 尊重 maxCount', () => {
    for (let i = 1; i <= 5; i++) {
      streamManager.push({
        sessionId: 's1', seq: i, timestamp: Date.now(), source: 'transcript',
        entry: { index: i - 1, type: 'assistant', timestamp: Date.now(), blocks: [{ type: 'text', text: String(i) }] },
      });
    }

    const entries = bridge.getRecentTranscriptEntries(0, 3);
    expect(entries).toHaveLength(3);
  });

  it('getRecentTranscriptEntries 缓冲区无匹配时返回空', () => {
    const entries = bridge.getRecentTranscriptEntries(999, 10);
    expect(entries).toEqual([]);
  });
});
