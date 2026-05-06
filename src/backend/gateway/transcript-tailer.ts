import { watch, type FSWatcher, closeSync, openSync, readSync, statSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseEntries, classifyEntry, parseTimestamp } from './transcript-reader.js';
import type { SessionMessage } from '../../shared/protocol.js';
import type { TailerStateStore } from './tailer-state-store.js';

export interface TailerOptions {
  pollIntervalMs?: number;
  catchUpRetryDelaysMs?: number[];
  stateStore?: TailerStateStore;
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

export class TranscriptTailer {
  private sessionId: string;
  private transcriptPath: string;
  private onPush: (msg: SessionMessage) => void;
  private nextSeqFn: () => number;
  private pollIntervalMs: number;
  private catchUpRetryDelaysMs: number[];
  private stateStore?: TailerStateStore;

  private lastKnownSize = 0;
  private lastReadIndex = 0;
  private partialLine = '';
  private _reading = false;
  private _dirty = false;
  private _stopped = false;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private watcher: FSWatcher | null = null;

  constructor(
    sessionId: string,
    transcriptPath: string,
    onPush: (msg: SessionMessage) => void,
    nextSeqFn: () => number,
    options?: TailerOptions,
  ) {
    this.sessionId = sessionId;
    this.transcriptPath = transcriptPath;
    this.onPush = onPush;
    this.nextSeqFn = nextSeqFn;
    this.pollIntervalMs = options?.pollIntervalMs ?? 1000;
    this.catchUpRetryDelaysMs = options?.catchUpRetryDelaysMs ?? [200, 400, 800, 1600, 3200];
    this.stateStore = options?.stateStore;
  }

  get stopped(): boolean {
    return this._stopped;
  }

  async start(): Promise<void> {
    const persistedSize = this.stateStore?.getLastKnownSize(this.transcriptPath);
    if (persistedSize !== undefined) {
      this.lastKnownSize = persistedSize;
    }

    let fileReady = false;
    for (const delayMs of this.catchUpRetryDelaysMs) {
      if (existsSync(this.transcriptPath)) {
        fileReady = true;
        break;
      }
      await sleep(delayMs);
    }
    if (!fileReady && !existsSync(this.transcriptPath)) {
      this._startWatching();
      return;
    }

    try {
      const st = statSync(this.transcriptPath);
      if (st.size <= this.lastKnownSize) {
        this._startWatching();
        return;
      }
    } catch {
      this._startWatching();
      return;
    }

    try {
      const { readTranscript } = await import('./transcript-reader.js');
      const result = await readTranscript(this.transcriptPath, 0);
      for (const entry of result.entries) {
        if (this._stopped) return;
        const msg: SessionMessage = {
          sessionId: this.sessionId,
          seq: this.nextSeqFn(),
          timestamp: entry.timestamp,
          source: 'transcript',
          entry,
        };
        this.onPush(msg);
      }
      this.lastKnownSize = result.fileSize;
      this.lastReadIndex = result.entries.length > 0
        ? result.entries[result.entries.length - 1].index + 1
        : 0;
      this.stateStore?.setLastKnownSize(this.transcriptPath, this.lastKnownSize);
    } catch {
      if (existsSync(this.transcriptPath)) {
        try {
          const st = statSync(this.transcriptPath);
          this.lastKnownSize = st.size;
          this.stateStore?.setLastKnownSize(this.transcriptPath, this.lastKnownSize);
        } catch {
          this.lastKnownSize = 0;
        }
      }
    }

    if (this._stopped) return;

    this._startWatching();
  }

  stop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }

    this._finalFlush();

    this._stopped = true;
  }

  private _startWatching(): void {
    this.pollTimer = setInterval(() => {
      void this._checkForChanges();
    }, this.pollIntervalMs);

    const parentDir = dirname(this.transcriptPath);
    try {
      this.watcher = watch(parentDir, { persistent: false }, (_eventType, filename) => {
        if (filename && this.transcriptPath.endsWith(filename)) {
          void this._checkForChanges();
        }
      });
    } catch {
      // fs.watch 不可用时仅依赖 poll
    }
  }

  private async _checkForChanges(): Promise<void> {
    if (this._stopped) return;
    if (this._reading) {
      this._dirty = true;
      return;
    }
    this._reading = true;

    try {
      let currentSize: number;
      try {
        const st = statSync(this.transcriptPath);
        currentSize = st.size;
      } catch {
        return;
      }

      if (currentSize < this.lastKnownSize) {
        this.lastKnownSize = 0;
        this.lastReadIndex = 0;
        this.partialLine = '';
        this.stateStore?.setLastKnownSize(this.transcriptPath, 0);
      }

      if (currentSize <= this.lastKnownSize) return;

      const bytesToRead = currentSize - this.lastKnownSize;
      const buf = Buffer.alloc(bytesToRead);
      let fd: number | undefined;
      try {
        fd = openSync(this.transcriptPath, 'r');
        const bytesRead = readSync(fd, buf, 0, bytesToRead, this.lastKnownSize);
        const text = this.partialLine + new TextDecoder().decode(buf.subarray(0, bytesRead));
        const lines = text.split('\n');

        if (!text.endsWith('\n')) {
          this.partialLine = lines.pop() ?? '';
        } else {
          this.partialLine = '';
        }

        const entries = parseEntries(lines);
        for (const rawEntry of entries) {
          if (this._stopped) break;
          const parsed = classifyEntry(rawEntry);
          if (!parsed) continue;

          const entryIndex = typeof rawEntry.index === 'number'
            ? rawEntry.index
            : this.lastReadIndex;

          const msg: SessionMessage = {
            sessionId: this.sessionId,
            seq: this.nextSeqFn(),
            timestamp: parseTimestamp(rawEntry.timestamp),
            source: 'transcript',
            entry: {
              index: entryIndex,
              type: rawEntry.type as 'assistant' | 'user',
              timestamp: parseTimestamp(rawEntry.timestamp),
              model: parsed.model,
              usage: parsed.usage,
              blocks: parsed.blocks,
            },
          };

          this.onPush(msg);
          this.lastReadIndex = entryIndex + 1;
        }
      } finally {
        if (fd !== undefined) {
          try { closeSync(fd); } catch { /* ignore */ }
        }
      }

      this.lastKnownSize = currentSize;
      this.stateStore?.setLastKnownSize(this.transcriptPath, currentSize);
    } finally {
      this._reading = false;
    }

    if (this._dirty) {
      this._dirty = false;
      void this._checkForChanges();
    }
  }

  private _finalFlush(): void {
    try {
      const st = statSync(this.transcriptPath);
      const currentSize = st.size;
      if (currentSize > this.lastKnownSize) {
        const bytesToRead = currentSize - this.lastKnownSize;
        const buf = Buffer.alloc(bytesToRead);
        let fd: number | undefined;
        try {
          fd = openSync(this.transcriptPath, 'r');
          const bytesRead = readSync(fd, buf, 0, bytesToRead, this.lastKnownSize);
          const text = this.partialLine + new TextDecoder().decode(buf.subarray(0, bytesRead));
          const lines = text.split('\n');
          this.partialLine = text.endsWith('\n') ? '' : (lines.pop() ?? '');
          const entries = parseEntries(lines);
          for (const rawEntry of entries) {
            const parsed = classifyEntry(rawEntry);
            if (!parsed) continue;
            const entryIndex = typeof rawEntry.index === 'number' ? rawEntry.index : this.lastReadIndex;
            const msg: SessionMessage = {
              sessionId: this.sessionId,
              seq: this.nextSeqFn(),
              timestamp: parseTimestamp(rawEntry.timestamp),
              source: 'transcript',
              entry: {
                index: entryIndex,
                type: rawEntry.type as 'assistant' | 'user',
                timestamp: parseTimestamp(rawEntry.timestamp),
                model: parsed.model,
                usage: parsed.usage,
                blocks: parsed.blocks,
              },
            };
            this.onPush(msg);
            this.lastReadIndex = entryIndex + 1;
          }
          this.lastKnownSize = currentSize;
          this.stateStore?.setLastKnownSize(this.transcriptPath, currentSize);
        } finally {
          if (fd !== undefined) try { closeSync(fd); } catch { /* ignore */ }
        }
      }
    } catch {
      /* ignore */
    }

    if (this.partialLine.trim()) {
      try {
        const rawEntry = JSON.parse(this.partialLine);
        const parsed = classifyEntry(rawEntry);
        if (parsed) {
          const entryIndex = typeof rawEntry.index === 'number' ? rawEntry.index : this.lastReadIndex;
          const msg: SessionMessage = {
            sessionId: this.sessionId,
            seq: this.nextSeqFn(),
            timestamp: parseTimestamp(rawEntry.timestamp),
            source: 'transcript',
            entry: {
              index: entryIndex,
              type: rawEntry.type as 'assistant' | 'user',
              timestamp: parseTimestamp(rawEntry.timestamp),
              model: parsed.model,
              usage: parsed.usage,
              blocks: parsed.blocks,
            },
          };
          this.onPush(msg);
        }
      } catch {
        // 真正不完整的行，丢弃
      }
    }
    this.partialLine = '';
  }
}
