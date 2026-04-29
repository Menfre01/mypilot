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
  ModelFeedback,
} from '../../shared/protocol.js';
import { extractModelFeedback } from './model-feedback.js';

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
  private _seq = 0;
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
    if (this._processing) {
      await new Promise<void>((r) => { this._nextResolvers.push(r); });
    }
    this._processing = true;

    let deferredEnrich: {
      sessionId: string;
      eventId: string;
      transcriptPath: string;
      toolUseId: string;
      eventName: string;
      toolName: string | undefined;
    } | null = null;

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

      const isNewSession = !this.sessionStore.has(sessionId);
      const sessionInfo = this.sessionStore.register(sessionId);

      const seq = ++this._seq;
      const eventId = seq.toString(36);

      const transcriptPath = event.transcript_path as string | undefined;
      const toolUseId = event.tool_use_id as string | undefined;
      const agentId = event.agent_id as string | undefined;
      if (transcriptPath && toolUseId && !agentId && !HookHandler.NO_ENRICH_EVENTS.has(eventName as HookEventName)) {
        deferredEnrich = {
          sessionId,
          eventId,
          transcriptPath,
          toolUseId,
          eventName,
          toolName: event.tool_name as string | undefined,
        };
      } else if (transcriptPath) {
        console.log('[ModelFeedback] skip %s (no tool_use_id or in no-enrich list)', eventName);
      }

      const hookEvent: SSEHookEvent = {
        ...event,
        event_name: eventName,
        event_id: eventId,
        timestamp: Date.now(),
      };

      this.pushToHistory(sessionId, hookEvent);
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
    } finally {
      this._processing = false;
      const resolvers = this._nextResolvers;
      this._nextResolvers = [];
      for (const r of resolvers) r();
      if (deferredEnrich) {
        this.startEnrichment(deferredEnrich);
      }
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

  private updateEventInHistory(sessionId: string, eventId: string, modelFeedback: ModelFeedback): void {
    for (let i = 0; i < this.eventHistory.length; i++) {
      const entry = this.eventHistory[i];
      if (entry.sessionId === sessionId && entry.event.event_id === eventId) {
        entry.event.model_feedback = modelFeedback;
        this.historyCache = null;
        return;
      }
    }
  }

  private startEnrichment(params: {
    sessionId: string;
    eventId: string;
    transcriptPath: string;
    toolUseId: string;
    eventName: string;
    toolName: string | undefined;
  }): void {
    const { sessionId, eventId, transcriptPath, toolUseId, eventName, toolName } = params;

    // Fire-and-forget: enrichment must never block event processing.
    void (async () => {
      try {
        const fullFeedback = await extractModelFeedback(transcriptPath, toolUseId, { requireToolResult: eventName === 'PostToolUse' });
        if (!fullFeedback) return;

        // PostToolUse shares the same tool_use_id as PreToolUse;
        // only keep tool_result to avoid duplicate content on the client.
        const modelFeedback: ModelFeedback = eventName === 'PostToolUse'
          ? { model: fullFeedback.model, usage: fullFeedback.usage, tool_result: fullFeedback.tool_result }
          : fullFeedback;

        const hasContent = modelFeedback.thinking || modelFeedback.text || modelFeedback.tool_result;
        console.log(
          '[ModelFeedback] enriched %s/%s: model=%s tokens(in=%d out=%d)%s',
          eventName,
          toolName ?? '-',
          modelFeedback.model,
          modelFeedback.usage.input_tokens,
          modelFeedback.usage.output_tokens,
          hasContent ? ' +content' : '',
        );

        this.updateEventInHistory(sessionId, eventId, modelFeedback);

        this.broadcastAll({
          type: 'event_enrichment',
          sessionId,
          eventId,
          model_feedback: modelFeedback,
          tool_use_id: toolUseId,
        });
      } catch (err) {
        // Enrichment is best-effort — the event was already delivered.
        console.error(
          '[ModelFeedback] async enrichment failed: %s',
          err instanceof Error ? err.message : err,
        );
      }
    })();
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

  /** Events where transcript enrichment is skipped (no new LLM output to extract). */
  private static readonly NO_ENRICH_EVENTS: ReadonlySet<HookEventName> = new Set<HookEventName>([
    'SessionStart', 'SessionEnd', 'InstructionsLoaded', 'SubagentStart',
    'StopFailure', 'PermissionDenied', 'Notification', 'PreCompact',
    'PostCompact', 'CwdChanged', 'FileChanged', 'WorktreeRemove',
  ]);

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
