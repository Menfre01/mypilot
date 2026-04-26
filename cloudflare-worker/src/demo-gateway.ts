import type {
  GatewayMessage, GatewayConnected, GatewayEvent, GatewaySessionStart,
  GatewaySessionEnd, GatewayModeChanged,
  SessionInfo, SSEHookEvent, PendingInteraction, SessionEvent,
  ClientMessage, GatewayMode, PushEnvironment, DevicePlatform,
} from './protocol';
import { DEMO_KEY_B64, SESSION_COLORS, PROTOCOL_VERSION } from './protocol';
import { importKey, encrypt, decrypt } from './crypto';
import { SimulationScheduler, getSessions, toSessionInfo } from './simulation';

export interface DemoEnv {
  PUSH_RELAY_URL?: string;
  PUSH_RELAY_API_KEY?: string;
}

interface DeviceInfo {
  platform?: DevicePlatform;
  locale?: string;
  pushToken?: string;
  pushEnvironment?: PushEnvironment;
}

interface PushRelayConfig {
  url: string;
  apiKey: string;
}

interface DOState {
  seq: number;
  sessions: Record<string, SessionInfo>;
  events: SessionEvent[];
  mode: GatewayMode;
  takeoverOwner: string | null;
  pending: Record<string, PendingInteraction>;
}

const DEFAULT_PUSH_RELAY_URL = 'https://mypilot-push-relay.menfre.workers.dev';
const DEMO_GATEWAY_ID = 'demo-gateway';
const PUSH_FETCH_TIMEOUT = 5_000;
const PUSH_RELAY_RETRY_INTERVAL = 30_000;

export class DemoGatewayDO implements DurableObject {
  private state: DurableObjectState;
  private env: DemoEnv;
  private clients = new Set<WebSocket>();
  private cryptoKey: CryptoKey | null = null;
  private scheduler: SimulationScheduler | null = null;
  private pushRelayConfig: PushRelayConfig | null = null;
  private pushRelayFailedAt = 0;
  private pushRelayPromise: Promise<PushRelayConfig | null> | null = null;
  private devices = new Map<string, DeviceInfo>();
  private doState: DOState = {
    seq: 0,
    sessions: {},
    events: [],
    mode: 'bystander',
    takeoverOwner: null,
    pending: {},
  };

  constructor(state: DurableObjectState, env: DemoEnv) {
    this.state = state;
    this.env = env;
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

    server.addEventListener('message', (event) => this.handleMessage(server, event.data as string, deviceId));
    server.addEventListener('close', () => this.handleClose(server));
    server.addEventListener('error', () => this.handleClose(server));

    this.sendConnected(server);
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
      protocolVersion: PROTOCOL_VERSION,
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
        case 'register_device': {
          this.devices.set(deviceId, { platform: msg.platform, locale: msg.locale });
          break;
        }
        case 'register_push': {
          const info = this.ensureDeviceInfo(deviceId);
          info.pushToken = msg.deviceToken;
          info.pushEnvironment = msg.environment ?? 'sandbox';
          break;
        }
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
    // Device info persists across reconnects — DO eviction resets state anyway
    if (this.clients.size === 0 && this.scheduler) {
      this.scheduler.stop();
      this.scheduler = null;
    }
  }

  private async getPushRelayConfig(): Promise<PushRelayConfig | null> {
    if (this.pushRelayConfig) return this.pushRelayConfig;
    if (this.pushRelayFailedAt && Date.now() - this.pushRelayFailedAt < PUSH_RELAY_RETRY_INTERVAL) return null;
    if (this.pushRelayPromise) return this.pushRelayPromise;

    this.pushRelayPromise = this.doInitPushRelay();
    try {
      return await this.pushRelayPromise;
    } finally {
      this.pushRelayPromise = null;
    }
  }

  private async doInitPushRelay(): Promise<PushRelayConfig | null> {
    const url = this.env.PUSH_RELAY_URL || DEFAULT_PUSH_RELAY_URL;
    let apiKey = this.env.PUSH_RELAY_API_KEY || '';

    if (apiKey) {
      this.pushRelayConfig = { url, apiKey };
      return this.pushRelayConfig;
    }

    try {
      const resp = await fetch(`${url}/api/auto-register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ gatewayId: DEMO_GATEWAY_ID }),
      });
      if (!resp.ok) {
        console.error('[DemoPush] Auto-register failed: HTTP %d', resp.status);
        this.pushRelayFailedAt = Date.now();
        return null;
      }
      const body = await resp.json() as { apiKey?: string };
      if (body.apiKey) apiKey = body.apiKey;
    } catch (e) {
      console.error('[DemoPush] Auto-register error:', e);
      this.pushRelayFailedAt = Date.now();
      return null;
    }

    this.pushRelayConfig = { url, apiKey };
    this.pushRelayFailedAt = 0;
    return this.pushRelayConfig;
  }

  private findPushDevice(): { deviceId: string; info: DeviceInfo } | null {
    const owner = this.doState.takeoverOwner;
    if (owner) {
      const info = this.devices.get(owner);
      if (info?.pushToken) {
        return { deviceId: owner, info };
      }
    }
    for (const [deviceId, info] of this.devices) {
      if (info.pushToken) return { deviceId, info };
    }
    return null;
  }

  private async trySendPush(event: SSEHookEvent) {
    const pushDevice = this.findPushDevice();
    if (!pushDevice) return;

    const { info } = pushDevice;
    const eventName = event.event_name;
    const toolName = event.tool_name;
    const notification = getNotification(eventName, toolName);

    const config = await this.getPushRelayConfig();
    if (!config) return;

    const payload = {
      gatewayId: DEMO_GATEWAY_ID,
      deviceToken: info.pushToken,
      environment: info.pushEnvironment ?? 'sandbox',
      payload: {
        aps: {
          alert: { title: notification.title, body: notification.body },
          sound: 'default',
          badge: 1,
          ...(notification.category ? { category: notification.category } : {}),
        },
        session_id: event.session_id,
        event_id: event.event_id,
        event_name: eventName,
        tool_name: toolName,
      },
    };

    console.log('[DemoPush] Sending push for event %s', eventName);
    try {
      const resp = await fetch(`${config.url}/api/push`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${config.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(PUSH_FETCH_TIMEOUT),
      });
      console.log('[DemoPush] Push relay responded: %d', resp.status);
      this.pushRelayFailedAt = 0;
    } catch (err) {
      console.error('[DemoPush] Failed:', err);
      this.pushRelayFailedAt = Date.now();
    }
  }

  private ensureDeviceInfo(deviceId: string): DeviceInfo {
    let info = this.devices.get(deviceId);
    if (!info) {
      info = {};
      this.devices.set(deviceId, info);
    }
    return info;
  }

  private ensureSimulation() {
    if (this.scheduler) return;

    const simSessions = getSessions();
    const sessionMap = new Map(simSessions.map(s => [s.id, s]));

    this.scheduler = new SimulationScheduler(
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

          if (this.doState.mode === 'takeover') {
            void this.trySendPush(step.event);
          }
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
      (sessionId: string) => {
        const sim = sessionMap.get(sessionId);
        if (!sim) return;
        const info = toSessionInfo(sim);
        this.doState.sessions[sessionId] = info;
        const msg: GatewaySessionStart = { type: 'session_start', session: info };
        this.broadcast(msg);
      },
      (sessionId: string) => {
        delete this.doState.sessions[sessionId];
        const msg: GatewaySessionEnd = { type: 'session_end', sessionId };
        this.broadcast(msg);
        if (Object.keys(this.doState.sessions).length === 0) {
          this.doState.events = [];
          this.doState.pending = {};
        }
      },
    );

    this.scheduler.start();
  }
}

function getNotification(eventName: string, toolName?: string): { title: string; body: string; category?: string } {
  switch (eventName) {
    case 'PermissionRequest':
      return { category: 'APPROVAL', title: 'Approval Needed', body: `Wants to use ${toolName ?? 'tool'}` };
    case 'Stop':
    case 'SubagentStop':
      return { category: 'STOP', title: 'Stop Request', body: 'Wants to stop and wait for your input' };
    case 'Elicitation':
      return { title: 'Question', body: 'Has a question for you' };
    case 'PreToolUse':
      if (toolName === 'AskUserQuestion') {
        return { title: 'Question', body: 'Has a question for you' };
      }
      if (toolName === 'ExitPlanMode') {
        return { title: 'Plan Ready', body: 'Wants to exit plan mode for your review' };
      }
      return { title: 'Approval Needed', body: `Wants to use ${toolName ?? 'tool'}` };
    default:
      return { title: 'MyPilot', body: 'New interaction event' };
  }
}
