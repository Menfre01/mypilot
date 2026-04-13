import { WebSocketServer, WebSocket } from 'ws';
import type { Server, IncomingMessage } from 'node:http';
import type { GatewayMessage, ClientMessage, SessionInfo, GatewayMode, PendingInteraction } from '../../shared/protocol.js';

export type MessageHandler = (message: ClientMessage) => void;
export type DisconnectHandler = () => void;
export type ConnectHandler = (url: URL) => void;

const HEARTBEAT_INTERVAL_MS = 30_000;
const MAX_OFFLINE_QUEUE = 200;

export class WsBus {
  private wss: WebSocketServer | null = null;
  private client: WebSocket | null = null;
  private messageHandlers: MessageHandler[] = [];
  private disconnectHandlers: DisconnectHandler[] = [];
  private connectHandlers: ConnectHandler[] = [];
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private offlineQueue: string[] = [];
  private aliveSockets = new WeakSet<WebSocket>();

  attach(httpServer: Server, token: string): void {
    this.wss = new WebSocketServer({
      server: httpServer,
      path: '/ws-gateway',
      verifyClient: (info: { req: IncomingMessage }, callback: (res: boolean) => void) => {
        const url = new URL(info.req.url ?? '/', `http://localhost`);
        const clientToken = url.searchParams.get('token');
        callback(clientToken === token);
      },
    });

    this.wss.on('connection', (ws, req) => {
      // Single client model: replace existing client
      if (this.client) {
        this.client.close();
      }
      this.client = ws;

      this._startHeartbeat(ws);

      const connUrl = new URL(req.url ?? '/', `http://localhost`);

      // Don't flush offline queue here — sendSessionList (called by connect
      // handlers) delivers recentEvents which is a superset, and clears the
      // queue itself. Flushing first would cause duplicates.
      for (const handler of this.connectHandlers) {
        handler(connUrl);
      }

      ws.on('message', (data) => {
        try {
          const message = JSON.parse(data.toString()) as ClientMessage;
          for (const handler of this.messageHandlers) {
            handler(message);
          }
        } catch {
          // Ignore malformed messages
        }
      });

      ws.on('close', () => {
        if (this.client === ws) {
          this.client = null;
          this._stopHeartbeat();
          for (const handler of this.disconnectHandlers) {
            handler();
          }
        }
      });

      ws.on('pong', () => {
        this.aliveSockets.add(ws);
      });
    });
  }

  broadcast(message: GatewayMessage): void {
    const raw = JSON.stringify(message);
    if (this.client && this.client.readyState === WebSocket.OPEN) {
      this._send(this.client, raw);
    } else {
      // Queue for offline delivery
      if (this.offlineQueue.length < MAX_OFFLINE_QUEUE) {
        this.offlineQueue.push(raw);
      }
    }
  }

  sendSessionList(
    sessions: SessionInfo[],
    mode: GatewayMode,
    recentEvents: { sessionId: string; event: import('../../shared/protocol.js').SSEHookEvent }[] = [],
    pendingInteractions: PendingInteraction[] = [],
  ): void {
    // Clear offline queue — recentEvents is a superset and will be delivered
    // in the same 'connected' message, so flushing would cause duplicates.
    this.offlineQueue = [];
    this.broadcast({
      type: 'connected',
      sessions,
      mode,
      recentEvents,
      pendingInteractions,
    });
  }

  onMessage(handler: MessageHandler): void {
    this.messageHandlers.push(handler);
  }

  onDisconnect(handler: DisconnectHandler): void {
    this.disconnectHandlers.push(handler);
  }

  onConnect(handler: ConnectHandler): void {
    this.connectHandlers.push(handler);
  }

  disconnect(): void {
    if (this.client) {
      this.client.close();
      this.client = null;
    }
    this._stopHeartbeat();
  }

  close(): void {
    if (this.client) {
      this.client.close();
      this.client = null;
    }
    this._stopHeartbeat();
    if (this.wss) {
      this.wss.close();
      this.wss = null;
    }
  }

  hasClient(): boolean {
    return this.client !== null && this.client.readyState === WebSocket.OPEN;
  }

  // ── Heartbeat ──

  private _startHeartbeat(ws: WebSocket): void {
    this._stopHeartbeat();
    this.aliveSockets.add(ws);
    this.heartbeatTimer = setInterval(() => {
      if (this.client !== ws) {
        this._stopHeartbeat();
        return;
      }
      if (!this.aliveSockets.has(ws)) {
        // No pong received — terminate dead connection
        ws.terminate();
        return;
      }
      this.aliveSockets.delete(ws);
      if (ws.readyState === WebSocket.OPEN) {
        ws.ping();
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  private _stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  // ── Send with error handling ──

  private _send(ws: WebSocket, raw: string): void {
    try {
      ws.send(raw);
    } catch {
      // Send failed — connection likely broken, will be cleaned up by heartbeat/close handler
    }
  }

  // ── Offline queue ──

  private _flushQueue(ws: WebSocket): void {
    const queue = this.offlineQueue;
    this.offlineQueue = [];
    for (const raw of queue) {
      this._send(ws, raw);
    }
  }
}
