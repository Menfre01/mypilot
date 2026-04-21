import { createServer as createHttpServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { SessionStore } from './session-store.js';
import { PendingStore } from './pending-store.js';
import { WsBus } from './ws-bus.js';
import { HookHandler, HttpError } from './hook-handler.js';
import { EventLogger } from './event-logger.js';
import { createRelayClient } from './relay-client.js';
import type { ClientMessage, GatewayMessage, LinkConfig } from '../../shared/protocol.js';
import { deriveKeyIdentifiers } from './key-hash.js';

export interface GatewayServer {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export function createServer(
  port: number,
  logDir: string,
  key: Buffer,
  cloudflareLink?: LinkConfig,
): GatewayServer {
  const sessionStore = new SessionStore();
  const pendingStore = new PendingStore();
  const wsBus = new WsBus(key);
  const eventLogger = new EventLogger(logDir);

  const relayClient = cloudflareLink ? createRelayClient() : null;
  const { gatewayId, keyHash } = deriveKeyIdentifiers(key);
  const keyB64 = key.toString('base64');
  const MAX_RECENT_EVENTS = 200;

  function getRecentEvents(lastEventSeq?: number) {
    return lastEventSeq != null
      ? eventLogger.readEventsAfter(lastEventSeq, MAX_RECENT_EVENTS)
      : hookHandler.getEventHistory();
  }

  const relayBroadcast = relayClient
    ? (msg: GatewayMessage) => relayClient.broadcast(msg)
    : undefined;

  const hookHandler = new HookHandler(
    sessionStore,
    pendingStore,
    wsBus,
    eventLogger,
    relayBroadcast,
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
    // With checkpoint: only events after it (may be empty if up-to-date).
    // Without checkpoint (fresh install): full in-memory history.
    const recentEvents = cachedEvents ?? getRecentEvents(lastEventSeq);
    const msg: GatewayMessage = {
      type: 'connected',
      sessions: sessionStore.getAll(),
      mode: hookHandler.getMode(),
      recentEvents,
      pendingInteractions: hookHandler.getPendingInteractions(),
      takeoverOwner: hookHandler.getTakeoverOwner() ?? undefined,
    };
    wsBus.sendSessionList(msg.sessions, msg.mode, msg.recentEvents, msg.pendingInteractions, targetDeviceId, msg.takeoverOwner);
    if (relayClient) {
      relayClient.broadcast(msg);
    }
  }

  function handleClientMessage(message: ClientMessage, deviceId: string): void {
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
        pendingStore.resolve(message.sessionId, message.eventId, message.response);
        break;
      case 'request_sessions': {
        broadcastSessionState(message.lastEventSeq, deviceId);
        break;
      }
      case 'delete_session':
        hookHandler.deleteSession(message.sessionId);
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
        // Read lastEventSeq from WS URL to send correct events in one shot.
        const seqParam = url.searchParams.get('lastEventSeq');
        const lastEventSeq = seqParam != null ? Number(seqParam) : undefined;
        broadcastSessionState(
          Number.isFinite(lastEventSeq) ? lastEventSeq : undefined,
          deviceId,
        );
      });

      if (relayClient) {
        relayClient.onMessage(handleClientMessage);
        await relayClient.connect(cloudflareLink!.url, gatewayId, key);
      }

      return new Promise((resolve) => {
        httpServer.listen(port, resolve);
      });
    },

    async stop(): Promise<void> {
      pendingStore.releaseAll();
      relayClient?.disconnect();
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
