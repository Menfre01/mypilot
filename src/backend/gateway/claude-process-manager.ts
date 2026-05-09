import { spawn as spawnPty, type IPty } from 'node-pty';
import { execFileSync, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import type { SessionMode, SessionSource } from '../../shared/protocol.js';

function resolveClaudeBin(): string {
  try {
    return execFileSync('which', ['claude'], { encoding: 'utf8' }).trim();
  } catch {
    return 'claude';
  }
}

export interface SpawnOptions {
  cwd?: string;
  model?: string;
  displayName?: string;
  resumeFrom?: string;
  source?: SessionSource;
}

export interface SessionStatus {
  sessionId: string;
  mode: SessionMode;
  cwd: string;
  displayName?: string;
  startedAt: number;
  lastActivityAt: number;
}

export type StreamJsonHandler = (line: string) => void;

type PtyDataHandler = (data: string) => void;

interface PtyRelayClient {
  send(data: string): void;
  onClose: (handler: () => void) => void;
}

interface ProcessRecord {
  sessionId: string;
  mode: SessionMode;
  cwd: string;
  displayName?: string;
  startedAt: number;
  lastActivityAt: number;
  pty?: IPty;
  child?: ChildProcess;
  relayClients: Set<PtyRelayClient>;
  messageHandlers: Set<StreamJsonHandler>;
  spawnOptions: SpawnOptions;
  /** 最近一次 write 的内容（去除 \n），用于过滤 PTY echo */
  lastWrite?: string;
}

export class ClaudeProcessManager extends EventEmitter {
  private processes = new Map<string, ProcessRecord>();
  private sessionRefs = new Map<string, { current: string }>();

  /** 待对账的 session：初始 UUID → { cwd, createdAt, source }。
   *  SessionStart hook 事件到达时按 cwd + 最近创建时间匹配。
   *  PTY 和 headless 模式都参与对账，以便 HookHandler 统一处理。 */
  private pendingReconciliation = new Map<string, { cwd: string; createdAt: number; source: SessionSource }>();

  /** 创建一个可在对账时自动更新的可变 session ID 引用 */
  createSessionIdRef(sessionId: string): { current: string } {
    const ref = { current: sessionId };
    this.sessionRefs.set(sessionId, ref);
    return ref;
  }

  /** 查找待对账的 session（按 cwd 匹配，取最近创建的），
   *  并将其从 initialId 迁移到 Claude 的真实 session ID。 */
  reconcilePtySession(hookCwd: string): { id: string; source: SessionSource } | undefined {
    let best: { id: string; source: SessionSource; createdAt: number } | undefined;
    for (const [id, info] of this.pendingReconciliation) {
      if (info.cwd === hookCwd) {
        if (!best || info.createdAt > best.createdAt) {
          best = { id, source: info.source, createdAt: info.createdAt };
        }
      }
    }
    if (best) {
      this.pendingReconciliation.delete(best.id);
      return { id: best.id, source: best.source };
    }
    return undefined;
  }

  /** 将 session 从 oldId 迁移到 newId，同步更新所有关联的引用 */
  updateSessionId(oldId: string, newId: string): boolean {
    const record = this.processes.get(oldId);
    if (!record) return false;
    this.processes.delete(oldId);
    record.sessionId = newId;
    this.processes.set(newId, record);

    this.pendingReconciliation.delete(oldId);

    const ref = this.sessionRefs.get(oldId);
    if (ref) {
      ref.current = newId;
      this.sessionRefs.delete(oldId);
      this.sessionRefs.set(newId, ref);
    }

    return true;
  }

  spawnPTY(sessionId: string, options: SpawnOptions = {}): ProcessRecord {
    if (this.processes.has(sessionId)) {
      const existing = this.processes.get(sessionId)!;
      existing.lastActivityAt = Date.now();
      return existing;
    }

    const args = this.buildClaudeArgs(options, 'pty');
    const cwd = options.cwd ?? process.cwd();
    const env = { ...process.env };

    let pty: IPty;
    try {
      pty = spawnPty(resolveClaudeBin(), args, {
        name: 'xterm-256color',
        cols: 80,
        rows: 24,
        cwd,
        env,
      });
    } catch (err) {
      console.error('[ClaudeProcessManager] spawnPTY failed for session %s: %s', (err as Error).message);
      throw err;
    }

    const record: ProcessRecord = {
      sessionId,
      mode: 'pty',
      cwd,
      displayName: options.displayName,
      startedAt: Date.now(),
      lastActivityAt: Date.now(),
      pty,
      relayClients: new Set(),
      messageHandlers: new Set(),
      spawnOptions: options,
    };

    pty.onData((data: string) => {
      try {
        record.lastActivityAt = Date.now();
        for (const client of record.relayClients) {
          try { client.send(data); } catch { /* ignore */ }
        }
        this.tryParseStreamJson(data, record.messageHandlers);
      } catch {
        // PTY data callback threw — don't crash
      }
    });

    // 捕获 ref 对象而非原始字符串，对账后 ref.current 会更新为 Claude 真实 session ID
    const exitRef = this.sessionRefs.get(sessionId);
    pty.onExit(({ exitCode, signal }) => {
      try {
        const currentId = exitRef?.current ?? sessionId;
        this.handleProcessExit(currentId, exitCode, signal ?? null);
      } catch (err) {
        console.error('[ClaudeProcessManager] handleProcessExit error for %s: %s', sessionId, (err as Error).message);
      }
    });

    this.processes.set(sessionId, record);
    this.pendingReconciliation.set(sessionId, { cwd, createdAt: Date.now(), source: options.source ?? 'desktop' });
    this.emit('session_started', this.getStatus(sessionId));
    return record;
  }

  spawnHeadless(sessionId: string, options: SpawnOptions = {}): ProcessRecord {
    if (this.processes.has(sessionId)) {
      const existing = this.processes.get(sessionId)!;
      existing.lastActivityAt = Date.now();
      return existing;
    }

    const args = this.buildClaudeArgs(options, 'headless');
    const cwd = options.cwd ?? process.cwd();
    const env = { ...process.env };

    let pty: IPty;
    try {
      pty = spawnPty(resolveClaudeBin(), args, {
        name: 'xterm-256color',
        cols: 120,
        rows: 40,
        cwd,
        env,
      });
    } catch (err) {
      console.error('[ClaudeProcessManager] spawnHeadless failed for session %s: %s', sessionId, (err as Error).message);
      throw err;
    }

    const record: ProcessRecord = {
      sessionId,
      mode: 'headless',
      cwd,
      displayName: options.displayName,
      startedAt: Date.now(),
      lastActivityAt: Date.now(),
      pty,
      relayClients: new Set(),
      messageHandlers: new Set(),
      spawnOptions: options,
    };

    let lineBuf = '';
    pty.onData((data: string) => {
      try {
        record.lastActivityAt = Date.now();
        lineBuf += data;
        const lines = lineBuf.split('\n');
        lineBuf = lines.pop() ?? '';
        for (const line of lines) {
          const cleaned = ClaudeProcessManager.stripAnsi(line).trim();
          if (!cleaned) continue;
          // 过滤 PTY echo：跳过与最近一次 write 内容匹配的行
          if (record.lastWrite && cleaned === record.lastWrite) {
            record.lastWrite = undefined;
            continue;
          }
          for (const handler of record.messageHandlers) {
            try { handler(cleaned); } catch { /* ignore */ }
          }
        }
      } catch {
        // Stream callback threw — don't crash
      }
    });

    const exitRef = this.sessionRefs.get(sessionId);
    pty.onExit(({ exitCode, signal }) => {
      try {
        if (lineBuf.trim()) {
          const trimmed = ClaudeProcessManager.stripAnsi(lineBuf).trim();
          if (trimmed) {
            for (const handler of record.messageHandlers) {
              try { handler(trimmed); } catch { /* ignore */ }
            }
          }
        }
        const currentId = exitRef?.current ?? sessionId;
        this.handleProcessExit(currentId, exitCode, signal ?? null);
      } catch (err) {
        console.error('[ClaudeProcessManager] handleProcessExit error for %s: %s', sessionId, (err as Error).message);
      }
    });

    this.processes.set(sessionId, record);
    this.pendingReconciliation.set(sessionId, { cwd, createdAt: Date.now(), source: options.source ?? 'mobile' });
    this.emit('session_started', this.getStatus(sessionId));
    return record;
  }

  write(sessionId: string, data: string): void {
    const record = this.processes.get(sessionId);
    if (!record) return;

    record.lastActivityAt = Date.now();

    if (record.pty) {
      record.lastWrite = data.replace(/\n$/, '');
      try {
        record.pty.write(data);
      } catch {
        // PTY may already be dead (race between process exit and onExit callback)
      }
    } else if (record.child?.stdin) {
      record.child.stdin.write(data);
      if (!data.endsWith('\n')) {
        record.child.stdin.write('\n');
      }
    }
  }

  resize(sessionId: string, cols: number, rows: number): void {
    const record = this.processes.get(sessionId);
    if (record?.pty) {
      try {
        record.pty.resize(cols, rows);
      } catch {
        // PTY may already be dead (race between process exit and onExit callback)
      }
    }
  }

  onMessage(sessionId: string, handler: StreamJsonHandler): void {
    const record = this.processes.get(sessionId);
    if (record) {
      record.messageHandlers.add(handler);
    }
  }

  attachRelay(sessionId: string, client: PtyRelayClient): boolean {
    const record = this.processes.get(sessionId);
    if (!record) return false;

    if (record.relayClients.size > 0) {
      // Session already has an attached terminal
      return false;
    }

    record.relayClients.add(client);
    client.onClose(() => {
      record.relayClients.delete(client);
      this.emit('session_detached', sessionId);
    });

    this.emit('session_attached', sessionId);
    return true;
  }

  detachRelay(sessionId: string): void {
    const record = this.processes.get(sessionId);
    if (!record) return;
    record.relayClients.clear();
    this.emit('session_detached', sessionId);
  }

  /** 中断当前操作但不终止进程。通过 PTY 写 \x03（Ctrl+C）触发 SIGINT。 */
  interrupt(sessionId: string): void {
    const record = this.processes.get(sessionId);
    if (!record) return;
    record.lastActivityAt = Date.now();

    if (record.pty) {
      try {
        record.pty.write('\x03');
      } catch { /* ignore */ }
    } else if (record.child) {
      try {
        record.child.kill('SIGINT');
      } catch { /* ignore */ }
    }
  }

  async stop(sessionId: string): Promise<void> {
    const record = this.processes.get(sessionId);
    if (!record) return;

    return new Promise((resolve) => {
      const cleanup = () => {
        record.messageHandlers.clear();
        record.relayClients.clear();
        this.removeRecord(sessionId);
        this.emit('session_ended', sessionId);
        resolve();
      };

      if (record.pty) {
        try {
          record.pty.kill();
        } catch { /* already dead */ }
        cleanup();
      } else if (record.child) {
        const timer = setTimeout(() => {
          try { record.child?.kill('SIGKILL'); } catch { /* ignore */ }
          cleanup();
        }, 5000);

        record.child.on('exit', () => {
          clearTimeout(timer);
          cleanup();
        });

        try {
          record.child.stdin?.end();
          record.child.kill('SIGTERM');
        } catch {
          clearTimeout(timer);
          cleanup();
        }
      } else {
        cleanup();
      }
    });
  }

  kill(sessionId: string): void {
    const record = this.processes.get(sessionId);
    if (!record) return;
    try {
      record.pty?.kill();
      record.child?.kill('SIGKILL');
    } catch { /* ignore */ }
    record.messageHandlers.clear();
    record.relayClients.clear();
    this.removeRecord(sessionId);
    this.emit('session_ended', sessionId);
  }

  async handoff(sessionId: string): Promise<void> {
    const record = this.processes.get(sessionId);
    if (!record || record.mode !== 'headless') return;

    // Stop headless, respawn as PTY with --resume
    await this.stop(sessionId);
    this.spawnPTY(sessionId, {
      ...record.spawnOptions,
      resumeFrom: sessionId,
    });
  }

  getStatus(sessionId: string): SessionStatus | undefined {
    const record = this.processes.get(sessionId);
    if (!record) return undefined;
    return {
      sessionId: record.sessionId,
      mode: record.mode,
      cwd: record.cwd,
      displayName: record.displayName,
      startedAt: record.startedAt,
      lastActivityAt: record.lastActivityAt,
    };
  }

  getActiveSessions(): SessionStatus[] {
    return Array.from(this.processes.values()).map(r => this.getStatus(r.sessionId)!);
  }

  getMostRecentSession(): SessionStatus | undefined {
    let best: ProcessRecord | undefined;
    for (const record of this.processes.values()) {
      if (!best || record.lastActivityAt > best.lastActivityAt) {
        best = record;
      }
    }
    return best ? this.getStatus(best.sessionId) : undefined;
  }

  getMode(sessionId: string): SessionMode | null {
    return this.processes.get(sessionId)?.mode ?? null;
  }

  hasSession(sessionId: string): boolean {
    return this.processes.has(sessionId);
  }

  /** 通过前缀或名称解析 session ID，支持 --kill 使用截断 ID 或 displayName */
  findSessionId(input: string): string | undefined {
    if (this.processes.has(input)) return input;
    const prefixMatches: string[] = [];
    let nameMatch: string | undefined;
    for (const [id, record] of this.processes) {
      if (id.startsWith(input)) prefixMatches.push(id);
      if (record.displayName === input) nameMatch = id;
    }
    if (prefixMatches.length === 1) return prefixMatches[0];
    if (nameMatch) return nameMatch;
    return undefined;
  }

  shutdown(): void {
    for (const [id] of this.processes) {
      this.kill(id);
    }
  }


  private removeRecord(sessionId: string): void {
    this.processes.delete(sessionId);
    this.sessionRefs.delete(sessionId);
    this.pendingReconciliation.delete(sessionId);
  }

  private buildClaudeArgs(options: SpawnOptions, mode: SessionMode): string[] {
    const args: string[] = [];

    if (mode === 'headless') {
      args.push('--print');
      args.push('--verbose');
      args.push('--input-format', 'stream-json');
      args.push('--output-format', 'stream-json');
      args.push('--include-hook-events');
    }

    if (options.model) {
      args.push('--model', options.model);
    }

    if (options.resumeFrom) {
      args.push('--resume', options.resumeFrom);
    }

    return args;
  }

  private static stripAnsi(text: string): string {
    return text.replace(/\r/g, '').replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
  }

  private handleProcessExit(sessionId: string, exitCode: number | null, signal: number | string | null): void {
    const record = this.processes.get(sessionId);
    if (!record) return;

    // pty.onExit means the process has died; terminal detach does not trigger this
    const exitDesc = exitCode != null ? `code=${exitCode}` : `signal=${signal}`;
    console.log('[ClaudeProcessManager] session %s exited (%s)', sessionId, exitDesc);

    this.removeRecord(sessionId);
    record.messageHandlers.clear();
    record.relayClients.clear();
    this.emit('session_ended', sessionId);
  }

  private tryParseStreamJson(data: string, handlers: Set<StreamJsonHandler>): void {
    // Only attempt parsing if there are registered message handlers
    if (handlers.size === 0) return;

    // In PTY mode, output is mixed with TUI escape sequences.
    // Try to extract JSONL lines that look like stream-json messages.
    const lines = data.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      // Quick check: must start with { and contain "type"
      if (!trimmed.startsWith('{') || !trimmed.includes('"type"')) continue;
      try {
        JSON.parse(trimmed); // Validate it's parseable JSON
        for (const handler of handlers) {
          try { handler(trimmed); } catch { /* ignore */ }
        }
      } catch {
        // Not valid JSON, skip
      }
    }
  }
}
