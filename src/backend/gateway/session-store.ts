import type { SessionInfo } from '../../shared/protocol.js';

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

  getStaleIds(thresholdMs: number): string[] {
    const now = Date.now();
    const stale: string[] = [];
    for (const [id, lastSeen] of this.lastActivityAt) {
      if (now - lastSeen > thresholdMs) {
        stale.push(id);
      }
    }
    return stale;
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
}
