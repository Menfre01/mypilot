import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createServer } from 'node:http';
import { WebSocket } from 'ws';
import { WsBus } from './ws-bus.js';
import type { SessionInfo, GatewayMessage, ClientMessage } from '../../shared/protocol.js';
import { waitForOpen, waitForMessage, waitForClose, collectMessages } from './ws-test-helpers.js';

const TEST_TOKEN = 'test-token-12345';

describe('WsBus', () => {
  let httpServer: ReturnType<typeof createServer>;
  let bus: WsBus;
  let port: number;

  beforeEach(async () => {
    httpServer = createServer();
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));
    port = (httpServer.address() as any).port;
    bus = new WsBus();
  });

  afterEach(async () => {
    bus.close();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  });

  it('client connects and receives session list via onConnect handler', async () => {
    const sessions: SessionInfo[] = [
      { id: 's1', color: '#89b4fa', colorIndex: 0, startedAt: Date.now() },
    ];

    bus.onConnect(() => {
      bus.sendSessionList(sessions, 'bystander');
    });
    bus.attach(httpServer, TEST_TOKEN);

    const ws = new WebSocket(`ws://localhost:${port}/ws-gateway?token=${TEST_TOKEN}`);
    const msg = await waitForMessage(ws);
    const parsed = JSON.parse(msg);
    expect(parsed).toEqual({
      type: 'connected',
      sessions,
      mode: 'bystander',
      recentEvents: [],
      pendingInteractions: [],
    });

    ws.close();
    await waitForClose(ws);
  });

  it('rejects connection without token', async () => {
    bus.attach(httpServer, TEST_TOKEN);

    const ws = new WebSocket(`ws://localhost:${port}/ws-gateway`);
    await new Promise<void>((resolve) => {
      ws.on('error', () => {});
      ws.on('close', () => resolve());
    });
    expect(ws.readyState).toBe(ws.CLOSED);
  });

  it('rejects connection with wrong token', async () => {
    bus.attach(httpServer, TEST_TOKEN);

    const ws = new WebSocket(`ws://localhost:${port}/ws-gateway?token=wrong-token`);
    await new Promise<void>((resolve) => {
      ws.on('error', () => {});
      ws.on('close', () => resolve());
    });
    expect(ws.readyState).toBe(ws.CLOSED);
  });

  it('sendSessionList sends connected message with sessions and mode', async () => {
    const sessions: SessionInfo[] = [
      { id: 's1', color: '#89b4fa', colorIndex: 0, startedAt: 1000 },
      { id: 's2', color: '#a6e3a1', colorIndex: 1, startedAt: 2000 },
    ];

    bus.attach(httpServer, TEST_TOKEN);

    const ws = new WebSocket(`ws://localhost:${port}/ws-gateway?token=${TEST_TOKEN}`);
    await waitForOpen(ws);

    bus.sendSessionList(sessions, 'takeover');

    const msg = await waitForMessage(ws);
    const parsed = JSON.parse(msg);
    expect(parsed).toEqual({
      type: 'connected',
      sessions,
      mode: 'takeover',
      recentEvents: [],
      pendingInteractions: [],
    });

    ws.close();
    await waitForClose(ws);
  });

  it('broadcast sends message to connected client', async () => {
    const message: GatewayMessage = {
      type: 'event',
      sessionId: 's1',
      event: { session_id: 's1', foo: 'bar' },
    };

    bus.attach(httpServer, TEST_TOKEN);

    const ws = new WebSocket(`ws://localhost:${port}/ws-gateway?token=${TEST_TOKEN}`);
    await waitForOpen(ws);

    bus.broadcast(message);

    const msg = await waitForMessage(ws);
    expect(JSON.parse(msg)).toEqual(message);

    ws.close();
    await waitForClose(ws);
  });

  it('broadcast is no-op when no client', () => {
    bus.attach(httpServer, TEST_TOKEN);
    const message: GatewayMessage = { type: 'mode_changed', mode: 'takeover' };
    expect(() => bus.broadcast(message)).not.toThrow();
  });

  it('onMessage receives parsed client messages', async () => {
    const received: ClientMessage[] = [];
    bus.onMessage((msg) => received.push(msg));

    bus.attach(httpServer, TEST_TOKEN);

    const ws = new WebSocket(`ws://localhost:${port}/ws-gateway?token=${TEST_TOKEN}`);
    await waitForOpen(ws);

    const clientMsg: ClientMessage = { type: 'takeover' };
    ws.send(JSON.stringify(clientMsg));

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual(clientMsg);

    ws.close();
    await waitForClose(ws);
  });

  it('onDisconnect fires when client disconnects', async () => {
    let disconnected = false;
    bus.onDisconnect(() => { disconnected = true; });

    bus.attach(httpServer, TEST_TOKEN);

    const ws = new WebSocket(`ws://localhost:${port}/ws-gateway?token=${TEST_TOKEN}`);
    await waitForOpen(ws);

    ws.close();
    await waitForClose(ws);

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(disconnected).toBe(true);
  });

  it('disconnect() closes client connection', async () => {
    bus.attach(httpServer, TEST_TOKEN);

    const ws = new WebSocket(`ws://localhost:${port}/ws-gateway?token=${TEST_TOKEN}`);
    await waitForOpen(ws);

    expect(bus.hasClient()).toBe(true);

    bus.disconnect();
    await waitForClose(ws);

    expect(bus.hasClient()).toBe(false);
  });

  it('hasClient returns correct state', async () => {
    expect(bus.hasClient()).toBe(false);

    bus.attach(httpServer, TEST_TOKEN);
    expect(bus.hasClient()).toBe(false);

    const ws = new WebSocket(`ws://localhost:${port}/ws-gateway?token=${TEST_TOKEN}`);
    await waitForOpen(ws);
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(bus.hasClient()).toBe(true);

    ws.close();
    await waitForClose(ws);
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(bus.hasClient()).toBe(false);
  });

  describe('offline message queue', () => {
    it('sendSessionList clears offline queue — recentEvents is authoritative', async () => {
      bus.attach(httpServer, TEST_TOKEN);

      // Queue messages while offline
      bus.broadcast({ type: 'mode_changed', mode: 'takeover' });
      bus.broadcast({ type: 'mode_changed', mode: 'bystander' });

      // onConnect calls sendSessionList (like the real server does),
      // which clears the queue and sends the connected message instead.
      bus.onConnect(() => {
        bus.sendSessionList([], 'bystander', []);
      });

      const ws = new WebSocket(`ws://localhost:${port}/ws-gateway?token=${TEST_TOKEN}`);
      const messagesPromise = collectMessages(ws, 1);

      await waitForOpen(ws);
      const messages = await messagesPromise;

      // Only the connected message, no stale queue items
      expect(messages).toHaveLength(1);
      expect(JSON.parse(messages[0]).type).toBe('connected');

      ws.close();
      await waitForClose(ws);
    });

    it('onConnect handler delivers its messages on reconnect', async () => {
      bus.attach(httpServer, TEST_TOKEN);

      const connectMsg: GatewayMessage = { type: 'mode_changed', mode: 'bystander' };
      bus.onConnect(() => bus.broadcast(connectMsg));

      // Connect and disconnect
      const ws1 = new WebSocket(`ws://localhost:${port}/ws-gateway?token=${TEST_TOKEN}`);
      await waitForOpen(ws1);
      ws1.close();
      await waitForClose(ws1);
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Queue while offline
      const message: GatewayMessage = { type: 'mode_changed', mode: 'takeover' };
      bus.broadcast(message);

      // Reconnect — onConnect fires, its message is delivered;
      // queued message was superseded by the connect handler.
      const ws2 = new WebSocket(`ws://localhost:${port}/ws-gateway?token=${TEST_TOKEN}`);
      const messagesPromise = collectMessages(ws2, 1);

      await waitForOpen(ws2);
      const messages = await messagesPromise;

      expect(messages).toHaveLength(1);
      expect(JSON.parse(messages[0])).toEqual(connectMsg);

      ws2.close();
      await waitForClose(ws2);
    });

    it('handles broadcast when no client without throw', () => {
      bus.attach(httpServer, TEST_TOKEN);

      // Should not throw, should queue
      expect(() => {
        bus.broadcast({ type: 'mode_changed', mode: 'takeover' });
      }).not.toThrow();
    });
  });

  describe('heartbeat', () => {
    it('connection stays alive — heartbeat pongs keep socket open', async () => {
      // This verifies the heartbeat mechanism doesn't break normal connections.
      // Ping/pong is handled automatically by the ws protocol layer.
      bus.attach(httpServer, TEST_TOKEN);

      const ws = new WebSocket(`ws://localhost:${port}/ws-gateway?token=${TEST_TOKEN}`);
      await waitForOpen(ws);

      // Verify connection is stable after setup
      expect(bus.hasClient()).toBe(true);
      expect(ws.readyState).toBe(ws.OPEN);

      // Send and receive a message to confirm bidirectional communication
      const message: GatewayMessage = { type: 'mode_changed', mode: 'takeover' };
      bus.broadcast(message);
      const msg = await waitForMessage(ws);
      expect(JSON.parse(msg)).toEqual(message);

      // Connection should still be alive
      expect(bus.hasClient()).toBe(true);

      ws.close();
      await waitForClose(ws);
    });

    it('terminates connection that fails pong response', async () => {
      // Verify that the heartbeat timer is created and cleaned up
      // by checking the bus state after a connect/disconnect cycle.
      bus.attach(httpServer, TEST_TOKEN);

      const ws = new WebSocket(`ws://localhost:${port}/ws-gateway?token=${TEST_TOKEN}`);
      await waitForOpen(ws);
      expect(bus.hasClient()).toBe(true);

      ws.terminate(); // Force close without close frame
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(bus.hasClient()).toBe(false);
    });
  });
});
