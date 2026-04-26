import { WebSocketServer, WebSocket } from 'ws';
import type { Server, IncomingMessage } from 'node:http';
import type { GatewayConnected, GatewayMessage, ClientMessage, EncryptedEnvelope } from '../../shared/protocol.js';
import { encrypt, decrypt } from './crypto.js';

export type MessageHandler = (message: ClientMessage, deviceId: string) => void;
export type DisconnectHandler = (deviceId: string) => void;
export type ConnectHandler = (url: URL, deviceId: string) => void;

const HEARTBEAT_INTERVAL_MS = 30_000;
const MAX_OFFLINE_QUEUE = 200;

export class WsBus {
  private wss: WebSocketServer | null = null;
  private clients = new Map<string, WebSocket>();
  private key: Buffer;
  private messageHandlers: MessageHandler[] = [];
  private disconnectHandlers: DisconnectHandler[] = [];
  private connectHandlers: ConnectHandler[] = [];
  private heartbeatTimers = new Map<string, ReturnType<typeof setInterval>>();
  private perClientOfflineQueue = new Map<string, string[]>();
  private aliveSockets = new Map<WebSocket, boolean>();
  private autoIdCounter = 0;

  constructor(key: Buffer) {
    this.key = key;
  }

  attach(httpServer: Server): void {
    const keyB64 = this.key.toString('base64');
    this.wss = new WebSocketServer({
      server: httpServer,
      path: '/ws-gateway',
      verifyClient: (info: { req: IncomingMessage }, callback: (res: boolean) => void) => {
        const url = new URL(info.req.url ?? '/', `http://localhost`);
        const clientKey = url.searchParams.get('key');
        callback(clientKey === keyB64);
      },
    });

    this.wss.on('connection', (ws, req) => {
      const connUrl = new URL(req.url ?? '/', `http://localhost`);

      // Resolve deviceId — auto-generate if not provided (backward compat)
      let deviceId = connUrl.searchParams.get('deviceId') ?? '';
      if (!deviceId) {
        deviceId = `_auto_${++this.autoIdCounter}_${Date.now().toString(36)}`;
      }

      // Same deviceId reconnect: replace old connection
      const existing = this.clients.get(deviceId);
      if (existing && existing !== ws) {
        existing.close();
        this.aliveSockets.delete(existing);
      }

      this.clients.set(deviceId, ws);
      this._startHeartbeat(deviceId, ws);
      this.perClientOfflineQueue.set(deviceId, []);

      for (const handler of this.connectHandlers) {
        handler(connUrl, deviceId);
      }

      ws.on('message', (data) => {
        try {
          const raw = data.toString();
          const message: ClientMessage = JSON.parse(decrypt(this.key, JSON.parse(raw) as EncryptedEnvelope));
          for (const handler of this.messageHandlers) {
            handler(message, deviceId);
          }
        } catch {
          // malformed or unauthenticated — ignore
        }
      });

      ws.on('close', () => {
        if (this.clients.get(deviceId) === ws) {
          this._cleanupDevice(deviceId, ws);
          for (const handler of this.disconnectHandlers) {
            handler(deviceId);
          }
        }
      });

      ws.on('pong', () => {
        this.aliveSockets.set(ws, true);
      });
    });
  }

  broadcast(message: GatewayMessage, targetDeviceId?: string): void {
    const raw = encrypt(this.key, JSON.stringify(message));

    if (targetDeviceId) {
      const ws = this.clients.get(targetDeviceId);
      if (ws && ws.readyState === WebSocket.OPEN) {
        this._send(ws, raw);
      } else {
        this._enqueueOffline(targetDeviceId, raw);
      }
      return;
    }

    for (const [deviceId, ws] of this.clients) {
      if (ws.readyState === WebSocket.OPEN) {
        this._send(ws, raw);
      } else {
        this._enqueueOffline(deviceId, raw);
      }
    }
  }

  sendSessionList(msg: GatewayConnected, targetDeviceId?: string): void {
    if (targetDeviceId) {
      this.perClientOfflineQueue.set(targetDeviceId, []);
    } else {
      this.perClientOfflineQueue.clear();
    }
    this.broadcast(msg, targetDeviceId);
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

  disconnect(deviceId?: string): void {
    if (deviceId) {
      const ws = this.clients.get(deviceId);
      if (ws) this._closeAndNotify(deviceId, ws);
    } else {
      const entries = Array.from(this.clients.entries());
      this.clients.clear();
      for (const [id, ws] of entries) this._closeAndNotify(id, ws);
    }
  }

  close(): Promise<void> {
    this.disconnect();
    if (!this.wss) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.wss!.close(() => {
        this.wss = null;
        resolve();
      });
    });
  }

  hasClient(deviceId?: string): boolean {
    if (deviceId) {
      const ws = this.clients.get(deviceId);
      return ws !== undefined && ws.readyState === WebSocket.OPEN;
    }
    for (const ws of this.clients.values()) {
      if (ws.readyState === WebSocket.OPEN) return true;
    }
    return false;
  }

  // ── Internal ──

  private _cleanupDevice(deviceId: string, ws: WebSocket): void {
    this.clients.delete(deviceId);
    this._stopHeartbeat(deviceId);
    this.aliveSockets.delete(ws);
    this.perClientOfflineQueue.delete(deviceId);
  }

  private _closeAndNotify(deviceId: string, ws: WebSocket): void {
    this._cleanupDevice(deviceId, ws);
    ws.close();
    for (const handler of this.disconnectHandlers) {
      handler(deviceId);
    }
  }

  // ── Heartbeat ──

  private _startHeartbeat(deviceId: string, ws: WebSocket): void {
    this._stopHeartbeat(deviceId);
    this.aliveSockets.set(ws, true);

    const timer = setInterval(() => {
      const currentWs = this.clients.get(deviceId);
      if (currentWs !== ws) {
        this._stopHeartbeat(deviceId);
        return;
      }
      if (!this.aliveSockets.get(ws)) {
        // No pong received — terminate dead connection
        ws.terminate();
        return;
      }
      this.aliveSockets.set(ws, false);
      if (ws.readyState === WebSocket.OPEN) {
        ws.ping();
      }
    }, HEARTBEAT_INTERVAL_MS);

    this.heartbeatTimers.set(deviceId, timer);
  }

  private _stopHeartbeat(deviceId: string): void {
    const timer = this.heartbeatTimers.get(deviceId);
    if (timer) {
      clearInterval(timer);
      this.heartbeatTimers.delete(deviceId);
    }
  }

  // ── Offline queue ──

  private _enqueueOffline(deviceId: string, raw: string): void {
    const queue = this.perClientOfflineQueue.get(deviceId);
    if (!queue) return;
    if (queue.length < MAX_OFFLINE_QUEUE) {
      queue.push(raw);
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

}
