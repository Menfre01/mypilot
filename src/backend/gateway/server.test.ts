import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { request } from 'node:http';
import { randomBytes } from 'node:crypto';
import { WebSocket } from 'ws';
import { createServer } from './server.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { waitForMessage, waitForClose, collectMessages, encSend, decRaw, wsUrl } from './ws-test-helpers.js';

// ── Helpers ──

function randomPort(): number {
  return 20000 + Math.floor(Math.random() * 10000);
}

const TEST_KEY = randomBytes(32);
const TEST_KEY_B64 = TEST_KEY.toString('base64');

function httpReq(
  port: number,
  method: string,
  path: string,
  body?: string,
): Promise<{ status: number; body: string; headers: Record<string, string> }> {
  return new Promise((resolve, reject) => {
    const req = request(
      { hostname: 'localhost', port, path, method, headers: { 'Content-Type': 'application/json' } },
      (res) => {
        let data = '';
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(res.headers)) {
          if (typeof v === 'string') headers[k] = v;
        }
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data, headers }));
      },
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// ── Tests ──

describe('createServer', () => {
  let server: ReturnType<typeof createServer>;
  let port: number;
  let logDir: string;

  beforeEach(() => {
    port = randomPort();
    logDir = mkdtempSync(join(tmpdir(), 'mypilot-test-'));
  });

  afterEach(async () => {
    if (server) {
      await server.stop();
    }
    try { rmSync(logDir, { recursive: true }); } catch {}
  });

  // ── Server lifecycle ──

  it('start() listens on configured port', async () => {
    server = createServer(port, logDir, TEST_KEY);
    await server.start();

    const res = await httpReq(port, 'GET', '/');
    expect(res.status).toBe(404);
  });

  it('stop() closes the server', async () => {
    server = createServer(port, logDir, TEST_KEY);
    await server.start();
    await server.stop();

    await expect(httpReq(port, 'GET', '/')).rejects.toThrow();
  });

  it('start() and stop() can be called multiple times', async () => {
    server = createServer(port, logDir, TEST_KEY);
    await server.start();
    await server.stop();
    await server.start();
    await server.stop();
  });

  // ── POST /hook routing ──

  it('POST /hook returns 200 for valid event', async () => {
    server = createServer(port, logDir, TEST_KEY);
    await server.start();

    const event = JSON.stringify({
      session_id: 'test-session',
      hook_event_name: 'Notification',
    });
    const res = await httpReq(port, 'POST', '/hook', event);

    expect(res.status).toBe(200);
    const parsed = JSON.parse(res.body);
    expect(parsed).toEqual({});
  });

  it('POST /hook returns 400 for invalid JSON', async () => {
    server = createServer(port, logDir, TEST_KEY);
    await server.start();

    const res = await httpReq(port, 'POST', '/hook', 'not json');

    expect(res.status).toBe(400);
  });

  it('POST /hook returns 500 for missing session_id', async () => {
    server = createServer(port, logDir, TEST_KEY);
    await server.start();

    const event = JSON.stringify({ event_name: 'Notification' });
    const res = await httpReq(port, 'POST', '/hook', event);

    expect(res.status).toBe(500);
  });

  // ── GET /pair ──

  it('GET /pair returns 200 with valid key', async () => {
    server = createServer(port, logDir, TEST_KEY);
    await server.start();

    const res = await httpReq(port, 'GET', `/pair?key=${encodeURIComponent(TEST_KEY_B64)}`);
    expect(res.status).toBe(200);
    const parsed = JSON.parse(res.body);
    expect(parsed.ok).toBe(true);
    expect(parsed.port).toBe(port);
  });

  it('GET /pair returns CORS headers', async () => {
    server = createServer(port, logDir, TEST_KEY);
    await server.start();

    const res = await httpReq(port, 'GET', `/pair?key=${encodeURIComponent(TEST_KEY_B64)}`);
    expect(res.headers['access-control-allow-origin']).toBe('*');
  });

  it('OPTIONS returns 204 with CORS headers', async () => {
    server = createServer(port, logDir, TEST_KEY);
    await server.start();

    const res = await httpReq(port, 'OPTIONS', '/pair');
    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe('*');
    expect(res.headers['access-control-allow-methods']).toBeDefined();
  });

  it('GET /pair returns 403 with invalid key', async () => {
    server = createServer(port, logDir, TEST_KEY);
    await server.start();

    const res = await httpReq(port, 'GET', '/pair?key=wrong-key');
    expect(res.status).toBe(403);
  });

  it('GET /pair returns 403 without key', async () => {
    server = createServer(port, logDir, TEST_KEY);
    await server.start();

    const res = await httpReq(port, 'GET', '/pair');
    expect(res.status).toBe(403);
  });

  // ── Unknown routes ──

  it('GET /unknown returns 404', async () => {
    server = createServer(port, logDir, TEST_KEY);
    await server.start();

    const res = await httpReq(port, 'GET', '/unknown');
    expect(res.status).toBe(404);
  });

  it('GET / returns 404 (no static file serving)', async () => {
    server = createServer(port, logDir, TEST_KEY);
    await server.start();

    const res = await httpReq(port, 'GET', '/');
    expect(res.status).toBe(404);
  });

  // ── WebSocket integration ──

  it('client connects via WebSocket with valid key', async () => {
    server = createServer(port, logDir, TEST_KEY);
    await server.start();

    const ws = new WebSocket(wsUrl(port, TEST_KEY_B64));
    const msg = await waitForMessage(ws, TEST_KEY);

    const parsed = JSON.parse(msg);
    expect(parsed.type).toBe('connected');
    expect(parsed.mode).toBe('bystander');
    expect(parsed.sessions).toEqual([]);

    ws.close();
    await waitForClose(ws);
  });

  it('WebSocket rejects connection without key', async () => {
    server = createServer(port, logDir, TEST_KEY);
    await server.start();

    const ws = new WebSocket(`ws://localhost:${port}/ws-gateway`);
    await new Promise<void>((resolve) => {
      ws.on('error', () => {});
      ws.on('close', () => resolve());
    });
    expect(ws.readyState).toBe(ws.CLOSED);
  });

  it('WebSocket rejects connection with wrong key', async () => {
    server = createServer(port, logDir, TEST_KEY);
    await server.start();

    const ws = new WebSocket(wsUrl(port, 'wrong'));
    await new Promise<void>((resolve) => {
      ws.on('error', () => {});
      ws.on('close', () => resolve());
    });
    expect(ws.readyState).toBe(ws.CLOSED);
  });

  it('POST /hook broadcasts event to connected WebSocket client', async () => {
    server = createServer(port, logDir, TEST_KEY);
    await server.start();

    const ws = new WebSocket(wsUrl(port, TEST_KEY_B64));
    await waitForMessage(ws, TEST_KEY); // consume initial connected message

    // Post an event and concurrently wait for the WS broadcast
    const event = JSON.stringify({
      session_id: 's1',
      hook_event_name: 'Notification',
      message: 'hello world',
    });
    const [res, messages] = await Promise.all([
      httpReq(port, 'POST', '/hook', event),
      collectMessages(ws, 2, 3000, TEST_KEY),
    ]);

    expect(res.status).toBe(200);
    // First broadcast is session_start (new session auto-registration), then event
    expect(JSON.parse(messages[0]).type).toBe('session_start');
    const eventParsed = JSON.parse(messages[1]);
    expect(eventParsed.type).toBe('event');
    expect(eventParsed.sessionId).toBe('s1');
    expect(eventParsed.event.session_id).toBe('s1');

    ws.close();
    await waitForClose(ws);
  });

  it('client can switch to takeover mode via WebSocket', async () => {
    server = createServer(port, logDir, TEST_KEY);
    await server.start();

    const ws = new WebSocket(wsUrl(port, TEST_KEY_B64));
    await waitForMessage(ws, TEST_KEY); // consume initial connected message

    // Send takeover message (encrypted)
    encSend(ws, TEST_KEY, { type: 'takeover' });

    // Should receive mode_changed
    const msg = await waitForMessage(ws, TEST_KEY);
    const parsed = JSON.parse(msg);
    expect(parsed.type).toBe('mode_changed');
    expect(parsed.mode).toBe('takeover');

    ws.close();
    await waitForClose(ws);
  });

  it('client can interact to resolve pending event in takeover mode', async () => {
    server = createServer(port, logDir, TEST_KEY);
    await server.start();

    const ws = new WebSocket(wsUrl(port, TEST_KEY_B64));
    await waitForMessage(ws, TEST_KEY); // consume initial connected message

    // Switch to takeover mode (encrypted)
    encSend(ws, TEST_KEY, { type: 'takeover' });
    const modeMsg = await waitForMessage(ws, TEST_KEY);
    expect(JSON.parse(modeMsg).mode).toBe('takeover');

    // Post a blocking event (PermissionRequest is user interaction) — it will block on waitForResponse
    const event = JSON.stringify({
      session_id: 's1',
      hook_event_name: 'PermissionRequest',
      tool_name: 'Bash',
    });

    // Collect WS messages while the HTTP request is pending
    const messagePromise = new Promise<string>((resolve) => {
      ws.on('message', (data) => {
        try {
          const msg = decRaw(TEST_KEY, data.toString());
          if (JSON.parse(msg).type === 'event') resolve(msg);
        } catch { /* ignore */ }
      });
    });

    // Fire the HTTP request (will block because PreToolUse waits for response in takeover)
    const hookPromise = httpReq(port, 'POST', '/hook', event);

    // Wait for the single WS broadcast (tagged event with event_id)
    const msg = await messagePromise;
    const parsed = JSON.parse(msg);
    expect(parsed.type).toBe('event');
    const eventId = parsed.event.event_id;
    expect(eventId).toBeDefined();

    // Resolve the pending event via WS (encrypted)
    encSend(ws, TEST_KEY, {
      type: 'interact',
      sessionId: 's1',
      eventId,
      response: { decision: 'allow' },
    });

    // Hook should return the response
    const hookRes = await hookPromise;
    expect(hookRes.status).toBe(200);
    const hookBody = JSON.parse(hookRes.body);
    expect(hookBody).toEqual({ decision: 'allow' });

    ws.close();
    await waitForClose(ws);
  });

  it('client disconnecting in takeover mode preserves mode', async () => {
    server = createServer(port, logDir, TEST_KEY);
    await server.start();

    const ws1 = new WebSocket(wsUrl(port, TEST_KEY_B64));
    await waitForMessage(ws1, TEST_KEY); // consume initial connected message

    // Switch to takeover (encrypted)
    encSend(ws1, TEST_KEY, { type: 'takeover' });
    const modeMsg = await waitForMessage(ws1, TEST_KEY);
    expect(JSON.parse(modeMsg).mode).toBe('takeover');

    // Disconnect client
    ws1.close();
    await waitForClose(ws1);

    // New client connects — mode should still be takeover (global, persists across refresh)
    const ws2 = new WebSocket(wsUrl(port, TEST_KEY_B64));
    const msg = await waitForMessage(ws2, TEST_KEY);
    const parsed = JSON.parse(msg);
    expect(parsed.mode).toBe('takeover');

    ws2.close();
    await waitForClose(ws2);
  });

  it('request_sessions client message sends session list', async () => {
    server = createServer(port, logDir, TEST_KEY);
    await server.start();

    const ws = new WebSocket(wsUrl(port, TEST_KEY_B64));
    await waitForMessage(ws, TEST_KEY); // consume initial connected message

    // Register a session by posting a Notification event
    const event = JSON.stringify({
      session_id: 's1',
      hook_event_name: 'Notification',
    });
    const [, messages] = await Promise.all([
      httpReq(port, 'POST', '/hook', event),
      collectMessages(ws, 2, 3000, TEST_KEY),
    ]);
    // First broadcast is session_start (new session auto-registration), then event
    expect(JSON.parse(messages[0]).type).toBe('session_start');
    expect(JSON.parse(messages[1]).type).toBe('event');

    // Request sessions (encrypted)
    encSend(ws, TEST_KEY, { type: 'request_sessions' });

    const msg = await waitForMessage(ws, TEST_KEY);
    const parsed = JSON.parse(msg);
    expect(parsed.type).toBe('connected');
    expect(parsed.sessions.length).toBe(1);
    expect(parsed.sessions[0].id).toBe('s1');

    ws.close();
    await waitForClose(ws);
  });

  it('release client message switches to bystander mode', async () => {
    server = createServer(port, logDir, TEST_KEY);
    await server.start();

    const ws = new WebSocket(wsUrl(port, TEST_KEY_B64));
    await waitForMessage(ws, TEST_KEY); // consume initial connected message

    // Switch to takeover (encrypted)
    encSend(ws, TEST_KEY, { type: 'takeover' });
    const takeoverMsg = await waitForMessage(ws, TEST_KEY);
    expect(JSON.parse(takeoverMsg).mode).toBe('takeover');

    // Switch back to bystander (encrypted)
    encSend(ws, TEST_KEY, { type: 'release' });
    const releaseMsg = await waitForMessage(ws, TEST_KEY);
    expect(JSON.parse(releaseMsg).type).toBe('mode_changed');
    expect(JSON.parse(releaseMsg).mode).toBe('bystander');

    ws.close();
    await waitForClose(ws);
  });

  it('pending interactions preserved across client disconnect and reconnect', async () => {
    server = createServer(port, logDir, TEST_KEY);
    await server.start();

    const ws1 = new WebSocket(wsUrl(port, TEST_KEY_B64));
    await waitForMessage(ws1, TEST_KEY); // consume initial connected message

    // Switch to takeover mode (encrypted)
    encSend(ws1, TEST_KEY, { type: 'takeover' });
    const modeMsg = await waitForMessage(ws1, TEST_KEY);
    expect(JSON.parse(modeMsg).mode).toBe('takeover');

    // Post a blocking event — it will stay pending
    const event = JSON.stringify({
      session_id: 's1',
      hook_event_name: 'PermissionRequest',
      tool_name: 'Bash',
    });

    const eventPromise = new Promise<string>((resolve) => {
      ws1.on('message', (data) => {
        try {
          const msg = decRaw(TEST_KEY, data.toString());
          if (JSON.parse(msg).type === 'event') resolve(msg);
        } catch { /* ignore */ }
      });
    });

    // Fire the HTTP request (will block because takeover + PermissionRequest)
    const hookPromise = httpReq(port, 'POST', '/hook', event);

    const msg = await eventPromise;
    const eventId = JSON.parse(msg).event.event_id;
    expect(eventId).toBeDefined();

    // Disconnect client WITHOUT resolving the pending event
    ws1.close();
    await waitForClose(ws1);

    // Hook should still be pending (not resolved with {})
    // Give it a moment to ensure no premature resolution
    const raceResult = await Promise.race([
      hookPromise.then(() => 'resolved'),
      new Promise<string>((resolve) => setTimeout(() => resolve('pending'), 200)),
    ]);
    expect(raceResult).toBe('pending');

    // Reconnect with a new client
    const ws2 = new WebSocket(wsUrl(port, TEST_KEY_B64));
    const connectMsg = await waitForMessage(ws2, TEST_KEY);
    const connectParsed = JSON.parse(connectMsg);
    expect(connectParsed.mode).toBe('takeover');

    // pendingInteractions should contain the blocking event
    expect(connectParsed.pendingInteractions).toHaveLength(1);
    expect(connectParsed.pendingInteractions[0].sessionId).toBe('s1');
    expect(connectParsed.pendingInteractions[0].eventId).toBe(eventId);

    // Now resolve it via the reconnected client (encrypted)
    encSend(ws2, TEST_KEY, {
      type: 'interact',
      sessionId: 's1',
      eventId,
      response: { decision: 'allow' },
    });

    // Hook should finally resolve
    const hookRes = await hookPromise;
    expect(hookRes.status).toBe(200);
    expect(JSON.parse(hookRes.body)).toEqual({ decision: 'allow' });

    ws2.close();
    await waitForClose(ws2);
  });

  it('POST /hook returns non-blocking response in bystander mode', async () => {
    server = createServer(port, logDir, TEST_KEY);
    await server.start();

    // Post a category-1 event (PreToolUse) — in bystander mode should return {} immediately
    const event = JSON.stringify({
      session_id: 's1',
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
    });
    const res = await httpReq(port, 'POST', '/hook', event);

    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({});
  });
});
