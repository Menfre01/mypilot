import type { ClientMessage, GatewayMessage, EncryptedEnvelope } from '../../shared/protocol.js';
import { encrypt, decrypt } from './crypto.js';

export interface RelayClient {
  connect(relayUrl: string, gatewayId: string, key: Buffer): Promise<void>;
  disconnect(): void;
  onMessage(handler: (msg: ClientMessage, deviceId: string) => void): void;
  broadcast(message: GatewayMessage): void;
}

const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
const MAX_RETRIES = 5;
const CONNECTION_TIMEOUT_MS = 10_000;
const WS_OPEN = 1;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type WsLike = { on(event: string, cb: (...args: any[]) => void): void; send(data: string): void; close(): void; readyState: number };
type WebSocketFactory = (url: string) => WsLike;

export function createRelayClient(wsFactory?: WebSocketFactory): RelayClient {
  const createSocket: WebSocketFactory = wsFactory ?? ((url: string) => new WebSocket(url) as unknown as WsLike);

  let ws: WsLike | null = null;
  let gatewayId = '';
  let key: Buffer = Buffer.alloc(0);
  let keyB64 = '';
  let relayUrl = '';
  let messageHandler: ((msg: ClientMessage, deviceId: string) => void) | null = null;
  let retryCount = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let intentionallyDisconnected = false;

  function scheduleReconnect(): void {
    if (intentionallyDisconnected || retryCount >= MAX_RETRIES) return;
    const delay = Math.min(RECONNECT_BASE_MS * Math.pow(2, retryCount), RECONNECT_MAX_MS);
    retryCount++;
    reconnectTimer = setTimeout(() => {
      if (!intentionallyDisconnected) {
        connectImpl().catch(() => {
          // reconnect scheduled again by close handler if not intentionally disconnected
        });
      }
    }, delay);
  }

  async function connectImpl(): Promise<void> {
    return new Promise((resolve, reject) => {
      const parsed = new URL(relayUrl);
      const url = new URL(`/relay?gatewayId=${encodeURIComponent(gatewayId)}&key=${keyB64}`, relayUrl);
      url.protocol = parsed.protocol === 'wss:' ? 'wss:' : 'ws:';

      const sock = createSocket(url.toString());
      let resolved = false;

      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          sock.close();
          reject(new Error('Connection timeout'));
        }
      }, CONNECTION_TIMEOUT_MS);

      sock.on('open', () => {
        resolved = true;
        clearTimeout(timeout);
        ws = sock;
        retryCount = 0;
        resolve();
      });

      sock.on('message', (data) => {
        let payload: unknown;
        try {
          payload = JSON.parse(data.toString());
        } catch {
          return;
        }

        const envelope = payload as { encrypted?: EncryptedEnvelope };
        if (!envelope || !envelope.encrypted) return;

        try {
          const plaintext = decrypt(key, envelope.encrypted);
          const clientMsg = JSON.parse(plaintext) as ClientMessage;
          if (messageHandler) {
            messageHandler(clientMsg, gatewayId);
          }
        } catch {
          // Bad envelope — ignore
        }
      });

      sock.on('close', () => {
        ws = null;
        if (!intentionallyDisconnected) {
          scheduleReconnect();
        }
      });

      sock.on('error', (err) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          reject(err);
        }
      });
    });
  }

  return {
    async connect(url: string, gwId: string, k: Buffer): Promise<void> {
      relayUrl = url;
      gatewayId = gwId;
      key = k;
      keyB64 = k.toString('base64');
      intentionallyDisconnected = false;
      retryCount = 0;
      return connectImpl();
    },

    disconnect(): void {
      intentionallyDisconnected = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (ws) {
        ws.close();
        ws = null;
      }
    },

    onMessage(handler: (msg: ClientMessage, deviceId: string) => void): void {
      messageHandler = handler;
    },

    broadcast(message: GatewayMessage): void {
      if (!ws || ws.readyState !== WS_OPEN) return;
      try {
        const encrypted = encrypt(key, JSON.stringify(message));
        ws.send(JSON.stringify({ encrypted: JSON.parse(encrypted) }));
      } catch {
        // Send failed — connection likely broken, will be cleaned up by close handler
      }
    },
  };
}
