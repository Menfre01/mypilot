import { WebSocketServer, type WebSocket } from 'ws';
import type { Server, IncomingMessage } from 'node:http';
import type { ClaudeProcessManager } from './claude-process-manager.js';
import type { SessionStore } from './session-store.js';
import type { Duplex } from 'node:stream';
import type { PtyRelayClientMessage } from '../../shared/protocol.js';

export interface PtyRelayServer {
  start(): void;
  stop(): Promise<void>;
  /** Handle upgrade request manually. Returns true if handled. */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean;
}

export function createPtyRelay(
  httpServer: Server,
  processManager: ClaudeProcessManager,
  sessionStore: SessionStore,
): PtyRelayServer {
  const LOCALHOST = '127.0.0.1';
  let wss: WebSocketServer | undefined;

  function isLocalhost(req: IncomingMessage): boolean {
    const addr = req.socket?.remoteAddress;
    return (
      addr === LOCALHOST ||
      addr === '::1' ||
      addr === '::ffff:127.0.0.1' ||
      addr === 'localhost' ||
      addr === undefined
    );
  }

  function handleConnection(ws: WebSocket, req: IncomingMessage): void {
        const url = new URL(req.url ?? '/', `http://localhost`);
        const rawSessionId = url.searchParams.get('sessionId');

        let resolvedSessionId: string;
        if (rawSessionId === 'last') {
          const last = processManager.getMostRecentSession('mobile');
          if (!last) {
            ws.send(JSON.stringify({ type: 'pty_error', message: 'No active sessions' }));
            ws.close();
            return;
          }
          resolvedSessionId = last.sessionId;
        } else {
          resolvedSessionId = rawSessionId ?? 'new';
        }

        const isNew = resolvedSessionId === 'new' || !resolvedSessionId;
        const initialSessionId = isNew
          ? crypto.randomUUID()
          : resolvedSessionId;
        const sessionIdRef = processManager.createSessionIdRef(initialSessionId);

        const name = url.searchParams.get('name') ?? undefined;
        const cwd = url.searchParams.get('cwd') ?? undefined;
        const model = url.searchParams.get('model') ?? undefined;

        function attachToSession(): void {
          const client = {
            send(data: string): void {
              if (ws.readyState === ws.OPEN) {
                ws.send(JSON.stringify({ type: 'pty_out', data }));
              }
            },
            onClose(handler: () => void): void {
              ws.on('close', handler);
            },
          };

          const attached = processManager.attachRelay(sessionIdRef.current, client);
          if (!attached) {
            sendError(ws, 'Session already attached from another terminal.');
            return;
          }

          ws.send(JSON.stringify({ type: 'pty_ready', sessionId: sessionIdRef.current }));

          // When the underlying PTY process exits, notify the terminal client
          function onSessionEnded(endedSessionId: string): void {
            if (endedSessionId !== sessionIdRef.current) return;
            processManager.off('session_ended', onSessionEnded);
            if (ws.readyState === ws.OPEN) {
              ws.send(JSON.stringify({ type: 'session_end', sessionId: sessionIdRef.current }));
            }
            ws.close();
          }
          processManager.on('session_ended', onSessionEnded);

          ws.on('message', (raw) => {
            let msg: PtyRelayClientMessage;
            try {
              msg = JSON.parse(raw.toString());
            } catch {
              return;
            }

            try {
              switch (msg.type) {
                case 'pty_in':
                  if (msg.data) {
                    processManager.write(sessionIdRef.current, msg.data);
                  }
                  break;
                case 'pty_detach':
                  processManager.detachRelay(sessionIdRef.current);
                  ws.send(JSON.stringify({ type: 'session_detached', sessionId: sessionIdRef.current }));
                  break;
                case 'pty_resize':
                  if (msg.cols != null && msg.rows != null) {
                    processManager.resize(sessionIdRef.current, msg.cols, msg.rows);
                  }
                  break;
              }
            } catch {
              // PTY may already be dead — ignore message processing errors
            }
          });

          ws.on('close', () => {
            processManager.off('session_ended', onSessionEnded);
            // detachRelay 由 client.onClose 自动处理，避免重复 emit session_detached
          });

          ws.on('error', () => {
            processManager.off('session_ended', onSessionEnded);
          });
        }

        function sendError(ws: WebSocket, message: string): void {
          ws.send(JSON.stringify({ type: 'pty_error', message }));
          ws.close();
        }

        if (isNew) {
          try {
            processManager.spawnPTY(sessionIdRef.current, { cwd, model, displayName: name });
          } catch (err) {
            sendError(ws, `Failed to spawn session: ${(err as Error).message}`);
            return;
          }
          attachToSession();
        } else {
          // 支持短 ID 前缀匹配
          const resolved = processManager.findSessionId(resolvedSessionId);
          if (!resolved) {
            sendError(ws, `Session ${resolvedSessionId} not found`);
            return;
          }
          sessionIdRef.current = resolved;

          const existing = processManager.getStatus(sessionIdRef.current);
          if (!existing) {
            sendError(ws, `Session ${resolvedSessionId} not found`);
            return;
          }
          // 桌面终端接管时更新 source
          sessionStore.setSource(sessionIdRef.current, 'desktop');
          if (existing.mode === 'headless') {
            processManager.handoff(sessionIdRef.current).then(() => {
              attachToSession();
            }).catch((err) => {
              sendError(ws, `Failed to handoff session: ${err.message}`);
            });
            return;
          }
          attachToSession();
        }
      }

    return {
      start(): void {
        wss = new WebSocketServer({ noServer: true });
      },

      handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean {
        const url = new URL(req.url ?? '/', `http://localhost`);
        if (url.pathname !== '/pty-relay') return false;

        if (!isLocalhost(req)) {
          console.warn('[PTYRelay] rejected connection from non-localhost: %s', req.socket?.remoteAddress);
          socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
          socket.destroy();
          return true;
        }

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        wss!.handleUpgrade(req, socket as any, head, (ws) => {
          handleConnection(ws, req);
        });
        return true;
      },

      async stop(): Promise<void> {
        return new Promise((resolve) => {
          if (wss) {
            wss.close(() => resolve());
          } else {
            resolve();
          }
        });
      },
    };
  }
