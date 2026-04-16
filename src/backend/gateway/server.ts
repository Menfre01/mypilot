import { createServer as createHttpServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { SessionStore } from './session-store.js';
import { PendingStore } from './pending-store.js';
import { WsBus } from './ws-bus.js';
import { HookHandler, HttpError } from './hook-handler.js';
import { EventLogger } from './event-logger.js';
import type { ClientMessage } from '../../shared/protocol.js';

export interface GatewayServer {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export function createServer(port: number, logDir: string, key: Buffer): GatewayServer {
  const sessionStore = new SessionStore();
  const pendingStore = new PendingStore();
  const wsBus = new WsBus(key);
  const eventLogger = new EventLogger(logDir);
  const hookHandler = new HookHandler(sessionStore, pendingStore, wsBus, eventLogger);
  const keyB64 = key.toString('base64');

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

  function broadcastSessionState(lastEventSeq?: number, targetDeviceId?: string): void {
    // With checkpoint: only events after it (may be empty if up-to-date).
    // Without checkpoint (fresh install): full in-memory history.
    const recentEvents = lastEventSeq != null
      ? eventLogger.readEventsAfter(lastEventSeq, 200)
      : hookHandler.getEventHistory();

    wsBus.sendSessionList(
      sessionStore.getAll(),
      hookHandler.getMode(),
      recentEvents,
      hookHandler.getPendingInteractions(),
      targetDeviceId,
    );
  }

  function handleClientMessage(message: ClientMessage, deviceId: string): void {
    switch (message.type) {
      case 'takeover':
        hookHandler.setMode('takeover');
        break;
      case 'release':
        hookHandler.setMode('bystander');
        break;
      case 'interact':
        pendingStore.resolve(message.sessionId, message.eventId, message.response);
        break;
      case 'request_sessions':
        broadcastSessionState(message.lastEventSeq, deviceId);
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
