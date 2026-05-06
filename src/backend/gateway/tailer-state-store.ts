import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

const TAILER_STATE_FILE = 'tailer-state.json';

interface TailerState {
  [transcriptPath: string]: number; // lastKnownSize
}

export class TailerStateStore {
  private state: TailerState;
  private filePath: string;
  private dirty = false;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(pidDir: string) {
    this.filePath = join(pidDir, TAILER_STATE_FILE);
    mkdirSync(dirname(this.filePath), { recursive: true });
    this.state = this._load();
  }

  private _load(): TailerState {
    try {
      const content = readFileSync(this.filePath, 'utf-8');
      const parsed = JSON.parse(content);
      if (typeof parsed !== 'object' || parsed == null) return {};
      return parsed as TailerState;
    } catch {
      return {};
    }
  }

  private _schedulePersist(): void {
    this.dirty = true;
    if (this.persistTimer != null) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      if (this.dirty) {
        this._persist();
      }
    }, 5000);
  }

  private _persist(): void {
    this.dirty = false;
    writeFileSync(this.filePath, JSON.stringify(this.state, null, 2), 'utf-8');
  }

  getLastKnownSize(transcriptPath: string): number | undefined {
    return this.state[transcriptPath];
  }

  setLastKnownSize(transcriptPath: string, size: number): void {
    if (this.state[transcriptPath] === size) return;
    this.state[transcriptPath] = size;
    this._schedulePersist();
  }

  remove(transcriptPath: string): void {
    delete this.state[transcriptPath];
    this._schedulePersist();
  }

  flush(): void {
    if (this.persistTimer != null) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    if (this.dirty) {
      this._persist();
    }
  }
}
