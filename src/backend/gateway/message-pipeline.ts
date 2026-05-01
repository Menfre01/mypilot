import type { SessionMessage, TranscriptBlock } from '../../shared/protocol.js';
import { isInteractivePreToolUse } from '../../shared/events.js';

export class MessagePipeline {
  private buffer: SessionMessage[] = [];
  private toolUseIndex = new Map<string, SessionMessage>();
  private entryIndex = new Map<string, SessionMessage>();
  private drainHandlers = new Set<() => void>();
  private _destroyed = false;
  private _maxDrainedSeq = 0;

  readonly capacity: number;
  readonly highWatermark: number;
  readonly lowWatermark: number;

  constructor(options?: {
    capacity?: number;
    highWatermark?: number;
    lowWatermark?: number;
  }) {
    this.capacity = options?.capacity ?? 500;
    this.highWatermark = options?.highWatermark ?? Math.floor(this.capacity * 0.8);
    this.lowWatermark = options?.lowWatermark ?? Math.floor(this.capacity * 0.2);
  }

  // ── 生产者接口 ──

  push(msg: SessionMessage): boolean {
    if (this._destroyed) return false;
    if (this.buffer.length >= this.highWatermark) return false;

    if (msg.source === 'transcript' && msg.entry) {
      this._pushTranscript(msg);
    } else {
      this._pushHookOrOther(msg);
    }

    return true;
  }

  // ── 消费者接口 ──

  pull(maxCount: number): SessionMessage[] {
    // 按 seq 排序保证跨源（hook + transcript）时序正确
    this.buffer.sort((a, b) => a.seq - b.seq);
    const result: SessionMessage[] = [];
    while (result.length < maxCount && this.buffer.length > 0) {
      const msg = this.buffer.shift()!;
      result.push(msg);
      this._removeFromIndices(msg);
    }
    if (result.length > 0) {
      this._maxDrainedSeq = result[result.length - 1].seq;
    }
    return result;
  }

  getBufferedForSession(sessionId: string, fromSeq: number): SessionMessage[] {
    return this.buffer
      .filter(m => m.sessionId === sessionId && m.seq > fromSeq)
      .sort((a, b) => a.seq - b.seq);
  }

  getAllTranscriptEntries(): SessionMessage[] {
    return this.buffer
      .filter(m => m.source === 'transcript')
      .sort((a, b) => a.seq - b.seq);
  }

  // ── 状态 ──

  get size(): number {
    return this.buffer.length;
  }

  isBackpressured(): boolean {
    return this.buffer.length >= this.highWatermark;
  }

  isEmpty(): boolean {
    return this.buffer.length === 0;
  }

  /** 最近一次 pull 消费到的最大 seq，用于判断缓冲区是否可能不完整 */
  get maxDrainedSeq(): number {
    return this._maxDrainedSeq;
  }

  // ── 事件 ──

  on(event: 'drain', handler: () => void): void {
    if (event === 'drain') {
      this.drainHandlers.add(handler);
    }
  }

  off(event: 'drain', handler: () => void): void {
    if (event === 'drain') {
      this.drainHandlers.delete(handler);
    }
  }

  // ── 生命周期 ──

  destroy(): void {
    this._destroyed = true;
    this.buffer = [];
    this.toolUseIndex.clear();
    this.entryIndex.clear();
    this.drainHandlers.clear();
    this._maxDrainedSeq = 0;
  }

  // ── 内部实现 ──

  private _pushTranscript(msg: SessionMessage): void {
    const entry = msg.entry!;
    const entryKey = `${msg.sessionId}:${entry.index}`;

    // entryIndex 去重：同 sessionId:index 保留最新
    const existingEntry = this.entryIndex.get(entryKey);
    if (existingEntry) {
      const pos = this.buffer.indexOf(existingEntry);
      if (pos >= 0) {
        this.buffer[pos] = msg;
        this._removeFromIndices(existingEntry);
      } else {
        this.buffer.push(msg);
      }
      this.entryIndex.set(entryKey, msg);
      this._emitDrain();
      return;
    }

    // 跨源去重：transcript 替代 hook
    const toolUseIds = this._extractToolUseIds(entry.blocks);
    let replacedCount = 0;

    for (const tuid of toolUseIds) {
      const hookMsg = this.toolUseIndex.get(`${msg.sessionId}:${tuid}`);
      if (!hookMsg) continue;

      const eventName = (hookMsg.event?.event_name ?? '') as string;
      if (isInteractivePreToolUse(eventName, hookMsg.event ?? {})) {
        continue; // 交互式 PreToolUse 不被替代
      }

      const pos = this.buffer.indexOf(hookMsg);
      if (pos < 0) continue;

      if (replacedCount === 0) {
        this.buffer[pos] = msg;
      } else {
        this.buffer.splice(pos, 1);
      }
      this._removeFromIndices(hookMsg);
      replacedCount++;
    }

    if (replacedCount > 0) {
      this.entryIndex.set(entryKey, msg);
      this._emitDrain();
      return;
    }

    // 无需替换，追加
    this.buffer.push(msg);
    this.entryIndex.set(entryKey, msg);
    this._emitDrain();
  }

  private _pushHookOrOther(msg: SessionMessage): void {
    const toolUseId = msg.event?.tool_use_id as string | undefined;
    const eventName = msg.event?.event_name as string | undefined;

    if (toolUseId && eventName) {
      if (!isInteractivePreToolUse(eventName, msg.event ?? {})) {
        const tuKey = `${msg.sessionId}:${toolUseId}`;
        const existingHook = this.toolUseIndex.get(tuKey);
        if (existingHook) {
          const pos = this.buffer.indexOf(existingHook);
          if (pos >= 0) {
            this.buffer[pos] = msg;
          } else {
            this.buffer.push(msg);
          }
          this._removeFromIndices(existingHook);
          this.toolUseIndex.set(tuKey, msg);
          return;
        }
        this.toolUseIndex.set(tuKey, msg);
      }
    }

    this.buffer.push(msg);
    this._emitDrain();
  }

  private _removeFromIndices(msg: SessionMessage): void {
    if (msg.source === 'transcript' && msg.entry) {
      this.entryIndex.delete(`${msg.sessionId}:${msg.entry.index}`);
      for (const tuid of this._extractToolUseIds(msg.entry.blocks)) {
        this.toolUseIndex.delete(`${msg.sessionId}:${tuid}`);
      }
    }
    if (msg.source === 'hook' && msg.event?.tool_use_id) {
      const tuKey = `${msg.sessionId}:${msg.event.tool_use_id}`;
      if (this.toolUseIndex.get(tuKey) === msg) {
        this.toolUseIndex.delete(tuKey);
      }
    }
  }

  private _extractToolUseIds(blocks: TranscriptBlock[]): string[] {
    const ids: string[] = [];
    for (const block of blocks) {
      if (block.type === 'tool_use' && block.id) {
        ids.push(block.id);
      }
      if (block.type === 'tool_result' && block.tool_use_id) {
        ids.push(block.tool_use_id);
      }
    }
    return ids;
  }

  private _emitDrain(): void {
    for (const handler of this.drainHandlers) {
      handler();
    }
  }
}
