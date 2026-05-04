import type {
  GatewayMessage, GatewayConnected, GatewayEvent, GatewaySessionStart,
  GatewaySessionEnd, GatewayModeChanged, GatewayTranscriptEntry,
  SessionInfo, SSEHookEvent, PendingInteraction, SessionEvent,
  ClientMessage, GatewayMode, PushEnvironment, DevicePlatform,
  TranscriptEntry, TranscriptBlock, TokenUsage,
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
  private transcriptIndex = 0;
  private sendQueue: Promise<void> = Promise.resolve();

  constructor(state: DurableObjectState, env: DemoEnv) {
    this.state = state;
    this.env = env;
  }

  // 串行化消息发送，确保 hook event 和 transcript entry 按顺序到达客户端
  private enqueue(fn: () => Promise<void>): void {
    this.sendQueue = this.sendQueue.then(fn).catch((err) => {
      console.error('[DemoGW] sendQueue error:', err);
    });
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
    console.log('[DemoGW] WebSocket connected, deviceId=%s, totalClients=%d', deviceId, this.clients.size);

    // 自动将连接的客户端设为 takeover owner，确保交互事件（AskUserQuestion 等）
    // 能正确入队到 SessionPromptBar，用户才可以看到 submit/decline 按钮
    this.doState.mode = 'takeover';
    this.doState.takeoverOwner = deviceId;

    server.addEventListener('message', (event) => this.handleMessage(server, event.data as string, deviceId));
    server.addEventListener('close', () => this.handleClose(server));
    server.addEventListener('error', () => this.handleClose(server));

    await this.sendConnected(server);
    console.log('[DemoGW] sendConnected done, starting simulation');
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

  private async sendConnected(ws: WebSocket) {
    await this.sendEncrypted(ws, this.buildConnectedMsg());
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
          this.enqueue(() => this.broadcast({ type: 'mode_changed', mode: 'takeover', takeoverOwner: deviceId }));
          break;
        case 'release':
          if (this.doState.takeoverOwner === deviceId) {
            this.doState.mode = 'bystander';
            this.doState.takeoverOwner = null;
            this.enqueue(() => this.broadcast({ type: 'mode_changed', mode: 'bystander' }));
          }
          break;
        case 'interact':
          this.handleInteract(msg.eventId, msg.sessionId, msg.response);
          break;
        case 'delete_session':
          delete this.doState.sessions[msg.sessionId];
          this.doState.events = this.doState.events.filter(e => e.sessionId !== msg.sessionId);
          this.enqueue(() => this.broadcast({ type: 'session_end', sessionId: msg.sessionId }));
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
        case 'subscribe_session':
          // Demo has no persisted event log — ignore, client requests history
          // that doesn't exist beyond the in-memory buffer.
          break;
        case 'disconnect':
          // Client is about to close — no action needed.
          break;
      }
    } catch (e) {
      console.error('handleMessage error:', e);
    }
  }

  private handleInteract(eventId: string, sessionId: string, response: Record<string, unknown>) {
    const pending = this.doState.pending[eventId];
    if (!pending) return;

    delete this.doState.pending[eventId];

    // 模拟生产环境：交互完成后推送 PostToolUse + tool_result transcript
    const event = pending.event;
    const toolName = event.tool_name as string | undefined;
    const toolUseId = event.tool_use_id as string | undefined;
    const now = Date.now();

    if (toolName && toolUseId) {
      const answer = getAnswerText(response);

      // PostToolUse hook event
      const postEvent: SSEHookEvent = {
        session_id: sessionId,
        event_name: 'PostToolUse',
        tool_name: toolName,
        tool_use_id: toolUseId,
        tool_result: answer,
        timestamp: now,
        event_id: `post_${eventId}`,
      };
      this.emitEvent(sessionId, postEvent);

      // tool_result transcript entry
      this.emitTranscript(sessionId, this.makeToolResultEntry(
        toolUseId,
        now,
        answer,
        false,
      ));
    }

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
        if (!step.event) return;

        const sessionId = step.sessionId!;
        const event = step.event as SSEHookEvent;
        const eventName = event.event_name as string;
        const toolName = event.tool_name as string | undefined;
        const toolUseId = event.tool_use_id as string | undefined;

        // 统一时间戳：同一 step 内的 hook event 和 transcript entry 使用相同的 timestamp
        const now = Date.now();
        (event as Record<string, unknown>).timestamp = now;

        if (step.action === 'block') {
          const pending: PendingInteraction = {
            sessionId,
            eventId: event.event_id,
            event,
          };
          this.doState.pending[event.event_id] = pending;

          if (eventName === 'PermissionRequest' && toolName && toolUseId) {
            const input = (event.tool_input ?? {}) as Record<string, unknown>;
            // 先发 event 让客户端创建交互卡片，再发 transcript entries 作为上下文
            this.emitEvent(sessionId, event);
            this.emitTranscript(sessionId, this.makeThinkingEntry(toolName, now, input));
            this.emitTranscript(sessionId, this.makeTextEntry(this.getActionText(toolName, input), now));
            this.emitTranscript(sessionId, this.makeToolUseEntry(toolName, toolUseId, now, input));
          } else if (eventName === 'PreToolUse' && toolName === 'AskUserQuestion' && toolUseId) {
            const input = (event.tool_input ?? {}) as Record<string, unknown>;
            // 先发 event 让客户端创建 _InteractionOptionsCard 交互卡片
            this.emitEvent(sessionId, event);
            this.emitTranscript(sessionId, this.makeToolUseEntry(toolName, toolUseId, now, input));
          } else if (eventName === 'PreToolUse' && toolName === 'ExitPlanMode' && toolUseId) {
            const input = (event.tool_input ?? {}) as Record<string, unknown>;
            // 先发 event 让客户端创建 _ExitPlanModeMessage 卡片，plan 正文在其中展示
            this.emitEvent(sessionId, event);
            this.emitTranscript(sessionId, this.makeToolUseEntry(toolName, toolUseId, now, input));
          } else if (eventName === 'Elicitation') {
            const message = String(event.message ?? '');
            this.emitEvent(sessionId, event);
            this.emitTranscript(sessionId, this.makeTextEntry(message, now));
          } else if (eventName === 'Stop') {
            const reason = String(event.reason ?? '');
            this.emitEvent(sessionId, event);
            this.emitTranscript(sessionId, this.makeTextEntry(reason, now));
          } else {
            this.emitEvent(sessionId, event);
          }

          if (this.doState.mode === 'takeover') {
            void this.trySendPush(event);
          }
          return;
        }

        // ── 非阻塞事件：按真实消息流顺序生成 ──

        if (eventName === 'PreToolUse' && toolName && toolUseId) {
          const input = (event.tool_input ?? {}) as Record<string, unknown>;
          // 先发 event 让客户端创建 tool item，再发 transcript entries 作为上下文
          this.emitEvent(sessionId, event);
          this.emitTranscript(sessionId, this.makeThinkingEntry(toolName, now, input));
          this.emitTranscript(sessionId, this.makeTextEntry(this.getActionText(toolName, input), now));
          this.emitTranscript(sessionId, this.makeToolUseEntry(toolName, toolUseId, now, input));
          return;
        }

        if ((eventName === 'PostToolUse' || eventName === 'PostToolUseFailure') && toolName && toolUseId) {
          this.emitEvent(sessionId, event);
          const content = String(event.tool_result ?? event.tool_response ?? '(no output)');
          this.emitTranscript(sessionId, this.makeToolResultEntry(
            toolUseId,
            now,
            content,
            eventName === 'PostToolUseFailure',
          ));
          return;
        }

        // ── 其他事件 ──

        if (eventName === 'UserPromptSubmit') {
          const prompt = String(event.prompt ?? '');
          this.emitEvent(sessionId, event);
          if (prompt) {
            this.emitTranscript(sessionId, this.makeUserPromptEntry(prompt, now));
          }
        } else {
          this.emitEvent(sessionId, event);
        }

        if (this.doState.mode === 'takeover') {
          void this.trySendPush(event);
        }
      },
      (sessionId: string) => {
        const sim = sessionMap.get(sessionId);
        if (!sim) return;
        const info = toSessionInfo(sim);
        this.doState.sessions[sessionId] = info;
        this.enqueue(() => this.broadcast({ type: 'session_start', session: info }));
      },
      (sessionId: string) => {
        delete this.doState.sessions[sessionId];
        this.enqueue(() => this.broadcast({ type: 'session_end', sessionId }));
        if (Object.keys(this.doState.sessions).length === 0) {
          this.doState.events = [];
          this.doState.pending = {};
        }
      },
    );

    this.scheduler.start();
  }

  // ── Transcript entry 构造 ──

  private nextIndex(): number {
    return ++this.transcriptIndex;
  }

  private baseUsage(extra?: Partial<TokenUsage>): TokenUsage {
    return {
      input_tokens: 12000,
      output_tokens: 0,
      cache_read_input_tokens: 29056,
      ...extra,
    };
  }

  private makeThinkingEntry(toolName: string, timestamp: number, input?: Record<string, unknown>): TranscriptEntry {
    return {
      index: this.nextIndex(),
      type: 'assistant' as const,
      timestamp,
      model: 'Claude Opus 4',
      usage: this.baseUsage(),
      blocks: [{ type: 'thinking', thinking: getThinkingText(toolName, input) }],
    };
  }

  private makeTextEntry(text: string, timestamp: number): TranscriptEntry {
    return {
      index: this.nextIndex(),
      type: 'assistant' as const,
      timestamp,
      model: 'Claude Opus 4',
      usage: this.baseUsage(),
      blocks: [{ type: 'text', text }],
    };
  }

  private makeToolUseEntry(toolName: string, toolUseId: string, timestamp: number, input: Record<string, unknown>): TranscriptEntry {
    return {
      index: this.nextIndex(),
      type: 'assistant' as const,
      timestamp,
      model: 'Claude Opus 4',
      usage: this.baseUsage({ output_tokens: 150 }),
      blocks: [{ type: 'tool_use', id: toolUseId, name: toolName, input }],
    };
  }

  private makeToolResultEntry(toolUseId: string, timestamp: number, content: string, isError: boolean): TranscriptEntry {
    return {
      index: this.nextIndex(),
      type: 'user' as const,
      timestamp,
      blocks: [{ type: 'tool_result', tool_use_id: toolUseId, content, isError }],
    };
  }

  private makeUserPromptEntry(prompt: string, timestamp: number): TranscriptEntry {
    return {
      index: this.nextIndex(),
      type: 'user' as const,
      timestamp,
      blocks: [{ type: 'text', text: prompt }],
    };
  }

  private emitTranscript(sessionId: string, entry: TranscriptEntry) {
    const seq = ++this.doState.seq;
    this.enqueue(() => this.broadcast({ type: 'transcript_entry', sessionId, seq, entry }));
  }

  private emitEvent(sessionId: string, event: SSEHookEvent) {
    const seq = ++this.doState.seq;
    this.doState.events.push({ sessionId, seq, event });
    if (this.doState.events.length > 200) {
      this.doState.events = this.doState.events.slice(-200);
    }
    this.enqueue(() => this.broadcast({ type: 'event', sessionId, seq, event }));
  }

  private getActionText(toolName: string, input?: Record<string, unknown>): string {
    const filePath = input?.file_path as string | undefined;
    const command = input?.command as string | undefined;
    const description = input?.description as string | undefined;
    const pattern = input?.pattern as string | undefined;

    switch (toolName) {
      case 'Read':
        return `Let me read \`${filePath || 'the file'}\` to understand the current implementation.`;
      case 'Bash':
        return `Let me run \`${command || 'the command'}\` to check the current state.`;
      case 'Glob':
        return `Let me find files matching \`${pattern || '**/*'}\` to understand the project structure.`;
      case 'Grep':
        return `Let me search for \`${pattern || ''}\` across the codebase.`;
      case 'Edit':
        return `Let me modify \`${filePath || 'the file'}\` to implement the required changes.`;
      case 'Write':
        return `Let me create \`${filePath || 'a new file'}\` to complete this task.`;
      case 'Agent':
        return `This task needs focused work. Let me delegate to a subagent${description ? `: ${description}` : ''}.`;
      case 'TaskUpdate':
        return `Let me update the task status.`;
      case 'ExitPlanMode':
        return `Plan is ready for your review.`;
      default:
        return `Let me use ${toolName} to continue.`;
    }
  }
}

function getThinkingText(toolName: string, input?: Record<string, unknown>): string {
  const filePath = input?.file_path as string | undefined;
  const pattern = input?.pattern as string | undefined;
  const command = input?.command as string | undefined;
  const description = input?.description as string | undefined;

  switch (toolName) {
    case 'Glob':
      return `I need to find files matching \`${pattern || '**/*'}\` to understand the project structure. Let me search the codebase to locate relevant files.`;
    case 'Grep':
      return `Let me search for \`${pattern || ''}\` across the codebase to find relevant references and understand how this is used.`;
    case 'Read':
      return `I should read \`${filePath || 'the file'}\` first to understand the current implementation before making any changes.`;
    case 'Bash':
      return `Let me run \`${command || 'the command'}\` to verify the current state and check if everything works as expected.`;
    case 'Edit':
      return `I need to make a precise edit to \`${filePath || 'the file'}\` to implement the required changes.`;
    case 'Write':
      return `Let me create \`${filePath || 'a new file'}\` with the necessary content to complete this task.`;
    case 'Agent':
      return `This task requires focused work. Let me delegate to a subagent${description ? ` for: ${description}` : ''}.`;
    case 'TaskUpdate':
      return `Let me update the task status to reflect the current progress.`;
    case 'ExitPlanMode':
      return `The implementation plan is ready. Let me finalize the approach and submit for review, making sure each step has been carefully considered.`;
    default:
      return `Let me use ${toolName} to proceed with the current task.`;
  }
}

function getQuestionPreview(input: Record<string, unknown>): string {
  const prompt = input.prompt as string | undefined;
  const questions = input.questions as Array<{
    question?: string;
    header?: string;
    multiSelect?: boolean;
    options?: Array<{ label: string; description?: string }>;
  }> | undefined;

  if (questions && questions.length > 0) {
    const q = questions[0];
    const isMulti = q.multiSelect === true;
    const indicator = isMulti ? ' (Select all that apply)' : ' (Select one)';
    const header = q.header ? `**${q.header}**\n` : '';
    const questionText = q.question || prompt || '';
    const options = q.options?.map(o => `- ${o.label}${o.description ? `: ${o.description}` : ''}`).join('\n') ?? '';
    return `${header}${questionText}${indicator}${options ? '\n' + options : ''}`;
  }

  if (prompt) return prompt;
  return 'A question requires your response.';
}

function getAnswerText(response: Record<string, unknown>): string {
  const answer = response.answer as string | undefined;
  const decision = response.decision as string | undefined;
  if (answer && answer.trim()) return answer;
  if (decision) return decision;
  return JSON.stringify(response);
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
