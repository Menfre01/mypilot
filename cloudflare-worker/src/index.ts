// ── Types ─────────────────────────────────────────────────────────────────────

interface EncryptedEnvelope {
  iv: string;
  data: string;
}

// Re-exported gateway protocol types (must stay in sync with src/shared/protocol.ts)
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
}

// ── Hub Durable Object ─────────────────────────────────────────────────────

export class Hub implements DurableObject {
  private gateways = new Map<string, WebSocket>();
  private apps = new Map<string, WebSocket>();
  private gatewayKeys = new Map<string, string>();
  private seq = 0;

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'POST' && url.pathname === '/hook') {
      return this.handleHook(request);
    }

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

    if (request.method === 'GET' && url.pathname === '/seq') {
      return new Response(JSON.stringify({ seq: this.seq }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const upgrade = request.headers.get('upgrade');
    if (upgrade === 'websocket') {
      const isApp = url.searchParams.get('app') === '1';
      return this.handleWebSocket(request, isApp);
    }

    return new Response('Not Found', { status: 404 });
  }

  private async handleHook(request: Request): Promise<Response> {
    const body = await request.text();
    let hookEvent: SSEHookEvent;
    try {
      hookEvent = JSON.parse(body);
    } catch {
      return new Response('Invalid JSON', { status: 400 });
    }

    const msg: GatewayMessage = {
      type: 'event',
      sessionId: hookEvent.session_id,
      event: hookEvent,
    };

    const deadGateways: string[] = [];
    for (const [id, ws] of this.gateways) {
      try {
        ws.send(JSON.stringify(msg));
      } catch {
        deadGateways.push(id);
      }
    }
    for (const id of deadGateways) {
      this.gateways.delete(id);
      this.gatewayKeys.delete(id);
    }

    return new Response(JSON.stringify({ ok: true }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private async handleWebSocket(request: Request, isApp: boolean): Promise<Response> {
    const url = new URL(request.url);
    const gatewayId = url.searchParams.get('gatewayId') ?? '';
    const key = url.searchParams.get('key') ?? '';
    const lastEventSeqParam = url.searchParams.get('lastEventSeq');
    const lastEventSeq = lastEventSeqParam != null ? Number(lastEventSeqParam) : undefined;

    if (!gatewayId || !key) {
      return new Response('Missing gatewayId or key', { status: 400 });
    }

    if (isApp) {
      if (!this.gateways.has(gatewayId)) {
        return new Response('Gateway not connected', { status: 503 });
      }
      const storedKey = this.gatewayKeys.get(gatewayId);
      if (storedKey !== undefined && storedKey !== key) {
        return new Response('Unauthorized', { status: 401 });
      }
    }

    const pair = new WebSocketPair();
    const clientWs = pair[0];
    const response = pair[1];
    clientWs.accept();

    if (isApp) {
      const existing = this.apps.get(gatewayId);
      if (existing && existing.readyState === WebSocket.OPEN) {
        existing.close();
      }
      this.apps.set(gatewayId, clientWs);
      this.setupAppHandlers(clientWs, gatewayId, lastEventSeq);
    } else {
      const existing = this.gateways.get(gatewayId);
      if (existing && existing.readyState === WebSocket.OPEN) {
        existing.close();
      }
      this.gateways.set(gatewayId, clientWs);
      this.gatewayKeys.set(gatewayId, key);
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

      const envelope = payload as WsEnvelope;
      if (!envelope || !envelope.encrypted) return;

      const appWs = this.apps.get(gatewayId);
      if (appWs && appWs.readyState === WebSocket.OPEN) {
        appWs.send(event.data as string);
      }
    });

    ws.addEventListener('close', () => {
      this.gateways.delete(gatewayId);
      this.gatewayKeys.delete(gatewayId);
    });
  }

  private setupAppHandlers(ws: WebSocket, gatewayId: string, lastEventSeq?: number): void {
    ws.addEventListener('message', (event) => {
      this.seq++;
      let payload: unknown;
      try {
        payload = JSON.parse(event.data as string);
      } catch {
        return;
      }

      const envelope = payload as WsEnvelope;
      if (!envelope || !envelope.encrypted) return;

      const gatewayWs = this.gateways.get(gatewayId);
      if (gatewayWs && gatewayWs.readyState === WebSocket.OPEN) {
        gatewayWs.send(event.data as string);
      }
    });

    ws.addEventListener('close', () => {
      this.apps.delete(gatewayId);
    });
  }

  // Test helpers — not part of the Durable Object public API
  getState(): { gateways: number; apps: number; seq: number } {
    return {
      gateways: this.gateways.size,
      apps: this.apps.size,
      seq: this.seq,
    };
  }
}

// ── Worker entry point ─────────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Environment): Promise<Response> {
    const hubId = env.MYPILOT_relay.idFromName('hub');
    const hub = env.MYPILOT_relay.get(hubId);
    return hub.fetch(request);
  },
};

interface Environment {
  MYPILOT_relay: DurableObjectNamespace<Hub>;
}
