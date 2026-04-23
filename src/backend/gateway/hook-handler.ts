import { SessionStore } from './session-store.js';
import { PendingStore } from './pending-store.js';
import { DeviceStore } from './device-store.js';
import { WsBus } from './ws-bus.js';
import { EventLogger } from './event-logger.js';
import { PushService } from './push-service.js';
import {
  isUserInteractionEvent,
  isInteractivePreToolUse,
} from '../../shared/events.js';
import type {
  GatewayMode,
  InteractionResponse,
  SSEHookEvent,
  GatewayMessage,
  HookEventName,
} from '../../shared/protocol.js';

export class HttpError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

interface RawHookEvent {
  session_id: string;
  hook_event_name: string;
  [key: string]: unknown;
}

export class HookHandler {
  private sessionStore: SessionStore;
  private pendingStore: PendingStore;
  private deviceStore: DeviceStore;
  private wsBus: WsBus;
  private pushService: PushService | null;
  private mode: GatewayMode = 'bystander';
  private takeoverOwner: string | null = null;
  private eventLogger: EventLogger | null;
  private _seq = 0;
  private eventHistory: { sessionId: string; event: SSEHookEvent }[] = [];
  private historyHead = 0;
  private maxHistory = 200;
  private historyCache: { sessionId: string; event: SSEHookEvent }[] | null = null;

  private broadcastAll(msg: GatewayMessage): void {
    this.wsBus.broadcast(msg);
  }

  constructor(
    sessionStore: SessionStore,
    pendingStore: PendingStore,
    deviceStore: DeviceStore,
    wsBus: WsBus,
    eventLogger?: EventLogger,
    pushService?: PushService,
  ) {
    this.sessionStore = sessionStore;
    this.pendingStore = pendingStore;
    this.deviceStore = deviceStore;
    this.wsBus = wsBus;
    this.eventLogger = eventLogger ?? null;
    this.pushService = pushService ?? null;

    if (this.eventLogger) {
      const recent = this.eventLogger.loadRecentEvents(this.maxHistory);
      for (const entry of recent) {
        this.eventHistory.push({ sessionId: entry.sessionId, event: entry.event });
        const seq = entry.seq;
        if (seq > this._seq) this._seq = seq;

        this.sessionStore.register(entry.sessionId);

        const eventName = entry.event.event_name as string | undefined;
        if (eventName === 'SessionEnd') {
          this.sessionStore.unregister(entry.sessionId);
        }
      }
    }
  }

  async handleEvent(body: string): Promise<InteractionResponse> {
    let event: RawHookEvent;
    try {
      event = JSON.parse(body) as RawHookEvent;
    } catch {
      throw new HttpError('Invalid JSON body', 400);
    }

    const sessionId = event.session_id;
    if (!sessionId || typeof sessionId !== 'string') {
      throw new HttpError('Missing or invalid session_id', 400);
    }

    const eventName = event.hook_event_name;

    const isNewSession = !this.sessionStore.has(sessionId);
    const sessionInfo = this.sessionStore.register(sessionId);

    const seq = ++this._seq;
    const eventId = seq.toString(36);
    const hookEvent: SSEHookEvent = { ...event, event_name: eventName, event_id: eventId };

    if (this.eventHistory.length >= this.maxHistory) {
      this.eventHistory[this.historyHead] = { sessionId, event: hookEvent };
      this.historyHead = (this.historyHead + 1) % this.maxHistory;
    } else {
      this.eventHistory.push({ sessionId, event: hookEvent });
    }
    this.historyCache = null;

    this.eventLogger?.log(sessionId, hookEvent, seq);

    if (isNewSession) {
      this.broadcastAll({ type: 'session_start', session: sessionInfo });
    }

    this.broadcastAll({ type: 'event', sessionId, event: hookEvent });

    if (this.mode === 'takeover' && (isUserInteractionEvent(eventName) || isInteractivePreToolUse(eventName, hookEvent))) {
      this.trySendPush(sessionId, eventId, eventName, hookEvent);

      return this.pendingStore.waitForResponse(sessionId, eventId, hookEvent);
    }

    if (eventName === 'SessionEnd') {
      this.deleteSession(sessionId);
      return {};
    }

    return {};
  }

  deleteSession(sessionId: string): void {
    this.broadcastAll({ type: 'session_end', sessionId });
    this.sessionStore.unregister(sessionId);
    this.pendingStore.releaseSession(sessionId);
  }

  setMode(mode: GatewayMode, deviceId?: string): void {
    if (this.mode === mode && this.takeoverOwner === deviceId) return;
    if (this.mode === 'takeover' && (mode === 'bystander' || (mode === 'takeover' && this.takeoverOwner !== deviceId))) {
      this.pendingStore.releaseAll();
      this.takeoverOwner = null;
    }
    if (mode === 'takeover') {
      this.takeoverOwner = deviceId ?? null;
    }
    this.mode = mode;
    this.broadcastAll({ type: 'mode_changed', mode, takeoverOwner: this.takeoverOwner ?? undefined });
  }

  getMode(): GatewayMode {
    return this.mode;
  }

  getTakeoverOwner(): string | null {
    return this.takeoverOwner;
  }

  getEventHistory(): { sessionId: string; event: SSEHookEvent }[] {
    if (this.historyCache) return this.historyCache;
    if (this.eventHistory.length < this.maxHistory) {
      return this.eventHistory;
    }
    this.historyCache = [
      ...this.eventHistory.slice(this.historyHead),
      ...this.eventHistory.slice(0, this.historyHead),
    ];
    return this.historyCache;
  }

  getPendingInteractions(): { sessionId: string; eventId: string; event: SSEHookEvent }[] {
    return this.pendingStore.getPending();
  }

  private static readonly PUSH_THROTTLE_MS = 5000;
  private lastPushAt = 0;

  private trySendPush(sessionId: string, eventId: string, eventName: string, event: SSEHookEvent): void {
    if (!this.pushService) return;

    const takeoverDevice = this.deviceStore.getTakeoverIOSDevice(this.takeoverOwner);
    if (!takeoverDevice?.pushToken || takeoverDevice.connected) return;

    const now = Date.now();
    if (now - this.lastPushAt < HookHandler.PUSH_THROTTLE_MS) return;
    this.lastPushAt = now;

    this.pushService.sendPush(takeoverDevice.pushToken, {
      sessionId,
      eventId,
      eventName: eventName as HookEventName,
      toolName: event.tool_name as string | undefined,
    }).catch((err) => {
      console.error('[Push] send failed:', err instanceof Error ? err.message : err);
    });
  }
}
