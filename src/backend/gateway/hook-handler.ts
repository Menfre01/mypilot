import { SessionStore } from './session-store.js';
import { PendingStore } from './pending-store.js';
import { WsBus } from './ws-bus.js';
import { EventLogger } from './event-logger.js';
import {
  isUserInteractionEvent,
  isInteractivePreToolUse,
} from '../../shared/events.js';
import type {
  GatewayMode,
  InteractionResponse,
  SSEHookEvent,
  GatewayMessage,
} from '../../shared/protocol.js';

interface RawHookEvent {
  session_id: string;
  hook_event_name: string;
  [key: string]: unknown;
}

export class HookHandler {
  private sessionStore: SessionStore;
  private pendingStore: PendingStore;
  private wsBus: WsBus;
  private mode: GatewayMode = 'takeover';
  private eventLogger: EventLogger | null;
  private _seq = 0;
  private eventHistory: { sessionId: string; event: SSEHookEvent }[] = [];
  private maxHistory = 200;

  constructor(sessionStore: SessionStore, pendingStore: PendingStore, wsBus: WsBus, eventLogger?: EventLogger) {
    this.sessionStore = sessionStore;
    this.pendingStore = pendingStore;
    this.wsBus = wsBus;
    this.eventLogger = eventLogger ?? null;

    // Restore event history, seq, and active sessions from JSONL logs on startup
    if (this.eventLogger) {
      const recent = this.eventLogger.loadRecentEvents(this.maxHistory);
      for (const entry of recent) {
        this.eventHistory.push({ sessionId: entry.sessionId, event: entry.event });
        const seq = entry.seq;
        if (seq > this._seq) this._seq = seq;

        // Replay session registration (mirrors handleEvent auto-registration)
        this.sessionStore.register(entry.sessionId);

        // Unregister ended sessions
        const eventName = entry.event.event_name as string | undefined;
        if (eventName === 'SessionEnd') {
          this.sessionStore.unregister(entry.sessionId);
        }
      }
    }
  }

  async handleEvent(body: string): Promise<InteractionResponse> {
    // 1. Parse JSON
    let event: RawHookEvent;
    try {
      event = JSON.parse(body) as RawHookEvent;
    } catch {
      throw new Error('Invalid JSON body');
    }

    // 2. Extract session_id (required)
    const sessionId = event.session_id;
    if (!sessionId || typeof sessionId !== 'string') {
      throw new Error('Missing or invalid session_id');
    }

    // 3. Extract event_name (Claude Code sends hook_event_name)
    const eventName = event.hook_event_name;

    // 4. Register session (broadcast session_start for any new session)
    const isNewSession = !this.sessionStore.has(sessionId);
    const sessionInfo = this.sessionStore.register(sessionId);

    // 5. Build the SSEHookEvent with normalized event_name field + unique event_id
    const seq = ++this._seq;
    const eventId = seq.toString(36);
    const hookEvent: SSEHookEvent = { ...event, event_name: eventName, event_id: eventId };

    // 6. Record in history buffer
    this.eventHistory.push({ sessionId, event: hookEvent });
    if (this.eventHistory.length > this.maxHistory) {
      this.eventHistory.shift();
    }

    // 6.5 Persist to log file
    this.eventLogger?.log(sessionId, hookEvent, seq);

    // 7. Notify frontend of new session (defensive: any event can introduce a session)
    if (isNewSession) {
      this.wsBus.broadcast({ type: 'session_start', session: sessionInfo });
    }

    // 8. Takeover mode + user interaction events or interactive PreToolUse: block
    if (this.mode === 'takeover' && (isUserInteractionEvent(eventName) || isInteractivePreToolUse(eventName, hookEvent))) {
      this.wsBus.broadcast({ type: 'event', sessionId, event: hookEvent });
      return this.pendingStore.waitForResponse(sessionId, eventId, hookEvent);
    }

    // 9. Broadcast event to frontend (bystander mode + non-blocking events)
    this.wsBus.broadcast({ type: 'event', sessionId, event: hookEvent });

    // 10. Handle session end
    if (eventName === 'SessionEnd') {
      this.wsBus.broadcast({ type: 'session_end', sessionId });
      this.sessionStore.unregister(sessionId);
      this.pendingStore.releaseSession(sessionId);
      return {};
    }

    // All other events — return {} immediately
    return {};
  }

  setMode(mode: GatewayMode): void {
    if (this.mode === 'takeover' && mode === 'bystander') {
      this.pendingStore.releaseAll();
    }
    this.mode = mode;
    this.wsBus.broadcast({ type: 'mode_changed', mode });
  }

  getMode(): GatewayMode {
    return this.mode;
  }

  getEventHistory(): { sessionId: string; event: SSEHookEvent }[] {
    return this.eventHistory;
  }

  getPendingInteractions(): { sessionId: string; eventId: string; event: SSEHookEvent }[] {
    return this.pendingStore.getPending();
  }
}
