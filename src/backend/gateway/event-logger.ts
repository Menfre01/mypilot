import { appendFileSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { SSEHookEvent, TranscriptEntry, SessionMessage } from "../../shared/protocol.js";
import { parseEntries } from "./transcript-reader.js";

const HISTORY_DAYS = 7;

export class EventLogger {
  private logDir: string;

  constructor(logDir: string) {
    this.logDir = logDir;
    try {
      mkdirSync(logDir, { recursive: true });
    } catch {
      // Directory creation failure — log() will silently fail too
    }
  }

  log(sessionId: string, event: SSEHookEvent, seq?: number): void {
    try {
      const now = new Date();
      const date = now.toISOString().slice(0, 10);
      const filePath = join(this.logDir, `events-${date}.jsonl`);
      const entry: Record<string, unknown> = { _timestamp: now.getTime(), _sessionId: sessionId, ...event };
      if (seq !== undefined) {
        entry._seq = seq;
      }
      appendFileSync(filePath, JSON.stringify(entry) + "\n");
    } catch {
      // Silent failure — logging must not break event processing
    }
  }

  /** Searches the last 7 days of JSONL logs for transcript entries after the given seq. */
  readTranscriptEntriesAfter(
    afterSeq: number,
    maxCount: number,
  ): { sessionId: string; seq: number; entry: TranscriptEntry }[] {
    const all = this._parseRecentTranscriptEntries();
    const filtered = all.filter((e) => e.seq > afterSeq);
    return filtered.slice(0, maxCount);
  }

  /** Searches the last 7 days of JSONL logs for events after the given seq. */
  readEventsAfter(afterSeq: number, maxCount: number): { sessionId: string; event: SSEHookEvent }[] {
    const all = this._parseRecentEvents();
    const filtered = all.filter(e => e.seq > afterSeq);
    return filtered.slice(0, maxCount).map(({ sessionId, event }) => ({ sessionId, event }));
  }

  /** Load the most recent N events — used for server restart recovery. */
  loadRecentEvents(count: number): { sessionId: string; event: SSEHookEvent; seq: number }[] {
    const all = this._parseRecentEvents();
    return all.slice(-count);
  }

  getMaxSessionSeq(): number {
    let maxSeq = 0;
    let dirFiles: string[];
    try {
      dirFiles = readdirSync(this.logDir);
    } catch {
      return 0;
    }
    for (const date of this._iterRecentDates()) {
      for (const file of dirFiles) {
        if (!file.startsWith('session-') || !file.endsWith(`-${date}.jsonl`)) continue;
        try {
          const entries = parseEntries(readFileSync(join(this.logDir, file), 'utf-8').split('\n'));
          for (const record of entries) {
            const seq = record._seq as number | undefined;
            if (seq !== undefined && seq > maxSeq) maxSeq = seq;
          }
        } catch { /* skip unreadable files */ }
      }
    }
    return maxSeq;
  }

  // ── SessionMessage 日志 ──

  logSessionMessage(msg: SessionMessage): void {
    try {
      const now = new Date();
      const date = now.toISOString().slice(0, 10);
      const filePath = join(this.logDir, `session-${msg.sessionId}-${date}.jsonl`);
      const record: Record<string, unknown> = {
        _timestamp: now.getTime(),
        _seq: msg.seq,
        ...msg,
      };
      appendFileSync(filePath, JSON.stringify(record) + "\n");
    } catch {
      // Silent failure
    }
  }

  loadSessionHistory(sessionId: string, maxCount?: number): SessionMessage[] {
    const results: SessionMessage[] = [];
    for (const date of this._iterRecentDates()) {
      const filePath = join(this.logDir, `session-${sessionId}-${date}.jsonl`);
      try {
        const entries = parseEntries(readFileSync(filePath, "utf-8").split("\n"));
        for (const record of entries) {
          const msg = this._extractSessionMessage(record);
          if (msg) results.push(msg);
        }
      } catch {
        // File read error — skip (including ENOENT)
      }
    }

    results.sort((a, b) => a.seq - b.seq);
    if (maxCount !== undefined) return results.slice(-maxCount);
    return results;
  }

  readSessionMessagesAfter(
    sessionId: string,
    afterSeq: number,
    maxCount?: number,
  ): SessionMessage[] {
    const history = this.loadSessionHistory(sessionId);
    const filtered = history.filter(m => m.seq > afterSeq);
    if (maxCount !== undefined) return filtered.slice(0, maxCount);
    return filtered;
  }

  /** 读取 (afterSeq, beforeSeq) 区间内的 session 消息，用于填补管道缓冲区 gap */
  readSessionMessagesBetween(
    sessionId: string,
    afterSeq: number,
    beforeSeq: number,
  ): SessionMessage[] {
    const history = this.loadSessionHistory(sessionId);
    return history.filter(m => m.seq > afterSeq && m.seq < beforeSeq);
  }

  /** 读取 (afterSeq, beforeSeq) 区间内的 transcript entry，用于填补 gap */
  readTranscriptEntriesBetween(
    afterSeq: number,
    beforeSeq: number,
  ): { sessionId: string; seq: number; entry: TranscriptEntry }[] {
    const all = this._parseRecentTranscriptEntries();
    return all.filter(e => e.seq > afterSeq && e.seq < beforeSeq);
  }

  // ── 内部解析 ──

  private _iterRecentDates(): string[] {
    const dates: string[] = [];
    const now = new Date();
    for (let i = HISTORY_DAYS - 1; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      dates.push(d.toISOString().slice(0, 10));
    }
    return dates;
  }

  private _extractSessionMessage(record: Record<string, unknown>): SessionMessage | null {
    const sessionId = record.sessionId as string | undefined;
    const seq = record._seq as number | undefined;
    const timestamp = record.timestamp as number | undefined;
    const source = record.source as 'hook' | 'transcript' | undefined;
    if (!sessionId || seq === undefined || !timestamp || !source) return null;
    const msg: SessionMessage = { sessionId, seq, timestamp, source };
    if (source === 'hook') {
      if (record.event && typeof record.event === 'object') {
        msg.event = record.event as SSEHookEvent;
      }
    } else if (source === 'transcript') {
      if (record.entry && typeof record.entry === 'object') {
        msg.entry = record.entry as TranscriptEntry;
      }
    }
    return msg;
  }

  private _parseRecentEvents(): { sessionId: string; event: SSEHookEvent; seq: number }[] {
    const results: { sessionId: string; event: SSEHookEvent; seq: number }[] = [];
    const files = this._getRecentLogFiles();

    for (const file of files) {
      try {
        const entries = parseEntries(readFileSync(file, "utf-8").split("\n"));
        for (const entry of entries) {
          const seq = entry._seq as number | undefined;
          if (seq !== undefined) {
            const { _timestamp, _sessionId, _seq, ...rest } = entry;
            results.push({
              sessionId: _sessionId as string,
              event: rest as unknown as SSEHookEvent,
              seq,
            });
          }
        }
      } catch {
        // File read error — skip
      }
    }

    results.sort((a, b) => a.seq - b.seq);
    return results;
  }

  private _parseRecentTranscriptEntries(): {
    sessionId: string;
    seq: number;
    entry: TranscriptEntry;
  }[] {
    const results: { sessionId: string; seq: number; entry: TranscriptEntry }[] = [];
    let dirFiles: string[];
    try {
      dirFiles = readdirSync(this.logDir);
    } catch {
      return results;
    }

    for (const date of this._iterRecentDates()) {
      for (const file of dirFiles) {
        if (!file.startsWith('session-') || !file.endsWith(`-${date}.jsonl`)) continue;
        try {
          const entries = parseEntries(readFileSync(join(this.logDir, file), "utf-8").split("\n"));
          for (const record of entries) {
            if (record.source !== 'transcript') continue;
            const seq = record._seq as number | undefined;
            const sessionId = record.sessionId as string | undefined;
            const entry = record.entry as TranscriptEntry | undefined;
            if (seq !== undefined && sessionId && entry) {
              results.push({ sessionId, seq, entry });
            }
          }
        } catch {
          // File read error — skip
        }
      }
    }

    results.sort((a, b) => a.seq - b.seq);
    return results;
  }

  private _getRecentLogFiles(): string[] {
    const files: string[] = [];
    for (const date of this._iterRecentDates()) {
      files.push(join(this.logDir, `events-${date}.jsonl`));
    }
    return files;
  }
}
