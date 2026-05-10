import type { SessionInfo, SessionSource } from '../../shared/protocol.js';

export const SESSION_COLORS = [
  "#89b4fa",
  "#a6e3a1",
  "#f38ba8",
  "#f9e2af",
  "#b4befe",
  "#89dceb",
  "#fab387",
  "#cba6f7",
];

export class SessionStore {
  private sessions = new Map<string, SessionInfo>();
  private lastActivityAt = new Map<string, number>();
  private hiddenIds = new Set<string>();
  private colorCounter = 0;

  register(sessionId: string): SessionInfo {
    const existing = this.sessions.get(sessionId);
    if (existing) return existing;

    const colorIndex = this.colorCounter % SESSION_COLORS.length;
    const info: SessionInfo = {
      id: sessionId,
      color: SESSION_COLORS[colorIndex],
      colorIndex,
      startedAt: Date.now(),
    };
    this.sessions.set(sessionId, info);
    this.lastActivityAt.set(sessionId, Date.now());
    this.colorCounter++;
    return info;
  }

  touch(sessionId: string): void {
    if (this.sessions.has(sessionId)) {
      this.lastActivityAt.set(sessionId, Date.now());
    }
  }

  unregister(sessionId: string): void {
    this.sessions.delete(sessionId);
    this.lastActivityAt.delete(sessionId);
    this.hiddenIds.delete(sessionId);
  }

  get(sessionId: string): SessionInfo | undefined {
    return this.sessions.get(sessionId);
  }

  markHidden(sessionId: string): void {
    if (this.sessions.has(sessionId)) {
      this.hiddenIds.add(sessionId);
    }
  }

  isHidden(sessionId: string): boolean {
    return this.hiddenIds.has(sessionId);
  }

  getAll(includeHidden = false): SessionInfo[] {
    const all = Array.from(this.sessions.values());
    if (includeHidden) return all;
    return all.filter(s => !this.hiddenIds.has(s.id));
  }

  has(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  private update(sessionId: string, patch: Partial<SessionInfo>): void {
    const info = this.sessions.get(sessionId);
    if (info) {
      this.sessions.set(sessionId, { ...info, ...patch });
    }
  }

  setDisplayName(sessionId: string, name: string): void {
    this.update(sessionId, { displayName: name });
  }

  setSource(sessionId: string, source: SessionSource): void {
    this.update(sessionId, { source });
  }

  setCwd(sessionId: string, cwd: string): void {
    this.update(sessionId, { cwd });
  }

  /** 将 session 信息从 oldId 迁移到 newId，保留所有元数据。
   *  当 newId 已存在时（hook 事件先于 stream-json 对账到达），
   *  合并两者信息，以 oldId 的元数据为主。 */
  updateId(oldId: string, newId: string): boolean {
    const info = this.sessions.get(oldId);
    if (!info) return false;
    this.sessions.delete(oldId);
    this.sessions.set(newId, { ...this.sessions.get(newId), ...info, id: newId });

    const lastSeen = this.lastActivityAt.get(oldId);
    if (lastSeen !== undefined) {
      this.lastActivityAt.delete(oldId);
      this.lastActivityAt.set(newId, lastSeen);
    }

    if (this.hiddenIds.has(oldId)) {
      this.hiddenIds.delete(oldId);
      this.hiddenIds.add(newId);
    }

    return true;
  }
}
