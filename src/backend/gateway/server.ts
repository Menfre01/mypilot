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
import type { ClientMessage, GatewayMessage } from '../../shared/protocol.js';

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

  function broadcastSessionState(lastEventSeq?: number, targetDeviceId?: string, cachedEvents?: ReturnType<typeof getRecentEvents>): void {
    const recentEvents = cachedEvents ?? getRecentEvents(lastEventSeq);
    const pendingInteractions = hookHandler.getPendingInteractions();

    const pendingIds = new Set(pendingInteractions.map(p => p.eventId));
    const dedupedEvents = pendingIds.size > 0
      ? recentEvents.filter(e => !pendingIds.has(String(e.event.event_id ?? '')))
      : recentEvents;

    const msg: GatewayMessage = {
      type: 'connected',
      sessions: sessionStore.getAll(),
      mode: hookHandler.getMode(),
      recentEvents: dedupedEvents,
      pendingInteractions,
      takeoverOwner: hookHandler.getTakeoverOwner() ?? undefined,
    };
    wsBus.sendSessionList(msg.sessions, msg.mode, msg.recentEvents, msg.pendingInteractions, targetDeviceId, msg.takeoverOwner);
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
      case 'delete_session':
        hookHandler.deleteSession(message.sessionId);
        break;
      case 'register_device':
        deviceStore.register(deviceId, message.platform, message.locale);
        break;
      case 'register_push':
        if (deviceStore.setPushToken(deviceId, message.deviceToken)) {
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

      return new Promise((resolve) => {
        httpServer.listen(port, resolve);
      });
    },

    async stop(): Promise<void> {
      pendingStore.releaseAll();
      wsBus.close();
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
