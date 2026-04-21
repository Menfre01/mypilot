import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { SSEHookEvent } from "../../shared/protocol.js";

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

  private _parseRecentEvents(): { sessionId: string; event: SSEHookEvent; seq: number }[] {
    const results: { sessionId: string; event: SSEHookEvent; seq: number }[] = [];
    const files = this._getRecentLogFiles();

    for (const file of files) {
      try {
        const lines = readFileSync(file, "utf-8").split("\n");
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const entry = JSON.parse(line) as Record<string, unknown>;
            const seq = entry._seq as number | undefined;
            if (seq !== undefined) {
              const { _timestamp, _sessionId, _seq, ...rest } = entry;
              results.push({
                sessionId: _sessionId as string,
                event: rest as unknown as SSEHookEvent,
                seq,
              });
            }
          } catch {
            // Skip malformed lines
          }
        }
      } catch {
        // File read error — skip
      }
    }

    results.sort((a, b) => a.seq - b.seq);
    return results;
  }

  private _getRecentLogFiles(): string[] {
    const now = new Date();
    const files: string[] = [];
    for (let i = HISTORY_DAYS - 1; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      const date = d.toISOString().slice(0, 10);
      const filePath = join(this.logDir, `events-${date}.jsonl`);
      if (existsSync(filePath)) {
        files.push(filePath);
      }
    }
    return files;
  }
}
