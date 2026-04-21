// ── Types (must stay in sync with src/shared/protocol.ts) ──────────────────────

interface EncryptedEnvelope {
  iv: string;
  data: string;
}

interface SessionInfo {
  id: string;
  color: string;
  colorIndex: number;
  startedAt: number;
}

interface SSEHookEvent {
  session_id: string;
  [key: string]: unknown;
}

interface PendingInteraction {
  sessionId: string;
  eventId: string;
  event: SSEHookEvent;
}

type GatewayMode = 'bystander' | 'takeover';

type GatewayMessage =
  | { type: 'connected'; sessions: SessionInfo[]; mode: GatewayMode; recentEvents: { sessionId: string; event: SSEHookEvent }[]; pendingInteractions: PendingInteraction[] }
  | { type: 'session_start'; session: SessionInfo }
  | { type: 'session_end'; sessionId: string }
  | { type: 'event'; sessionId: string; event: SSEHookEvent }
  | { type: 'mode_changed'; mode: GatewayMode };

type ClientMessage =
  | { type: 'takeover' }
  | { type: 'release' }
  | { type: 'interact'; sessionId: string; eventId: string; response: Record<string, unknown> }
  | { type: 'request_sessions'; lastEventSeq?: number }
  | { type: 'delete_session'; sessionId: string };

// Wire format: encrypted envelope wrapper
interface WsEnvelope {
  encrypted?: EncryptedEnvelope;
  deviceId?: string;
  targetDeviceId?: string;
}

// Relay control messages (plaintext, not encrypted)
interface RelayCtrlMessage {
  relay: 'app_connect';
  deviceId: string;
  lastEventSeq?: number;
}

// ── Hub Durable Object ─────────────────────────────────────────────────────

export class Hub implements DurableObject {
  private static readonly CORS_HEADERS: Record<string, string> = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  private gateways = new Map<string, WebSocket>();
  private apps = new Map<string, Map<string, WebSocket>>();
  private gatewayKeyHashes = new Map<string, string>();
  private seq = 0;
  private autoIdCounter = 0;

  constructor(_ctx: DurableObjectState, _env: Environment) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const corsHeaders = Hub.CORS_HEADERS;

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    if (request.method === 'GET' && url.pathname === '/health') {
      return new Response(JSON.stringify({ ok: true, gateways: this.gateways.size }), {
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    }

    if (request.method === 'GET' && url.pathname === '/connect') {
      const gatewayId = url.searchParams.get('gatewayId') ?? '';
      return new Response(JSON.stringify({ hasGateway: this.gateways.has(gatewayId) }), {
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    }

    if (request.method === 'GET' && url.pathname === '/seq') {
      return new Response(JSON.stringify({ seq: this.seq }), {
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    }

    const upgrade = request.headers.get('upgrade');
    if (upgrade === 'websocket') {
      return this.handleWebSocket(url);
    }

    return new Response('Not Found', { status: 404, headers: corsHeaders });
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

    const deviceId = url.searchParams.get('deviceId') || `_auto_${++this.autoIdCounter}_${Date.now().toString(36)}`;

    if (isApp) {
      let deviceMap = this.apps.get(gatewayId);
      if (!deviceMap) {
        deviceMap = new Map();
        this.apps.set(gatewayId, deviceMap);
      }
      const existing = deviceMap.get(deviceId);
      if (existing && existing.readyState === WebSocket.OPEN) {
        existing.close();
      }
      deviceMap.set(deviceId, clientWs);
      this.setupAppHandlers(clientWs, gatewayId, deviceId, lastEventSeq);
    } else {
      const existing = this.gateways.get(gatewayId);
      if (existing && existing.readyState === WebSocket.OPEN) {
        existing.close();
      }
      this.gateways.set(gatewayId, clientWs);
      this.gatewayKeyHashes.set(gatewayId, keyHash);
      this.setupGatewayHandlers(clientWs, gatewayId);
    }

    return new Response(null, { status: 101, webSocket: response });
  }

  private setupGatewayHandlers(ws: WebSocket, gatewayId: string): void {
    ws.addEventListener('message', (event) => {
      this.seq++;
      let payload: unknown;
      try {
        payload = JSON.parse(event.data as string);
      } catch {
        return;
      }

      const wrapper = payload as WsEnvelope;
      if (!wrapper || !wrapper.encrypted) return;

      const deviceMap = this.apps.get(gatewayId);
      if (!deviceMap) return;

      const serialized = JSON.stringify(wrapper.encrypted);
      if (wrapper.targetDeviceId) {
        const appWs = deviceMap.get(wrapper.targetDeviceId);
        if (appWs && appWs.readyState === WebSocket.OPEN) {
          appWs.send(serialized);
        }
      } else {
        for (const appWs of deviceMap.values()) {
          if (appWs.readyState === WebSocket.OPEN) {
            appWs.send(serialized);
          }
        }
      }
    });

    ws.addEventListener('close', () => {
      this.gateways.delete(gatewayId);
      this.gatewayKeyHashes.delete(gatewayId);
    });
  }

  private setupAppHandlers(ws: WebSocket, gatewayId: string, deviceId: string, lastEventSeq?: number): void {
    const gatewayWs = this.gateways.get(gatewayId);
    if (gatewayWs && gatewayWs.readyState === WebSocket.OPEN) {
      const ctrl: RelayCtrlMessage = { relay: 'app_connect', deviceId, ...(lastEventSeq != null && { lastEventSeq }) };
      gatewayWs.send(JSON.stringify(ctrl));
    }

    ws.addEventListener('message', (event) => {
      this.seq++;
      let payload: unknown;
      try {
        payload = JSON.parse(event.data as string);
      } catch {
        return;
      }

      const envelope = payload as EncryptedEnvelope;
      if (!envelope || !envelope.iv || !envelope.data) return;

      const gatewayWs = this.gateways.get(gatewayId);
      if (gatewayWs && gatewayWs.readyState === WebSocket.OPEN) {
        gatewayWs.send(JSON.stringify({ encrypted: envelope, deviceId }));
      }
    });

    ws.addEventListener('close', () => {
      const deviceMap = this.apps.get(gatewayId);
      if (deviceMap) {
        deviceMap.delete(deviceId);
        if (deviceMap.size === 0) this.apps.delete(gatewayId);
      }
    });
  }

  // Test helpers — not part of the Durable Object public API
  getState(): { gateways: number; apps: number; seq: number } {
    let totalApps = 0;
    for (const dm of this.apps.values()) totalApps += dm.size;
    return {
      gateways: this.gateways.size,
      apps: totalApps,
      seq: this.seq,
    };
  }
}

// ── Worker entry point ─────────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Environment): Promise<Response> {
    const hubId = env.MYPILOT_RELAY.idFromName('hub');
    const hub = env.MYPILOT_RELAY.get(hubId);
    return hub.fetch(request);
  },
};

interface Environment {
  MYPILOT_RELAY: DurableObjectNamespace;
}
