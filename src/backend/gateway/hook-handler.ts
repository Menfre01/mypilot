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
import type { SessionStreamManager } from './session-stream-manager.js';
import type { SessionMessage } from '../../shared/protocol.js';

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
  private mode: GatewayMode;
  private takeoverOwner: string | null;
  private eventLogger: EventLogger | null;
  private streamManager: SessionStreamManager | null = null;
  private eventHistory: { sessionId: string; event: SSEHookEvent }[] = [];
  private historyHead = 0;
  private maxHistory = 200;
  private historyCache: { sessionId: string; event: SSEHookEvent }[] | null = null;
  private onStateChange?: () => void;

  // Serialize handleEvent calls so seq assignment is strictly ordered across
  // concurrent HTTP requests. When uncontended, proceeds synchronously (no
  // microtask yield, important for test determinism). Uses a queue of resolvers
  // to handle any number of concurrent callers without lost wakeups.
  private _processing = false;
  private _nextResolvers: (() => void)[] = [];

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
    initialState?: { mode: GatewayMode; takeoverOwner: string | null },
    onStateChange?: () => void,
  ) {
    this.sessionStore = sessionStore;
    this.pendingStore = pendingStore;
    this.deviceStore = deviceStore;
    this.wsBus = wsBus;
    this.eventLogger = eventLogger ?? null;
    this.pushService = pushService ?? null;
    this.mode = initialState?.mode ?? 'bystander';
    this.takeoverOwner = initialState?.takeoverOwner ?? null;
    this.onStateChange = onStateChange;

    if (this.eventLogger) {
      const recent = this.eventLogger.loadRecentEvents(this.maxHistory);
      for (const entry of recent) {
        this.eventHistory.push({ sessionId: entry.sessionId, event: entry.event });

        this.sessionStore.register(entry.sessionId);

        const eventName = entry.event.event_name as string | undefined;
        if (eventName === 'SessionEnd') {
          this.sessionStore.unregister(entry.sessionId);
        }
      }
    }
  }

  async handleEvent(body: string): Promise<InteractionResponse> {
    if (this._processing) {
      await new Promise<void>((r) => { this._nextResolvers.push(r); });
    }
    this._processing = true;

    try {
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

      this._registerAndBroadcastNewSession(sessionId);

      const seq = this.streamManager?.nextSeqFn() ?? 0;
      const eventId = seq.toString(36);

      const transcriptPath = event.transcript_path as string | undefined;

      const hookEvent: SSEHookEvent = {
        ...event,
        event_name: eventName,
        event_id: eventId,
        timestamp: Date.now(),
      };

      this.pushToHistory(sessionId, hookEvent);
      this.eventLogger?.log(sessionId, hookEvent, seq);

      const sessionMsg: SessionMessage = {
        sessionId,
        seq,
        timestamp: hookEvent.timestamp as number,
        source: 'hook',
        event: hookEvent,
      };

      if (this.streamManager) {
        if (!this.streamManager.push(sessionMsg)) {
          throw new HttpError('Service Unavailable — pipeline backpressured', 503);
        }
      }

      // 任意携带 transcript_path 的事件幂等启动 tailer，SessionEnd 回收
      if (transcriptPath) {
        this.streamManager?.startSession(sessionId, transcriptPath);
      }
      if (eventName === 'SessionEnd') {
        this.streamManager?.stopSession(sessionId);
      }

      // 子代理 transcript（agent_transcript_path + agent_id）
      // SubagentStop 事件携带 agent_transcript_path，用于启动子代理 tailer
      const agentTranscriptPath = event.agent_transcript_path as string | undefined;
      const agentId = event.agent_id as string | undefined;
      if (agentTranscriptPath && agentId) {
        this._registerAndBroadcastNewSession(agentId);
        this.streamManager?.startSession(agentId, agentTranscriptPath);
      }

      if (this.mode === 'takeover' && (isUserInteractionEvent(eventName) || isInteractivePreToolUse(eventName, hookEvent))) {
        this.trySendPush(sessionId, eventId, eventName, hookEvent);

        return this.pendingStore.waitForResponse(sessionId, eventId, hookEvent);
      }

      if (eventName === 'SessionEnd') {
        this.deleteSession(sessionId);
        return {};
      }

      return {};
    } finally {
      this._processing = false;
      const resolvers = this._nextResolvers;
      this._nextResolvers = [];
      for (const r of resolvers) r();
    }
  }

  private _registerAndBroadcastNewSession(sessionId: string): void {
    const isNew = !this.sessionStore.has(sessionId);
    const info = this.sessionStore.register(sessionId);
    if (isNew) {
      this.broadcastAll({ type: 'session_start', session: info });
    }
  }

  private pushToHistory(sessionId: string, event: SSEHookEvent): void {
    if (this.eventHistory.length >= this.maxHistory) {
      this.eventHistory[this.historyHead] = { sessionId, event };
      this.historyHead = (this.historyHead + 1) % this.maxHistory;
    } else {
      this.eventHistory.push({ sessionId, event });
    }
    this.historyCache = null;
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
    this.onStateChange?.();
  }

  getMode(): GatewayMode {
    return this.mode;
  }

  setStreamManager(sm: SessionStreamManager): void {
    this.streamManager = sm;
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

  private static readonly DEDUP_WINDOW_MS = 2000;
  private static readonly STALE_THRESHOLD_MS = 20_000;
  private recentPushes = new Map<string, number>();

  private trySendPush(sessionId: string, eventId: string, eventName: string, event: SSEHookEvent): void {
    if (!this.pushService) {
      console.log('[Push] skip: pushService not configured');
      return;
    }

    const takeoverDevice = this.deviceStore.getTakeoverIOSDevice(this.takeoverOwner);
    if (!takeoverDevice) {
      console.log('[Push] skip: no takeover iOS device (owner=%s)', this.takeoverOwner);
      return;
    }
    if (!takeoverDevice.pushToken) {
      console.log('[Push] skip: device %s has no pushToken', takeoverDevice.deviceId);
      return;
    }
    if (takeoverDevice.connected) {
      const inactiveMs = Date.now() - takeoverDevice.lastSeen;
      if (inactiveMs < HookHandler.STALE_THRESHOLD_MS) {
        console.log('[Push] skip: device %s still connected (%dms inactive), assuming WS delivery', takeoverDevice.deviceId, inactiveMs);
        return;
      }
      console.log('[Push] device %s connected but stale (%dms inactive), sending push anyway', takeoverDevice.deviceId, inactiveMs);
    }

    if (!this.pushService.isAvailable()) {
      console.log('[Push] skip: push service unavailable');
      return;
    }

    const now = Date.now();
    const dedupKey = `${eventName}:${event.tool_name ?? ''}`;
    const last = this.recentPushes.get(dedupKey);
    if (last !== undefined && now - last < HookHandler.DEDUP_WINDOW_MS) {
      console.log('[Push] skip: dedup %s (%dms ago)', dedupKey, now - last);
      return;
    }
    this.recentPushes.set(dedupKey, now);
    // Clean stale entries
    if (this.recentPushes.size > 20) {
      for (const [k, t] of this.recentPushes) {
        if (now - t > HookHandler.DEDUP_WINDOW_MS * 2) this.recentPushes.delete(k);
      }
    }

    console.log('[Push] sending push to device %s for event %s/%s', takeoverDevice.deviceId, eventName, eventId);
    this.pushService.sendPush(takeoverDevice.pushToken, {
      sessionId,
      eventId,
      eventName: eventName as HookEventName,
      toolName: event.tool_name as string | undefined,
      content: extractContent(event.tool_input),
      locale: takeoverDevice.locale,
      environment: takeoverDevice.pushEnvironment,
    }).then((result) => {
      if (!result.ok) {
        console.error('[Push] relay returned failure');
        if (result.reason === 'unregistered') {
          console.log('[Push] device token unregistered, clearing pushToken for device %s', takeoverDevice.deviceId);
          if (this.deviceStore.clearPushToken(takeoverDevice.deviceId)) {
            this.onStateChange?.();
          }
        }
      }
    }).catch((err) => {
      console.error('[Push] send failed:', err instanceof Error ? err.message : err);
    });
  }
}

function extractContent(toolInput: unknown): string | undefined {
  if (!toolInput || typeof toolInput !== 'object') return undefined;
  const input = toolInput as Record<string, unknown>;

  for (const key of ['command', 'file_path', 'description', 'url', 'query']) {
    const val = input[key];
    if (typeof val === 'string') return val;
  }
  return undefined;
}
