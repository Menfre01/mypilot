import { watch, type FSWatcher, closeSync, openSync, readSync, statSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseEntries, classifyEntry, parseTimestamp } from './transcript-reader.js';
import type { MessagePipeline } from './message-pipeline.js';
import type { SessionMessage } from '../../shared/protocol.js';

export interface TailerOptions {
  pollIntervalMs?: number;
  catchUpRetryDelaysMs?: number[];
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

export class TranscriptTailer {
  private sessionId: string;
  private transcriptPath: string;
  private pipeline: MessagePipeline;
  private nextSeqFn: () => number;
  private pollIntervalMs: number;
  private catchUpRetryDelaysMs: number[];

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
    pipeline: MessagePipeline,
    nextSeqFn: () => number,
    options?: TailerOptions,
  ) {
    this.sessionId = sessionId;
    this.transcriptPath = transcriptPath;
    this.pipeline = pipeline;
    this.nextSeqFn = nextSeqFn;
    this.pollIntervalMs = options?.pollIntervalMs ?? 1000;
    this.catchUpRetryDelaysMs = options?.catchUpRetryDelaysMs ?? [200, 400, 800, 1600, 3200];
  }

  get stopped(): boolean {
    return this._stopped;
  }

  async start(): Promise<void> {
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

    // 文件存在，执行追赶读取
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
        this.pipeline.push(msg);
      }
      this.lastKnownSize = result.fileSize;
      this.lastReadIndex = result.entries.length > 0
        ? result.entries[result.entries.length - 1].index + 1
        : 0;
    } catch {
      if (existsSync(this.transcriptPath)) {
        try {
          const st = statSync(this.transcriptPath);
          this.lastKnownSize = st.size;
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

  // ── 内部实现 ──

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

          this.pipeline.push(msg);
          this.lastReadIndex = entryIndex + 1;
        }
      } finally {
        if (fd !== undefined) {
          try { closeSync(fd); } catch { /* ignore */ }
        }
      }

      this.lastKnownSize = currentSize;
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
            this.pipeline.push(msg);
            this.lastReadIndex = entryIndex + 1;
          }
          this.lastKnownSize = currentSize;
        } finally {
          if (fd !== undefined) try { closeSync(fd); } catch { /* ignore */ }
        }
      }
    } catch {
      // 文件不可读时跳过
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
          this.pipeline.push(msg);
        }
      } catch {
        // 真正不完整的行，丢弃
      }
    }
    this.partialLine = '';
  }
}
