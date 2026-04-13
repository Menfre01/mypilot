import type { InteractionResponse, SSEHookEvent } from '../../shared/protocol.js';

export class PendingStore {
  private pending = new Map<string, Map<string, { resolve: (response: InteractionResponse) => void; event: SSEHookEvent }>>();

  waitForResponse(sessionId: string, eventId: string, event: SSEHookEvent): Promise<InteractionResponse> {
    return new Promise<InteractionResponse>((resolve) => {
      let sessionMap = this.pending.get(sessionId);
      if (!sessionMap) {
        sessionMap = new Map();
        this.pending.set(sessionId, sessionMap);
      }
      sessionMap.set(eventId, { resolve, event });
    });
  }

  resolve(sessionId: string, eventId: string, response: InteractionResponse): void {
    const sessionMap = this.pending.get(sessionId);
    if (!sessionMap) return;
    const entry = sessionMap.get(eventId);
    if (!entry) return;
    entry.resolve(response);
    sessionMap.delete(eventId);
    if (sessionMap.size === 0) {
      this.pending.delete(sessionId);
    }
  }

  releaseAll(): void {
    for (const sessionMap of this.pending.values()) {
      for (const entry of sessionMap.values()) {
        entry.resolve({});
      }
    }
    this.pending.clear();
  }

  releaseSession(sessionId: string): void {
    const sessionMap = this.pending.get(sessionId);
    if (!sessionMap) return;
    for (const entry of sessionMap.values()) {
      entry.resolve({});
    }
    this.pending.delete(sessionId);
  }

  has(sessionId: string, eventId: string): boolean {
    return this.pending.get(sessionId)?.has(eventId) ?? false;
  }

  getPending(): { sessionId: string; eventId: string; event: SSEHookEvent }[] {
    const result: { sessionId: string; eventId: string; event: SSEHookEvent }[] = [];
    for (const [sessionId, sessionMap] of this.pending) {
      for (const [eventId, entry] of sessionMap) {
        result.push({ sessionId, eventId, event: entry.event });
      }
    }
    return result;
  }
}
