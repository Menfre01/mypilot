import type { InteractionResponse, SSEHookEvent } from '../../shared/protocol.js';

export class PendingStore {
  private pending = new Map<string, Map<string, { resolve: (response: InteractionResponse) => void; event: SSEHookEvent }>>();
  /** tool_use_id → { sessionId, eventId } 反向索引，用于 PostToolUse 自动 resolve */
  private toolUseIndex = new Map<string, { sessionId: string; eventId: string }>();

  waitForResponse(sessionId: string, eventId: string, event: SSEHookEvent): Promise<InteractionResponse> {
    return new Promise<InteractionResponse>((resolve) => {
      let sessionMap = this.pending.get(sessionId);
      if (!sessionMap) {
        sessionMap = new Map();
        this.pending.set(sessionId, sessionMap);
      }
      sessionMap.set(eventId, { resolve, event });

      // 建立 tool_use_id 反向索引
      const toolUseId = event.tool_use_id as string | undefined;
      if (toolUseId) {
        this.toolUseIndex.set(toolUseId, { sessionId, eventId });
      }
    });
  }

  resolve(sessionId: string, eventId: string, response: InteractionResponse): void {
    const sessionMap = this.pending.get(sessionId);
    if (!sessionMap) return;
    const entry = sessionMap.get(eventId);
    if (!entry) return;

    // 清理 tool_use_id 反向索引
    const toolUseId = entry.event.tool_use_id as string | undefined;
    if (toolUseId) {
      this.toolUseIndex.delete(toolUseId);
    }

    entry.resolve(response);
    sessionMap.delete(eventId);
    if (sessionMap.size === 0) {
      this.pending.delete(sessionId);
    }
  }

  /** 通过 tool_use_id 查找并 resolve（用于 PostToolUse 自动释放） */
  resolveByToolUseId(toolUseId: string): boolean {
    const entry = this.toolUseIndex.get(toolUseId);
    if (!entry) return false;
    this.resolve(entry.sessionId, entry.eventId, {});
    return true;
  }

  releaseAll(): void {
    for (const sessionMap of this.pending.values()) {
      for (const entry of sessionMap.values()) {
        entry.resolve({});
      }
    }
    this.pending.clear();
    this.toolUseIndex.clear();
  }

  releaseSession(sessionId: string): void {
    const sessionMap = this.pending.get(sessionId);
    if (!sessionMap) return;
    for (const entry of sessionMap.values()) {
      entry.resolve({});
      const toolUseId = entry.event.tool_use_id as string | undefined;
      if (toolUseId) this.toolUseIndex.delete(toolUseId);
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
