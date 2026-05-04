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

  constructor(options?: { capacity?: number }) {
    this.capacity = options?.capacity ?? 500;
  }

  // ── 生产者接口 ──

  /** 推入一条消息。满时静默驱逐最旧消息，永不拒绝。 */
  push(msg: SessionMessage): void {
    if (this._destroyed) return;

    // push 每次最多新增 1 条（替换或追加），溢出时驱逐最旧 1 条即可
    if (this.buffer.length >= this.capacity) {
      const oldest = this.buffer.shift();
      if (oldest) this._removeFromIndices(oldest);
    }

    if (msg.source === 'transcript' && msg.entry) {
      this._pushTranscript(msg);
    } else {
      this._pushHookOrOther(msg);
    }
  }

  // ── 消费者接口 ──

  pull(maxCount: number): SessionMessage[] {
    this.buffer.sort((a, b) => a.seq - b.seq);
    const count = Math.min(maxCount, this.buffer.length);
    const result = this.buffer.splice(0, count);
    for (const msg of result) {
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

  getBySource(source: 'hook' | 'transcript'): SessionMessage[] {
    return this.buffer
      .filter(m => m.source === source)
      .sort((a, b) => a.seq - b.seq);
  }

  // ── 状态 ──

  get size(): number {
    return this.buffer.length;
  }

  isEmpty(): boolean {
    return this.buffer.length === 0;
  }

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
        continue; // 交互式 PreToolUse 不被 transcript 替代
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
          this._emitDrain();
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
