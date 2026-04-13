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
    this.colorCounter++;
    return info;
  }

  unregister(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  get(sessionId: string): SessionInfo | undefined {
    return this.sessions.get(sessionId);
  }

  getAll(): SessionInfo[] {
    return Array.from(this.sessions.values());
  }

  has(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }
}
