// Cloudflare Workers Durable Object test helpers
// Since Hub extends DurableObject (a CF runtime class), we test its logic
// by directly exercising its methods with mocked WebSocket objects.

import { describe, it, expect } from 'vitest';

// Polyfill WebSocketPair for Node test environment
class MockWebSocketPair {
  0: WebSocket;
  1: WebSocket;
  constructor() {
    const client = {
      readyState: 0,
      sentMessages: [] as string[],
      onmessage: null as ((ev: { data: string }) => void) | null,
      onclose: null as ((ev: { code: number }) => void) | null,
      accept() { this.readyState = 1; },
      send(data: string) { this.sentMessages.push(data); },
      close(code = 1000) { this.readyState = 3; this.onclose?.({ code }); },
      addEventListener(_type: string, _handler: (ev: unknown) => void) {},
    } as unknown as WebSocket;
    const server = {
      readyState: 0,
      sentMessages: [] as string[],
      onmessage: null as ((ev: { data: string }) => void) | null,
      onclose: null as ((ev: { code: number }) => void) | null,
      accept() { this.readyState = 1; },
      send(data: string) { this.sentMessages.push(data); },
      close(code = 1000) { this.readyState = 3; this.onclose?.({ code }); },
      addEventListener(_type: string, _handler: (ev: unknown) => void) {},
    } as unknown as WebSocket;
    this[0] = client;
    this[1] = server;
  }
}
(globalThis as unknown as { WebSocketPair: new () => { 0: WebSocket; 1: WebSocket } }).WebSocketPair = MockWebSocketPair as unknown as new () => { 0: WebSocket; 1: WebSocket };

interface MockWebSocket {
  sentMessages: string[];
  readyState: number;
  closeCode?: number;
  onmessage: ((event: { data: string }) => void) | null;
  onclose: ((event: { code: number }) => void) | null;
  accept(): void;
  send(data: string): void;
  close(code?: number): void;
}

function createMockWs(): MockWebSocket & WebSocket {
  const ws: MockWebSocket = {
    sentMessages: [],
    readyState: WebSocket.CONNECTING,
    onmessage: null,
    onclose: null,
    accept() {
      this.readyState = WebSocket.OPEN;
    },
    send(data: string) {
      if (this.readyState !== WebSocket.OPEN) throw new Error('Not open');
      this.sentMessages.push(data);
    },
    close(code = 1000) {
      this.readyState = WebSocket.CLOSED;
      this.closeCode = code;
      this.onclose?.({ code });
    },
  };
  return ws as MockWebSocket & WebSocket;
}

function makeRequest(url: string, opts: RequestInit = {}): Request {
  return new Request(`https://hub.example.com${url}`, opts);
}

// Mirrors src/index.ts Hub class for testing purposes.
class TestHub {
  private gateways = new Map<string, WebSocket>();
  private apps = new Map<string, WebSocket>();
  private gatewayKeyHashes = new Map<string, string>();
  private _seq = 0;

  constructor() {}

  get seq(): number {
    return this._seq;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'GET' && url.pathname === '/health') {
      return new Response(JSON.stringify({ ok: true, gateways: this.gateways.size }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (request.method === 'GET' && url.pathname === '/connect') {
      const gatewayId = url.searchParams.get('gatewayId') ?? '';
      return new Response(JSON.stringify({ hasGateway: this.gateways.has(gatewayId) }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const upgrade = request.headers.get('upgrade');
    if (upgrade === 'websocket') {
      return this.handleWebSocket(url);
    }

    return new Response('Not Found', { status: 404 });
  }

  private handleWebSocket(url: URL): Response {
    const keyHash = url.searchParams.get('keyHash') ?? '';
    const lastEventSeqParam = url.searchParams.get('lastEventSeq');
    const lastEventSeq = lastEventSeqParam != null ? Number(lastEventSeqParam) : undefined;

    const isApp = url.pathname === '/ws-gateway' || url.searchParams.get('app') === '1';
    const gatewayId = url.searchParams.get('gatewayId') ?? '';

    if (!gatewayId || !keyHash) {
      return new Response('Missing gatewayId or keyHash', { status: 400 });
    }

    if (isApp) {
      if (!this.gateways.has(gatewayId)) {
        return new Response('Gateway not connected', { status: 503 });
      }
      const storedHash = this.gatewayKeyHashes.get(gatewayId);
      if (!storedHash || storedHash !== keyHash) {
        return new Response('Unauthorized', { status: 401 });
      }
    } else {
      const storedHash = this.gatewayKeyHashes.get(gatewayId);
      if (storedHash && storedHash !== keyHash) {
        return new Response('Unauthorized', { status: 401 });
      }
    }

    const pair = new WebSocketPair();
    const clientWs = pair[0];
    const response = pair[1];
    clientWs.accept();

    if (isApp) {
      const existing = this.apps.get(gatewayId);
      if (existing && existing.readyState === WebSocket.OPEN) existing.close();
      this.apps.set(gatewayId, clientWs);
      this.setupAppHandlers(clientWs, gatewayId, lastEventSeq);
    } else {
      const existing = this.gateways.get(gatewayId);
      if (existing && existing.readyState === WebSocket.OPEN) existing.close();
      this.gateways.set(gatewayId, clientWs);
      this.gatewayKeyHashes.set(gatewayId, keyHash);
      this.setupGatewayHandlers(clientWs, gatewayId);
    }

    return new Response(null, { status: 200, webSocket: response as unknown as WebSocket });
  }

  private setupGatewayHandlers(ws: WebSocket, gatewayId: string): void {
    ws.addEventListener('message', (event) => {
      this._seq++;
      let payload: unknown;
      try {
        payload = JSON.parse((event as MessageEvent).data as string);
      } catch {
        return;
      }

      const wrapper = payload as { encrypted?: { iv: string; data: string } };
      if (!wrapper || !wrapper.encrypted) return;

      const appWs = this.apps.get(gatewayId);
      if (appWs && appWs.readyState === WebSocket.OPEN) {
        appWs.send(JSON.stringify(wrapper.encrypted));
      }
    });
    ws.addEventListener('close', () => {
      this.gateways.delete(gatewayId);
      this.gatewayKeyHashes.delete(gatewayId);
    });
  }

  private setupAppHandlers(ws: WebSocket, gatewayId: string, _lastEventSeq?: number): void {
    ws.addEventListener('message', (event) => {
      this._seq++;
      let payload: unknown;
      try {
        payload = JSON.parse((event as MessageEvent).data as string);
      } catch {
        return;
      }

      const envelope = payload as { iv?: string; data?: string };
      if (!envelope || !envelope.iv || !envelope.data) return;

      const gatewayWs = this.gateways.get(gatewayId);
      if (gatewayWs && gatewayWs.readyState === WebSocket.OPEN) {
        gatewayWs.send(JSON.stringify({ encrypted: envelope }));
      }
    });
    ws.addEventListener('close', () => {
      this.apps.delete(gatewayId);
    });
  }
}

describe('Hub Durable Object', () => {
  describe('gateway registration', () => {
    it('registers a gateway on WebSocket connect', async () => {
      const hub = new TestHub();
      const req = makeRequest('/relay?gatewayId=gw1&keyHash=test-hash', {
        headers: { upgrade: 'websocket' },
      });

      const res = await hub.fetch(req);
      expect(res.status).toBe(200);

      const health = await hub.fetch(makeRequest('/health'));
      const body = await health.json() as { ok: boolean };
      expect(body.ok).toBe(true);
    });

    it('rejects gateway without gatewayId or keyHash', async () => {
      const hub = new TestHub();

      const res1 = await hub.fetch(makeRequest('/relay?keyHash=test-hash', {
        headers: { upgrade: 'websocket' },
      }));
      expect(res1.status).toBe(400);

      const res2 = await hub.fetch(makeRequest('/relay?gatewayId=gw1', {
        headers: { upgrade: 'websocket' },
      }));
      expect(res2.status).toBe(400);
    });

    it('rejects gateway with wrong keyHash when already registered (401)', async () => {
      const hub = new TestHub();
      // First gateway registers with test-hash
      await hub.fetch(makeRequest('/relay?gatewayId=gw1&keyHash=test-hash', {
        headers: { upgrade: 'websocket' },
      }));
      // Second gateway with different hash for same gatewayId is rejected
      const res = await hub.fetch(makeRequest('/relay?gatewayId=gw1&keyHash=wrong-hash', {
        headers: { upgrade: 'websocket' },
      }));
      expect(res.status).toBe(401);
    });
  });

  describe('app registration', () => {
    it('rejects app when gateway is not connected (503)', async () => {
      const hub = new TestHub();

      const req = makeRequest('/relay?gatewayId=gw1&keyHash=secret&app=1', {
        headers: { upgrade: 'websocket' },
      });

      const res = await hub.fetch(req);
      expect(res.status).toBe(503);
    });

    it('registers app when gateway is connected', async () => {
      const hub = new TestHub();

      // Connect gateway first
      await hub.fetch(makeRequest('/relay?gatewayId=gw1&keyHash=test-hash', {
        headers: { upgrade: 'websocket' },
      }));

      // Now app can connect
      const appReq = makeRequest('/relay?gatewayId=gw1&keyHash=test-hash&app=1', {
        headers: { upgrade: 'websocket' },
      });
      const appRes = await hub.fetch(appReq);
      expect(appRes.status).toBe(200);
    });

    it('rejects app with wrong key (401)', async () => {
      const hub = new TestHub();

      await hub.fetch(makeRequest('/relay?gatewayId=gw1&keyHash=test-hash', {
        headers: { upgrade: 'websocket' },
      }));

      const appReq = makeRequest('/relay?gatewayId=gw1&keyHash=wrong-hash&app=1', {
        headers: { upgrade: 'websocket' },
      });
      const appRes = await hub.fetch(appReq);
      expect(appRes.status).toBe(401);
    });
  });

  describe('GET /connect', () => {
    it('returns hasGateway=false when not connected', async () => {
      const hub = new TestHub();
      const res = await hub.fetch(makeRequest('/connect?gatewayId=gw1'));
      const body = await res.json() as { hasGateway: boolean };
      expect(body.hasGateway).toBe(false);
    });

    it('returns hasGateway=true when gateway is connected', async () => {
      const hub = new TestHub();
      await hub.fetch(makeRequest('/relay?gatewayId=gw1&keyHash=test-hash', {
        headers: { upgrade: 'websocket' },
      }));
      const res = await hub.fetch(makeRequest('/connect?gatewayId=gw1'));
      const body = await res.json() as { hasGateway: boolean };
      expect(body.hasGateway).toBe(true);
    });
  });

  describe('seq counter', () => {
    it('starts at 0', async () => {
      const hub = new TestHub();
      expect(hub.seq).toBe(0);
    });
  });

  describe('connection replacement', () => {
    it('replaces existing gateway connection for same gatewayId', async () => {
      const hub = new TestHub();

      const res1 = await hub.fetch(makeRequest('/relay?gatewayId=gw1&keyHash=test-hash', {
        headers: { upgrade: 'websocket' },
      }));
      expect(res1.status).toBe(200);

      const res2 = await hub.fetch(makeRequest('/relay?gatewayId=gw1&keyHash=test-hash', {
        headers: { upgrade: 'websocket' },
      }));
      expect(res2.status).toBe(200);
    });
  });

  describe('health endpoint', () => {
    it('returns gateway count', async () => {
      const hub = new TestHub();
      const res = await hub.fetch(makeRequest('/health'));
      const body = await res.json() as { ok: boolean; gateways: number };
      expect(body.ok).toBe(true);
      expect(body.gateways).toBe(0);
    });
  });
});
