import { MessagePipeline } from './message-pipeline.js';
import { TranscriptTailer } from './transcript-tailer.js';
import { EventLogger } from './event-logger.js';
import type { WsBus } from './ws-bus.js';
import type { SessionMessage } from '../../shared/protocol.js';

export class SessionStreamManager {
  private pipeline: MessagePipeline;
  private eventLogger: EventLogger;
  private wsBus: WsBus;
  private tailers = new Map<string, TranscriptTailer>();
  private tailerPaths = new Map<string, string>();
  private _nextSeq = 0;
  private isHidden: (sessionId: string) => boolean;

  constructor(
    eventLogger: EventLogger,
    wsBus: WsBus,
    options?: {
      pipelineCapacity?: number;
      isHidden?: (sessionId: string) => boolean;
    },
  ) {
    this.isHidden = options?.isHidden ?? (() => false);
    this.eventLogger = eventLogger;
    this.wsBus = wsBus;
    this.pipeline = new MessagePipeline({
      capacity: options?.pipelineCapacity ?? 500,
    });
  }

  /** 从磁盘恢复 seq 计数器，确保重启后 seq 不重复。 */
  recoverSeq(eventLogger: EventLogger): void {
    const maxSeq = eventLogger.getMaxSessionSeq();
    if (maxSeq >= this._nextSeq) {
      this._nextSeq = maxSeq;
    }
  }

  // ── Tailer 生命周期 ──

  startSession(sessionId: string, transcriptPath: string): void {
    const existingPath = this.tailerPaths.get(sessionId);
    if (existingPath === transcriptPath) return;

    this.stopSession(sessionId);

    const tailer = new TranscriptTailer(
      sessionId,
      transcriptPath,
      this.pipeline,
      () => this.nextSeqFn(),
    );
    this.tailers.set(sessionId, tailer);
    this.tailerPaths.set(sessionId, transcriptPath);
    void tailer.start();
  }

  stopSession(sessionId: string): void {
    const tailer = this.tailers.get(sessionId);
    if (tailer) {
      tailer.stop();
      this.tailers.delete(sessionId);
    }
    this.tailerPaths.delete(sessionId);
  }

  // ── 生产者接口 ──

  push(msg: SessionMessage): void {
    this.pipeline.push(msg);
  }

  // ── 消费者接口 ──

  pull(maxCount: number): SessionMessage[] {
    return this.pipeline.pull(maxCount);
  }

  getBufferedMessages(sessionId: string, fromSeq: number): SessionMessage[] {
    return this.pipeline.getBufferedForSession(sessionId, fromSeq);
  }

  getBySource(source: 'hook' | 'transcript'): SessionMessage[] {
    return this.pipeline.getBySource(source)
      .filter(m => !this.isHidden(m.sessionId));
  }

  get pipelineSize(): number {
    return this.pipeline.size;
  }

  broadcastMessage(msg: SessionMessage, targetDeviceId?: string): void {
    if (this.isHidden(msg.sessionId)) return;
    if (msg.source === 'hook' && msg.event) {
      this.wsBus.broadcast({ type: 'event', sessionId: msg.sessionId, seq: msg.seq, event: msg.event }, targetDeviceId);
    } else if (msg.source === 'transcript' && msg.entry) {
      this.wsBus.broadcast({ type: 'transcript_entry', sessionId: msg.sessionId, seq: msg.seq, entry: msg.entry }, targetDeviceId);
    }
  }

  // ── 历史回放 ──

  async replayHistory(
    sessionId: string,
    fromSeq: number,
    targetDeviceId: string,
  ): Promise<void> {
    let messages: SessionMessage[];

    if (fromSeq > 0) {
      const buffered = this.pipeline.getBufferedForSession(sessionId, fromSeq);

      if (buffered.length === 0) {
        messages = this.eventLogger.readSessionMessagesAfter(sessionId, fromSeq, 1000);
      } else if (fromSeq <= this.pipeline.maxDrainedSeq) {
        const minBufferedSeq = buffered[0].seq;
        const diskMessages = this.eventLogger.readSessionMessagesBetween(
          sessionId, fromSeq, minBufferedSeq,
        );
        messages = [...diskMessages, ...buffered];
      } else {
        messages = buffered;
      }
    } else {
      messages = this.eventLogger.loadSessionHistory(sessionId, 1000);
    }

    for (const msg of messages) {
      this.broadcastMessage(msg, targetDeviceId);
    }
  }

  // ── 序号分配 ──

  nextSeqFn = (): number => {
    return ++this._nextSeq;
  };

  // ── 事件 ──

  onDrain(handler: () => void): void {
    this.pipeline.on('drain', handler);
  }

  offDrain(handler: () => void): void {
    this.pipeline.off('drain', handler);
  }

  // ── 生命周期 ──

  shutdown(): void {
    for (const [sessionId, tailer] of this.tailers) {
      tailer.stop();
    }
    this.tailers.clear();
    this.pipeline.destroy();
  }
}
