import type { TranscriptEntry } from '../../shared/protocol.js';
import type { SessionStreamManager } from './session-stream-manager.js';

export class TranscriptBridge {
  private streamManager: SessionStreamManager;

  constructor(streamManager: SessionStreamManager) {
    this.streamManager = streamManager;
  }

  /** SessionStart 时启动 transcript tailer */
  startSession(sessionId: string, transcriptPath: string): void {
    this.streamManager.startSession(sessionId, transcriptPath);
  }

  /** SessionEnd 时停止 transcript tailer */
  stopSession(sessionId: string): void {
    this.streamManager.stopSession(sessionId);
  }

  /** 获取最近的 transcript entries（用于客户端连接恢复，从管道缓冲区获取） */
  getRecentTranscriptEntries(
    afterSeq: number,
    maxCount: number,
  ): { sessionId: string; seq: number; entry: TranscriptEntry }[] {
    const messages = this.streamManager.getAllTranscriptEntries();
    return messages
      .filter(m => m.seq > afterSeq && m.entry)
      .slice(-maxCount)
      .map(m => ({ sessionId: m.sessionId, seq: m.seq, entry: m.entry! }));
  }
}
