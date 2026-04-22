import type {
  GatewayMessage, GatewayConnected, GatewayEvent, GatewaySessionStart,
  GatewaySessionEnd, GatewayModeChanged,
  SessionInfo, SSEHookEvent, PendingInteraction, SessionEvent,
  ClientMessage, GatewayMode,
} from './protocol';
import { DEMO_KEY_B64, SESSION_COLORS } from './protocol';
import { importKey, encrypt, decrypt } from './crypto';
import { SimulationScheduler, getSessions, toSessionInfo } from './simulation';

interface DOState {
  seq: number;
  sessions: Record<string, SessionInfo>;
  events: SessionEvent[];
  mode: GatewayMode;
  takeoverOwner: string | null;
  pending: Record<string, PendingInteraction>;
}

export class DemoGatewayDO implements DurableObject {
  private state: DurableObjectState;
  private clients = new Set<WebSocket>();
  private cryptoKey: CryptoKey | null = null;
  private scheduler: SimulationScheduler | null = null;
  private doState: DOState = {
    seq: 0,
    sessions: {},
    events: [],
    mode: 'bystander',
    takeoverOwner: null,
    pending: {},
  };

  constructor(state: DurableObjectState) {
    this.state = state;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const key = url.searchParams.get('key');

    if (key !== DEMO_KEY_B64) {
      return new Response('Forbidden', { status: 403 });
    }

    const upgradeHeader = request.headers.get('Upgrade');
    if (upgradeHeader !== 'websocket') {
      return new Response('Expected WebSocket', { status: 400 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    server.accept();
    this.clients.add(server);

    const deviceId = url.searchParams.get('deviceId') || `dev_${Date.now().toString(36)}`;

    // Set up message handlers
    const DO = this;
    server.addEventListener('message', (event) => DO.handleMessage(server, event.data as string, deviceId));
    server.addEventListener('close', () => DO.handleClose(server));
    server.addEventListener('error', () => DO.handleClose(server));

    // Send connected state
    this.sendConnected(server);

    // Start simulation if not running
    this.ensureSimulation();

    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }

  private async getKey(): Promise<CryptoKey> {
    if (!this.cryptoKey) {
      this.cryptoKey = await importKey(DEMO_KEY_B64);
    }
    return this.cryptoKey;
  }

  private async sendEncrypted(ws: WebSocket, msg: GatewayMessage) {
    try {
      const key = await this.getKey();
      const plaintext = JSON.stringify(msg);
      const encrypted = await encrypt(key, plaintext);
      ws.send(encrypted);
    } catch (e) {
      console.error('sendEncrypted error:', e);
    }
  }

  private async broadcast(msg: GatewayMessage) {
    const key = await this.getKey();
    const plaintext = JSON.stringify(msg);
    const encrypted = await encrypt(key, plaintext);
    for (const ws of this.clients) {
      try {
        ws.send(encrypted);
      } catch {
        this.clients.delete(ws);
      }
    }
  }

  private buildConnectedMsg(): GatewayConnected {
    return {
      type: 'connected',
      sessions: Object.values(this.doState.sessions),
      mode: this.doState.mode,
      recentEvents: this.doState.events.slice(-200),
      pendingInteractions: Object.values(this.doState.pending),
      takeoverOwner: this.doState.takeoverOwner ?? undefined,
    };
  }

  private sendConnected(ws: WebSocket) {
    this.sendEncrypted(ws, this.buildConnectedMsg());
  }

  private async handleMessage(ws: WebSocket, data: string, deviceId: string) {
    try {
      const key = await this.getKey();
      const plaintext = await decrypt(key, data);
      const msg = JSON.parse(plaintext) as ClientMessage;

      switch (msg.type) {
        case 'request_sessions':
          this.sendConnected(ws);
          break;
        case 'takeover':
          this.doState.mode = 'takeover';
          this.doState.takeoverOwner = deviceId;
          this.broadcast({ type: 'mode_changed', mode: 'takeover', takeoverOwner: deviceId });
          break;
        case 'release':
          if (this.doState.takeoverOwner === deviceId) {
            this.doState.mode = 'bystander';
            this.doState.takeoverOwner = null;
            this.broadcast({ type: 'mode_changed', mode: 'bystander' });
          }
          break;
        case 'interact':
          this.handleInteract(msg.eventId);
          break;
        case 'delete_session':
          delete this.doState.sessions[msg.sessionId];
          this.doState.events = this.doState.events.filter(e => e.sessionId !== msg.sessionId);
          this.broadcast({ type: 'session_end', sessionId: msg.sessionId });
          break;
      }
    } catch (e) {
      console.error('handleMessage error:', e);
    }
  }

  private handleInteract(eventId: string) {
    delete this.doState.pending[eventId];
    this.scheduler?.resolveBlocking(eventId);
  }

  private handleClose(ws: WebSocket) {
    this.clients.delete(ws);
    if (this.clients.size === 0 && this.scheduler) {
      this.scheduler.stop();
      this.scheduler = null;
    }
  }

  // ── Simulation control ──

  private ensureSimulation() {
    if (this.scheduler) return;

    const simSessions = getSessions();
    const sessionMap = new Map(simSessions.map(s => [s.id, s]));

    this.scheduler = new SimulationScheduler(
      // send callback
      (step) => {
        if (step.action === 'block' && step.event) {
          const pending: PendingInteraction = {
            sessionId: step.sessionId!,
            eventId: step.event.event_id,
            event: step.event,
          };
          this.doState.pending[step.event.event_id] = pending;
          const msg: GatewayEvent = {
            type: 'event',
            sessionId: step.sessionId!,
            event: step.event,
          };
          this.broadcast(msg);
        } else if (step.action === 'event' && step.event) {
          this.doState.events.push({ sessionId: step.sessionId!, event: step.event });
          if (this.doState.events.length > 200) {
            this.doState.events = this.doState.events.slice(-200);
          }
          const msg: GatewayEvent = {
            type: 'event',
            sessionId: step.sessionId!,
            event: step.event,
          };
          this.broadcast(msg);
        }
      },
      // onSessionStart
      (sessionId: string) => {
        const sim = sessionMap.get(sessionId);
        if (!sim) return;
        const info = toSessionInfo(sim);
        this.doState.sessions[sessionId] = info;
        const msg: GatewaySessionStart = { type: 'session_start', session: info };
        this.broadcast(msg);
      },
      // onSessionEnd
      (sessionId: string) => {
        delete this.doState.sessions[sessionId];
        const msg: GatewaySessionEnd = { type: 'session_end', sessionId };
        this.broadcast(msg);
        // Reset state when all sessions end
        if (Object.keys(this.doState.sessions).length === 0) {
          this.doState.events = [];
          this.doState.pending = {};
        }
      },
    );

    this.scheduler.start();
  }
}
