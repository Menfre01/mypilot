import { createServer as createHttpServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { SessionStore } from './session-store.js';
import { PendingStore } from './pending-store.js';
import { DeviceStore } from './device-store.js';
import { WsBus } from './ws-bus.js';
import { HookHandler, HttpError } from './hook-handler.js';
import { EventLogger } from './event-logger.js';
import { PushService } from './push-service.js';
import type { PushConfigFile } from './push-config.js';
import { loadGatewayState, saveGatewayState } from './gateway-state.js';
import { PROTOCOL_VERSION, SYNTHETIC_MODEL, type GatewayConnected, type ClientMessage, type SessionEvent, type SSEHookEvent, type TranscriptEntry } from '../../shared/protocol.js';
import { SessionStreamManager } from './session-stream-manager.js';
import { TokenStatsStore, parseBrand } from './token-stats-store.js';
import { TailerStateStore } from './tailer-state-store.js';
import { getLocalDate } from '../../shared/date-utils.js';
import { basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { accessSync, constants } from 'node:fs';
import { ClaudeProcessManager } from './claude-process-manager.js';
import { createPtyRelay, type PtyRelayServer } from './pty-relay.js';
import { getAllCommands } from './commands.js';


export type { PushConfigFile as PushConfig };

export interface GatewayServer {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export function createServer(
  port: number,
  logDir: string,
  pidDir: string,
  key: Buffer,
  pushConfig?: PushConfigFile,
): GatewayServer {
  const savedState = loadGatewayState(pidDir);

  const sessionStore = new SessionStore();
  const pendingStore = new PendingStore();
  const deviceStore = new DeviceStore(savedState?.devices);
  const wsBus = new WsBus(key);
  const processManager = new ClaudeProcessManager();
  let ptyRelay: PtyRelayServer | undefined;
  const eventLogger = new EventLogger(logDir);
  const tokenStatsStore = new TokenStatsStore(pidDir);
  const tailerStateStore = new TailerStateStore(pidDir);

  const CTRL_C = '\x03';
  // 追踪被 ESC 中断过的 session，用于 send_prompt 时决定是否需要 CTRL_C 清除残留输入
  const interruptedSessions = new Set<string>();

  const keyB64 = key.toString('base64');
  const MAX_RECENT_EVENTS = 500;

  function getRecentEvents(lastEventSeq?: number) {
    const fromBuffer = sessionStreamManager.getBySource('hook')
      .map(m => m.event != null ? { sessionId: m.sessionId, seq: m.seq, event: m.event } : undefined)
      .filter((item): item is SessionEvent => item != null);

    if (fromBuffer.length === 0) {
      if (lastEventSeq == null) return hookHandler.getEventHistory();
      return eventLogger.readEventsAfter(lastEventSeq, MAX_RECENT_EVENTS);
    }

    if (lastEventSeq == null) return fromBuffer;

    // 缓冲区可能不完整（部分条目已被 drain 消费），检查是否存在 gap
    const minBufferedSeq = fromBuffer[0].seq;
    if (minBufferedSeq <= lastEventSeq + 1) return fromBuffer;

    const diskEntries = eventLogger.readEventsAfter(lastEventSeq, minBufferedSeq - lastEventSeq);
    return [...diskEntries, ...fromBuffer].slice(-MAX_RECENT_EVENTS);
  }

  function getRecentTranscriptEntries(lastEventSeq?: number) {
    type TE = { sessionId: string; seq: number; entry: TranscriptEntry };
    const fromBuffer = sessionStreamManager.getBySource('transcript')
      .map(m => m.entry != null ? { sessionId: m.sessionId, seq: m.seq, entry: m.entry } : undefined)
      .filter((item): item is TE => item != null);

    if (fromBuffer.length === 0) {
      if (lastEventSeq == null) return [];
      // 缓冲区已淘汰，回退磁盘
      return eventLogger.readTranscriptEntriesAfter(lastEventSeq, MAX_RECENT_EVENTS);
    }

    if (lastEventSeq == null) return fromBuffer;

    // 缓冲区可能不完整（部分条目已被 drain 消费），检查是否存在 gap
    const minBufferedSeq = fromBuffer[0].seq;
    if (minBufferedSeq <= lastEventSeq + 1) return fromBuffer;

    const diskEntries = eventLogger.readTranscriptEntriesBetween(lastEventSeq, minBufferedSeq);
    return [...diskEntries, ...fromBuffer].slice(-MAX_RECENT_EVENTS);
  }

  const pushService = pushConfig
    ? new PushService(pushConfig.relayUrl, pushConfig.apiKey, pushConfig.gatewayId)
    : undefined;

  // 预热 Worker，避免首次推送因冷启动超时（fire-and-forget，不阻塞启动）
  if (pushService) {
    pushService.warmup();
  }

  function persistState(): void {
    const devices = deviceStore.getAll()
      .filter(d => d.pushToken)
      .map(d => ({
        deviceId: d.deviceId,
        platform: d.platform,
        pushToken: d.pushToken,
        pushEnvironment: d.pushEnvironment,
        locale: d.locale,
      }));

    saveGatewayState(pidDir, {
      mode: hookHandler.getMode(),
      takeoverOwner: hookHandler.getTakeoverOwner(),
      devices,
    });
  }

  const hookHandler = new HookHandler(
    sessionStore,
    pendingStore,
    deviceStore,
    wsBus,
    pidDir,
    eventLogger,
    pushService,
    savedState ? { mode: savedState.mode, takeoverOwner: savedState.takeoverOwner } : undefined,
    persistState,
  );

  const sessionStreamManager = new SessionStreamManager(eventLogger, wsBus, {
    isHidden: (id) => sessionStore.isHidden(id),
    tailerStateStore,
  });
  sessionStreamManager.recoverSeq(eventLogger);
  hookHandler.setStreamManager(sessionStreamManager);
  hookHandler.setProcessManager(processManager);

  function drainPipeline(): void {
    const backlog = sessionStreamManager.pipelineSize;
    let batchSize: number;
    if (backlog > 300) batchSize = 50;
    else if (backlog > 100) batchSize = 30;
    else batchSize = 20;
    const messages = sessionStreamManager.pull(batchSize);
    const today = getLocalDate();
    for (const msg of messages) {
      sessionStreamManager.broadcastMessage(msg);
      eventLogger.logSessionMessage(msg);

      if (msg.source === 'transcript' && msg.entry?.usage && msg.entry?.model && msg.entry.model !== SYNTHETIC_MODEL) {
        const usage = msg.entry.usage;
        const model = msg.entry.model;
        const brand = parseBrand(model);
        tokenStatsStore.record(today, brand, model, {
          input: usage.input_tokens,
          output: usage.output_tokens,
          cacheRead: usage.cache_read_input_tokens ?? 0,
          cacheCreation: usage.cache_creation_input_tokens ?? 0,
        });
      }
    }
  }

  sessionStreamManager.onDrain(drainPipeline);

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
    try {
      const body = JSON.stringify(data);
      res.writeHead(status, { 'Content-Type': 'application/json', ...CORS_HEADERS });
      res.end(body);
    } catch (err) {
      // 响应可能已经发送（连接关闭等）
      console.error('[sendJSON] failed:', (err as Error).message);
    }
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

    if (req.method === 'GET' && url.pathname === '/sessions') {
      const sessionsKey = url.searchParams.get('key');
      if (!sessionsKey || sessionsKey !== keyB64) {
        sendJSON(res, 403, { error: 'Invalid key' });
        return;
      }
      const sessions = processManager.getActiveSessions().map(s => ({
        sessionId: s.sessionId,
        mode: s.mode,
        displayName: s.displayName,
        source: sessionStore.get(s.sessionId)?.source ?? 'desktop',
      }));
      sendJSON(res, 200, sessions);
      return;
    }

    res.writeHead(404, CORS_HEADERS);
    res.end('Not Found');
  }

  function broadcastSessionState(lastEventSeq?: number, targetDeviceId?: string, cachedEvents?: ReturnType<typeof getRecentEvents>): void {
    const recentEvents = cachedEvents ?? getRecentEvents(lastEventSeq);
    const pendingInteractions = hookHandler.getPendingInteractions();
    const transcriptEntries = getRecentTranscriptEntries(lastEventSeq);

    const pendingIds = new Set(pendingInteractions.map(p => p.eventId));
    const dedupedEvents = pendingIds.size > 0
      ? recentEvents.filter(e => !pendingIds.has(String(e.event.event_id ?? '')))
      : recentEvents;

    const msg: GatewayConnected = {
      type: 'connected',
      protocolVersion: PROTOCOL_VERSION,
      sessions: sessionStore.getAll(),
      mode: hookHandler.getMode(),
      recentEvents: dedupedEvents,
      pendingInteractions,
      takeoverOwner: hookHandler.getTakeoverOwner() ?? undefined,
      transcriptEntries: transcriptEntries.length > 0 ? transcriptEntries : undefined,
      tokenStats: tokenStatsStore.getStats('today'),
      commands: getAllCommands(),
    };
    wsBus.sendSessionList(msg, targetDeviceId);
  }

  function handleClientMessage(message: ClientMessage, deviceId: string): void {
    deviceStore.touch(deviceId);

    switch (message.type) {
      case 'takeover':
        hookHandler.setMode('takeover', deviceId);
        break;
      case 'release':
        if (hookHandler.getTakeoverOwner() === deviceId) {
          hookHandler.setMode('bystander');
        }
        break;
      case 'interact':
        console.log('[Interact] device=%s session=%s event=%s response=%s',
          deviceId, message.sessionId, message.eventId,
          JSON.stringify(message.response).slice(0, 80));
        pendingStore.resolve(message.sessionId, message.eventId, message.response);
        // Persist synthetic UserPromptSubmit for block+reason or allow+answer,
        // so the user's response survives reconnects with correct seq ordering.
        {
          const resp = message.response as Record<string, unknown> | undefined;
          let prompt: string | undefined;
          if (resp?.decision === 'block' && typeof resp.reason === 'string' && resp.reason.length > 0) {
            prompt = resp.reason;
          } else if (typeof resp?.answer === 'string' && resp.answer.length > 0) {
            prompt = resp.answer;
          }
          if (prompt) {
            const seq = sessionStreamManager.nextSeqFn();
            const synthEvent: SSEHookEvent = {
              session_id: message.sessionId,
              event_name: 'UserPromptSubmit',
              event_id: seq.toString(36),
              timestamp: Date.now(),
              prompt,
            };
            eventLogger.log(message.sessionId, synthEvent, seq);
            hookHandler.pushToHistory(message.sessionId, seq, synthEvent);
            sessionStreamManager.push({
              sessionId: message.sessionId,
              seq,
              timestamp: synthEvent.timestamp as number,
              source: 'hook',
              event: synthEvent,
            });
          }
        }
        break;
      case 'request_sessions': {
        broadcastSessionState(message.lastEventSeq, deviceId);
        break;
      }
      case 'start_session': {
        const initialId = randomUUID();
        const displayName = message.displayName;
        const sessionIdRef = processManager.createSessionIdRef(initialId);

        // 手机端也使用 PTY 模式（而非 headless/--print），
        // 因为 --print 是一次性模式，进程会立即退出。
        // PTY 模式保持 Claude Code TUI 持续运行，与桌面行为一致。
        try {
          processManager.spawnPTY(initialId, {
            cwd: message.cwd,
            model: message.model,
            displayName,
            source: 'mobile',
          });
        } catch (err) {
          console.error('[Gateway] start_session spawnPTY failed: %s', (err as Error).message);
          wsBus.broadcast({ type: 'session_error', sessionId: initialId, message: `启动 session 失败: ${(err as Error).message}` }, deviceId);
          break;
        }

        // cwd 由 HookHandler 在 SessionStart 对账时统一记录
        broadcastSessionState(undefined, deviceId);
        break;
      }
      case 'send_prompt': {
        const mode = processManager.getMode(message.sessionId);
        if (mode === 'headless') {
          const userMsg = JSON.stringify({
            type: 'user',
            message: {
              role: 'user',
              content: [{ type: 'text', text: message.prompt }],
            },
          });
          processManager.write(message.sessionId, userMsg + '\n');
        } else {
          // PTY raw 模式下 Enter 键是 \r，写 \n 只会换行不提交
          const promptText = message.prompt.replace(/\n$/, '');

          // 斜杠命令（/new、/simplify 等）需要在命令模式下执行，
          // \x03 (Ctrl+C) 确保 Claude Code 回到顶层提示符而非聊天输入区
          if (interruptedSessions.has(message.sessionId)) {
            interruptedSessions.delete(message.sessionId);
            processManager.write(message.sessionId, CTRL_C);
          } else if (promptText.startsWith('/')) {
            processManager.write(message.sessionId, CTRL_C);
          }
          if (promptText.length > 0) {
            processManager.write(message.sessionId, promptText);
          }
          // 分两次 write：长 prompt 一次写入时 \r 可能在 node-pty 分块写入间隙丢失，
          // 导致终端不会自动回车，输入挂起直到下一个 prompt 到达
          processManager.write(message.sessionId, '\r');
        }
        break;
      }
      case 'interrupt_session':
        processManager.interrupt(message.sessionId);
        interruptedSessions.add(message.sessionId);
        break;
      case 'subscribe_session':
        void sessionStreamManager.replayHistory(
          message.sessionId, message.fromSeq, deviceId,
        );
        break;
      case 'delete_session':
        interruptedSessions.delete(message.sessionId);
        hookHandler.deleteSession(message.sessionId);
        break;
      case 'register_device':
        console.log('[Device] register_device id=%s platform=%s locale=%s', deviceId, message.platform, message.locale ?? '-');
        deviceStore.register(deviceId, message.platform, message.locale);
        break;
      case 'register_push':
        console.log('[Device] register_push id=%s token=%s*** env=%s', deviceId, message.deviceToken.slice(0, 8), message.environment ?? 'undefined');
        if (deviceStore.setPushToken(deviceId, message.deviceToken, message.environment)) {
          persistState();
        }
        break;
      case 'disconnect':
        deviceStore.setConnected(deviceId, false);
        wsBus.disconnect(deviceId);
        break;
      case 'refresh_commands': {
        const commands = getAllCommands();
        wsBus.broadcast({ type: 'commands_list', commands }, deviceId);
        console.log('[Commands] refreshed: %d built-in + scanned', commands.length);
        break;
      }
      case 'stop_session':
        processManager.kill(message.sessionId);
        break;
      case 'request_token_stats': {
        const stats = tokenStatsStore.getStats(message.range);
        wsBus.broadcast({ type: 'token_stats_update', stats });
        break;
      }
      case 'request_directories': {
        const state = loadGatewayState(pidDir);
        const recentCwds = state?.recentCwds ?? [];
        const items = recentCwds.map(p => ({
          path: p,
          label: basename(p),
          source: 'recent' as const,
        }));
        wsBus.broadcast({ type: 'directories_list', items }, deviceId);
        break;
      }
      case 'validate_path': {
        let ok = false;
        let error: string | undefined;
        try {
          accessSync(message.path, constants.R_OK);
          ok = true;
        } catch {
          error = '路径不存在或无访问权限';
        }
        wsBus.broadcast({ type: 'validate_path_result', path: message.path, ok, error }, deviceId);
        break;
      }
    }
  }

  return {
    async start(): Promise<void> {
      httpServer = createHttpServer();
      httpServer.on('request', handleRequest);

      ptyRelay = createPtyRelay(httpServer, processManager, sessionStore);
      ptyRelay.start();
      wsBus.attach(httpServer);

      // Centralized upgrade routing — prevents ws library path-conflict abort
      httpServer.on('upgrade', (req, socket, head) => {
        if (ptyRelay!.handleUpgrade(req, socket, head)) return;
        wsBus.handleUpgrade(req, socket, head);
      });

      // ProcessManager → SessionStore 同步：进程退出/被杀时同步清理
      processManager.on('session_ended', (sessionId: string) => {
        interruptedSessions.delete(sessionId);
        if (sessionStore.has(sessionId)) {
          hookHandler.deleteSession(sessionId);
        }
      });

      wsBus.onMessage(handleClientMessage);
      wsBus.onConnect((url, deviceId) => {
        deviceStore.setConnected(deviceId, true);
        const seqParam = url.searchParams.get('lastEventSeq');
        const lastEventSeq = seqParam != null ? Number(seqParam) : undefined;
        broadcastSessionState(
          Number.isFinite(lastEventSeq) ? lastEventSeq : undefined,
          deviceId,
        );
      });
      wsBus.onDisconnect((deviceId) => {
        deviceStore.setConnected(deviceId, false);
      });
      wsBus.onHeartbeat((deviceId) => {
        deviceStore.touch(deviceId);
      });

      return new Promise((resolve, reject) => {
        httpServer.on("error", reject);
        httpServer.listen(port, resolve);
      });
    },

    async stop(): Promise<void> {
      sessionStreamManager.shutdown();
      pendingStore.releaseAll();
      tokenStatsStore.flush();
      tailerStateStore.flush();
      if (ptyRelay) await ptyRelay.stop();
      processManager.shutdown();
      await wsBus.close();
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
