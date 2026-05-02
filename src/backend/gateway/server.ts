import { createServer as createHttpServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { SessionStore } from './session-store.js';
import { PendingStore } from './pending-store.js';
import { DeviceStore } from './device-store.js';
import { WsBus } from './ws-bus.js';
import { HookHandler, HttpError } from './hook-handler.js';
import { EventLogger } from './event-logger.js';
import { PushService } from './push-service.js';
import type { PushConfigFile } from './push-config.js';
import { loadGatewayState, saveGatewayState } from './gateway-state.js';
import { PROTOCOL_VERSION, type GatewayConnected, type ClientMessage } from '../../shared/protocol.js';
import { SessionStreamManager } from './session-stream-manager.js';

export type { PushConfigFile as PushConfig };

export interface GatewayServer {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export function createServer(
  port: number,
  logDir: string,
  pidDir: string,
  key: Buffer,
  pushConfig?: PushConfigFile,
): GatewayServer {
  const savedState = loadGatewayState(pidDir);

  const sessionStore = new SessionStore();
  const pendingStore = new PendingStore();
  const deviceStore = new DeviceStore(savedState?.devices);
  const wsBus = new WsBus(key);
  const eventLogger = new EventLogger(logDir);

  const keyB64 = key.toString('base64');
  const MAX_RECENT_EVENTS = 200;

  function getRecentEvents(lastEventSeq?: number) {
    return lastEventSeq != null
      ? eventLogger.readEventsAfter(lastEventSeq, MAX_RECENT_EVENTS)
      : hookHandler.getEventHistory();
  }

  function getRecentTranscriptEntries(lastEventSeq?: number) {
    const fromSeq = lastEventSeq ?? 0;
    const fromBuffer = sessionStreamManager.getAllTranscriptEntries()
      .filter(m => m.seq > fromSeq && m.entry)
      .slice(-MAX_RECENT_EVENTS)
      .map(m => ({ sessionId: m.sessionId, seq: m.seq, entry: m.entry! }));

    if (fromBuffer.length === 0) {
      if (lastEventSeq == null) return [];
      // 管道缓冲区已淘汰，回退磁盘
      return eventLogger.readTranscriptEntriesAfter(lastEventSeq, MAX_RECENT_EVENTS);
    }

    // 管道有数据，但可能不完整（部分条目已被 drain 消费），检查 gap
    if (lastEventSeq != null && lastEventSeq <= sessionStreamManager.maxDrainedSeq) {
      const minBufferedSeq = fromBuffer[0].seq;
      if (minBufferedSeq > lastEventSeq + 1) {
        const diskEntries = eventLogger.readTranscriptEntriesBetween(
          lastEventSeq, minBufferedSeq,
        );
        const merged = [...diskEntries, ...fromBuffer];
        return merged.slice(-MAX_RECENT_EVENTS);
      }
    }

    return fromBuffer;
  }

  const pushService = pushConfig
    ? new PushService(pushConfig.relayUrl, pushConfig.apiKey, pushConfig.gatewayId)
    : undefined;

  function persistState(): void {
    const devices = deviceStore.getAll()
      .filter(d => d.pushToken)
      .map(d => ({
        deviceId: d.deviceId,
        platform: d.platform,
        pushToken: d.pushToken,
        pushEnvironment: d.pushEnvironment,
        locale: d.locale,
      }));

    saveGatewayState(pidDir, {
      mode: hookHandler.getMode(),
      takeoverOwner: hookHandler.getTakeoverOwner(),
      devices,
    });
  }

  const hookHandler = new HookHandler(
    sessionStore,
    pendingStore,
    deviceStore,
    wsBus,
    eventLogger,
    pushService,
    savedState ? { mode: savedState.mode, takeoverOwner: savedState.takeoverOwner } : undefined,
    persistState,
  );

  const sessionStreamManager = new SessionStreamManager(eventLogger, wsBus, {
    isHidden: (id) => sessionStore.isHidden(id),
  });
  sessionStreamManager.recoverSeq(eventLogger);
  hookHandler.setStreamManager(sessionStreamManager);

  function drainPipeline(): void {
    const backlog = sessionStreamManager.bufferedCount;
    const batchSize = backlog > 300 ? 50 : backlog > 100 ? 30 : 20;
    const messages = sessionStreamManager.pull(batchSize);
    for (const msg of messages) {
      sessionStreamManager.broadcastMessage(msg);
      eventLogger.logSessionMessage(msg);
    }
  }

  sessionStreamManager.onDrain(drainPipeline);

  const SESSION_STALE_MS = 30 * 60_000;
  const staleCleanup = setInterval(cleanupStaleSessions, 60_000);

  let httpServer: Server;

  function collectBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => resolve(body));
      req.on('error', reject);
    });
  }

  const CORS_HEADERS: Record<string, string> = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };

  function sendJSON(res: ServerResponse, status: number, data: unknown): void {
    const body = JSON.stringify(data);
    res.writeHead(status, { 'Content-Type': 'application/json', ...CORS_HEADERS });
    res.end(body);
  }

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://localhost`);

    if (req.method === 'OPTIONS') {
      res.writeHead(204, CORS_HEADERS);
      res.end();
      return;
    }

    if (req.method === 'POST' && url.pathname === '/hook') {
      try {
        const body = await collectBody(req);
        const result = await hookHandler.handleEvent(body);
        sendJSON(res, 200, result);
      } catch (err) {
        const status = err instanceof HttpError ? err.status : 500;
        const message = err instanceof Error ? err.message : 'Unknown error';
        sendJSON(res, status, { error: message });
      }
      return;
    }

    if (req.method === 'GET' && url.pathname === '/pair') {
      const pairKey = url.searchParams.get('key');
      if (!pairKey || pairKey !== keyB64) {
        sendJSON(res, 403, { error: 'Invalid key' });
        return;
      }
      sendJSON(res, 200, { ok: true, host: url.hostname, port });
      return;
    }

    res.writeHead(404, CORS_HEADERS);
    res.end('Not Found');
  }

  function cleanupStaleSessions(): void {
    const staleIds = sessionStore.getStaleIds(SESSION_STALE_MS);
    for (const id of staleIds) {
      console.log('[Session] cleaning up stale session %s (inactive > %d min)', id, SESSION_STALE_MS / 60_000);
      hookHandler.deleteSession(id);
    }
  }

  function broadcastSessionState(lastEventSeq?: number, targetDeviceId?: string, cachedEvents?: ReturnType<typeof getRecentEvents>): void {
    const recentEvents = cachedEvents ?? getRecentEvents(lastEventSeq);
    const pendingInteractions = hookHandler.getPendingInteractions();
    const transcriptEntries = getRecentTranscriptEntries(lastEventSeq);

    const pendingIds = new Set(pendingInteractions.map(p => p.eventId));
    const dedupedEvents = pendingIds.size > 0
      ? recentEvents.filter(e => !pendingIds.has(String(e.event.event_id ?? '')))
      : recentEvents;

    const msg: GatewayConnected = {
      type: 'connected',
      protocolVersion: PROTOCOL_VERSION,
      sessions: sessionStore.getAll(),
      mode: hookHandler.getMode(),
      recentEvents: dedupedEvents,
      pendingInteractions,
      takeoverOwner: hookHandler.getTakeoverOwner() ?? undefined,
      transcriptEntries: transcriptEntries.length > 0 ? transcriptEntries : undefined,
    };
    wsBus.sendSessionList(msg, targetDeviceId);
  }

  function handleClientMessage(message: ClientMessage, deviceId: string): void {
    deviceStore.touch(deviceId);

    switch (message.type) {
      case 'takeover':
        hookHandler.setMode('takeover', deviceId);
        break;
      case 'release':
        if (hookHandler.getTakeoverOwner() === deviceId) {
          hookHandler.setMode('bystander');
        }
        break;
      case 'interact':
        console.log('[Interact] device=%s session=%s event=%s response=%s',
          deviceId, message.sessionId, message.eventId,
          JSON.stringify(message.response).slice(0, 80));
        pendingStore.resolve(message.sessionId, message.eventId, message.response);
        break;
      case 'request_sessions': {
        broadcastSessionState(message.lastEventSeq, deviceId);
        break;
      }
      case 'subscribe_session':
        void sessionStreamManager.replayHistory(
          message.sessionId, message.fromSeq, deviceId,
        );
        break;
      case 'delete_session':
        hookHandler.deleteSession(message.sessionId);
        break;
      case 'register_device':
        console.log('[Device] register_device id=%s platform=%s locale=%s', deviceId, message.platform, message.locale ?? '-');
        deviceStore.register(deviceId, message.platform, message.locale);
        break;
      case 'register_push':
        console.log('[Device] register_push id=%s token=%s*** env=%s', deviceId, message.deviceToken.slice(0, 8), message.environment ?? 'undefined');
        if (deviceStore.setPushToken(deviceId, message.deviceToken, message.environment)) {
          persistState();
        }
        break;
      case 'disconnect':
        deviceStore.setConnected(deviceId, false);
        wsBus.disconnect(deviceId);
        break;
    }
  }

  return {
    async start(): Promise<void> {
      httpServer = createHttpServer();
      httpServer.on('request', handleRequest);

      wsBus.attach(httpServer);
      wsBus.onMessage(handleClientMessage);
      wsBus.onConnect((url, deviceId) => {
        deviceStore.setConnected(deviceId, true);
        const seqParam = url.searchParams.get('lastEventSeq');
        const lastEventSeq = seqParam != null ? Number(seqParam) : undefined;
        broadcastSessionState(
          Number.isFinite(lastEventSeq) ? lastEventSeq : undefined,
          deviceId,
        );
      });
      wsBus.onDisconnect((deviceId) => {
        deviceStore.setConnected(deviceId, false);
      });

      return new Promise((resolve, reject) => {
        httpServer.on("error", reject);
        httpServer.listen(port, resolve);
      });
    },

    async stop(): Promise<void> {
      clearInterval(staleCleanup);
      sessionStreamManager.shutdown();
      pendingStore.releaseAll();
      await wsBus.close();
      return new Promise((resolve) => {
        if (httpServer) {
          httpServer.close(() => resolve());
        } else {
          resolve();
        }
      });
    },
  };
}
