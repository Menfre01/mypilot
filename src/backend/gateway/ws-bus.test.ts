import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { WebSocket } from 'ws';
import { WsBus } from './ws-bus.js';
import type { SessionInfo, GatewayMessage, ClientMessage } from '../../shared/protocol.js';
import { waitForOpen, waitForMessage, waitForClose, collectMessages, encSend, wsUrl } from './ws-test-helpers.js';

const TEST_KEY = randomBytes(32);
const TEST_KEY_B64 = TEST_KEY.toString('base64');

describe('WsBus', () => {
  let httpServer: ReturnType<typeof createServer>;
  let bus: WsBus;
  let port: number;

  beforeEach(async () => {
    httpServer = createServer();
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));
    port = (httpServer.address() as any).port;
    bus = new WsBus(TEST_KEY);
  });

  afterEach(async () => {
    // Close bus first — wait for WebSocketServer to fully shut down
    await bus.close();
    // Force-close all connections on the HTTP server
    httpServer.closeAllConnections();
    // Close the HTTP server and wait for it to fully shut down
    await new Promise<void>((resolve) => {
      httpServer.close(() => resolve());
      // Safety timeout: force-resolve after 2s
      setTimeout(() => {
        httpServer.closeAllConnections();
        resolve();
      }, 2000);
    });
  });

  it('client connects and receives session list via onConnect handler', async () => {
    const sessions: SessionInfo[] = [
      { id: 's1', color: '#89b4fa', colorIndex: 0, startedAt: Date.now() },
    ];

    bus.onConnect(() => {
      bus.sendSessionList(sessions, 'bystander');
    });
    bus.attach(httpServer);

    const ws = new WebSocket(wsUrl(port, TEST_KEY_B64));
    const msg = await waitForMessage(ws, TEST_KEY);
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

  it('rejects connection without key', async () => {
    bus.attach(httpServer);

    const ws = new WebSocket(`ws://localhost:${port}/ws-gateway`);
    await new Promise<void>((resolve) => {
      ws.on('error', () => {});
      ws.on('close', () => resolve());
    });
    expect(ws.readyState).toBe(ws.CLOSED);
  });

  it('rejects connection with wrong key', async () => {
    bus.attach(httpServer);

    const wrongKey = randomBytes(32).toString('base64');
    const ws = new WebSocket(wsUrl(port, wrongKey));
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

    bus.attach(httpServer);

    const ws = new WebSocket(wsUrl(port, TEST_KEY_B64));
    await waitForOpen(ws);

    bus.sendSessionList(sessions, 'takeover');

    const msg = await waitForMessage(ws, TEST_KEY);
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

    bus.attach(httpServer);

    const ws = new WebSocket(wsUrl(port, TEST_KEY_B64));
    await waitForOpen(ws);

    bus.broadcast(message);

    const msg = await waitForMessage(ws, TEST_KEY);
    expect(JSON.parse(msg)).toEqual(message);

    ws.close();
    await waitForClose(ws);
  });

  it('broadcast is no-op when no client', () => {
    bus.attach(httpServer);
    const message: GatewayMessage = { type: 'mode_changed', mode: 'takeover' };
    expect(() => bus.broadcast(message)).not.toThrow();
  });

  it('onMessage receives parsed client messages', async () => {
    const received: ClientMessage[] = [];
    bus.onMessage((msg) => received.push(msg));

    bus.attach(httpServer);

    const ws = new WebSocket(wsUrl(port, TEST_KEY_B64));
    await waitForOpen(ws);

    const clientMsg: ClientMessage = { type: 'takeover' };
    encSend(ws, TEST_KEY, clientMsg);

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual(clientMsg);

    ws.close();
    await waitForClose(ws);
  });

  it('onDisconnect fires when client disconnects', async () => {
    let disconnected = false;
    bus.onDisconnect(() => { disconnected = true; });

    bus.attach(httpServer);

    const ws = new WebSocket(wsUrl(port, TEST_KEY_B64));
    await waitForOpen(ws);

    ws.close();
    await waitForClose(ws);

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(disconnected).toBe(true);
  });

  it('disconnect() closes client connection', async () => {
    bus.attach(httpServer);

    const ws = new WebSocket(wsUrl(port, TEST_KEY_B64));
    await waitForOpen(ws);

    expect(bus.hasClient()).toBe(true);

    bus.disconnect();
    await waitForClose(ws);

    expect(bus.hasClient()).toBe(false);
  });

  it('hasClient returns correct state', async () => {
    expect(bus.hasClient()).toBe(false);

    bus.attach(httpServer);
    expect(bus.hasClient()).toBe(false);

    const ws = new WebSocket(wsUrl(port, TEST_KEY_B64));
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
      bus.attach(httpServer);

      // Queue messages while offline
      bus.broadcast({ type: 'mode_changed', mode: 'takeover' });
      bus.broadcast({ type: 'mode_changed', mode: 'bystander' });

      // onConnect calls sendSessionList (like the real server does),
      // which clears the queue and sends the connected message instead.
      bus.onConnect(() => {
        bus.sendSessionList([], 'bystander', []);
      });

      const ws = new WebSocket(wsUrl(port, TEST_KEY_B64));
      const messagesPromise = collectMessages(ws, 1, 3000, TEST_KEY);

      await waitForOpen(ws);
      const messages = await messagesPromise;

      // Only the connected message, no stale queue items
      expect(messages).toHaveLength(1);
      expect(JSON.parse(messages[0]).type).toBe('connected');

      ws.close();
      await waitForClose(ws);
    });

    it('onConnect handler delivers its messages on reconnect', async () => {
      bus.attach(httpServer);

      const connectMsg: GatewayMessage = { type: 'mode_changed', mode: 'bystander' };
      bus.onConnect(() => bus.broadcast(connectMsg));

      // Connect and disconnect
      const ws1 = new WebSocket(wsUrl(port, TEST_KEY_B64));
      await waitForOpen(ws1);
      ws1.close();
      await waitForClose(ws1);
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Queue while offline
      const message: GatewayMessage = { type: 'mode_changed', mode: 'takeover' };
      bus.broadcast(message);

      // Reconnect — onConnect fires, its message is delivered;
      // queued message was superseded by the connect handler.
      const ws2 = new WebSocket(wsUrl(port, TEST_KEY_B64));
      const messagesPromise = collectMessages(ws2, 1, 3000, TEST_KEY);

      await waitForOpen(ws2);
      const messages = await messagesPromise;

      expect(messages).toHaveLength(1);
      expect(JSON.parse(messages[0])).toEqual(connectMsg);

      ws2.close();
      await waitForClose(ws2);
    });

    it('handles broadcast when no client without throw', () => {
      bus.attach(httpServer);

      // Should not throw, should queue
      expect(() => {
        bus.broadcast({ type: 'mode_changed', mode: 'takeover' });
      }).not.toThrow();
    });
  });

  describe('multi-device support', () => {
    it('allows two devices with different deviceId to connect simultaneously', async () => {
      bus.attach(httpServer);

      const ws1 = new WebSocket(wsUrl(port, TEST_KEY_B64, { deviceId: 'device-A' }));
      const ws2 = new WebSocket(wsUrl(port, TEST_KEY_B64, { deviceId: 'device-B' }));
      await Promise.all([waitForOpen(ws1), waitForOpen(ws2)]);
      // Give server time to register clients
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Both should be tracked
      expect(bus.hasClient()).toBe(true);
      expect(bus.hasClient('device-A')).toBe(true);
      expect(bus.hasClient('device-B')).toBe(true);

      ws1.close();
      ws2.close();
      await Promise.all([waitForClose(ws1), waitForClose(ws2)]);
    }, 15_000);

    it('same deviceId reconnect replaces old connection', async () => {
      bus.attach(httpServer);

      const ws1 = new WebSocket(wsUrl(port, TEST_KEY_B64, { deviceId: 'device-A' }));
      await waitForOpen(ws1);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(bus.hasClient('device-A')).toBe(true);

      // Connect with same deviceId — should replace
      const ws2 = new WebSocket(wsUrl(port, TEST_KEY_B64, { deviceId: 'device-A' }));
      await waitForOpen(ws2);
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Old connection should be closed
      await waitForClose(ws1);

      // New connection should be active
      expect(bus.hasClient('device-A')).toBe(true);
      expect(bus.hasClient()).toBe(true);

      ws2.close();
      await waitForClose(ws2);
    }, 15_000);

    it('broadcast sends to all connected devices', async () => {
      bus.attach(httpServer);

      const ws1 = new WebSocket(wsUrl(port, TEST_KEY_B64, { deviceId: 'device-A' }));
      const ws2 = new WebSocket(wsUrl(port, TEST_KEY_B64, { deviceId: 'device-B' }));
      await Promise.all([waitForOpen(ws1), waitForOpen(ws2)]);

      const message: GatewayMessage = { type: 'mode_changed', mode: 'takeover' };
      bus.broadcast(message);

      const [msg1, msg2] = await Promise.all([
        waitForMessage(ws1, TEST_KEY),
        waitForMessage(ws2, TEST_KEY),
      ]);

      expect(JSON.parse(msg1)).toEqual(message);
      expect(JSON.parse(msg2)).toEqual(message);

      ws1.close();
      ws2.close();
      await Promise.all([waitForClose(ws1), waitForClose(ws2)]);
    }, 15_000);

    it('broadcast with targetDeviceId sends only to that device', async () => {
      bus.attach(httpServer);

      const ws1 = new WebSocket(wsUrl(port, TEST_KEY_B64, { deviceId: 'device-A' }));
      const ws2 = new WebSocket(wsUrl(port, TEST_KEY_B64, { deviceId: 'device-B' }));
      await Promise.all([waitForOpen(ws1), waitForOpen(ws2)]);

      const message: GatewayMessage = { type: 'mode_changed', mode: 'takeover' };
      bus.broadcast(message, 'device-A');

      // device-A should receive the message
      const msg1 = await waitForMessage(ws1, TEST_KEY);
      expect(JSON.parse(msg1)).toEqual(message);

      // device-B should NOT receive any message (timeout with empty result)
      const msgs2 = await collectMessages(ws2, 1, 200, TEST_KEY);
      expect(msgs2).toHaveLength(0);

      ws1.close();
      ws2.close();
      await Promise.all([waitForClose(ws1), waitForClose(ws2)]);
    }, 15_000);

    it('onMessage receives deviceId of sending device', async () => {
      const received: Array<{ msg: ClientMessage; deviceId: string }> = [];
      bus.onMessage((msg, deviceId) => received.push({ msg, deviceId }));

      bus.attach(httpServer);

      const ws1 = new WebSocket(wsUrl(port, TEST_KEY_B64, { deviceId: 'device-A' }));
      const ws2 = new WebSocket(wsUrl(port, TEST_KEY_B64, { deviceId: 'device-B' }));
      await Promise.all([waitForOpen(ws1), waitForOpen(ws2)]);

      encSend(ws1, TEST_KEY, { type: 'takeover' });
      await new Promise((resolve) => setTimeout(resolve, 150));

      encSend(ws2, TEST_KEY, { type: 'release' });
      await new Promise((resolve) => setTimeout(resolve, 150));

      expect(received).toHaveLength(2);
      expect(received[0].msg).toEqual({ type: 'takeover' });
      expect(received[0].deviceId).toBe('device-A');
      expect(received[1].msg).toEqual({ type: 'release' });
      expect(received[1].deviceId).toBe('device-B');

      ws1.close();
      ws2.close();
      await Promise.all([waitForClose(ws1), waitForClose(ws2)]);
    }, 15_000);

    it('onDisconnect fires with correct deviceId', async () => {
      const disconnectedDevices: string[] = [];
      bus.onDisconnect((deviceId) => disconnectedDevices.push(deviceId));

      bus.attach(httpServer);

      const ws1 = new WebSocket(wsUrl(port, TEST_KEY_B64, { deviceId: 'device-A' }));
      const ws2 = new WebSocket(wsUrl(port, TEST_KEY_B64, { deviceId: 'device-B' }));
      await Promise.all([waitForOpen(ws1), waitForOpen(ws2)]);

      ws1.close();
      await waitForClose(ws1);
      // Allow server-side disconnect handler to fire
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(disconnectedDevices).toEqual(['device-A']);
      expect(bus.hasClient('device-A')).toBe(false);
      expect(bus.hasClient('device-B')).toBe(true);

      ws2.close();
      await waitForClose(ws2);
    }, 15_000);

    it('sendSessionList targets specific device when targetDeviceId is given', async () => {
      bus.attach(httpServer);

      const ws1 = new WebSocket(wsUrl(port, TEST_KEY_B64, { deviceId: 'device-A' }));
      const ws2 = new WebSocket(wsUrl(port, TEST_KEY_B64, { deviceId: 'device-B' }));
      await Promise.all([waitForOpen(ws1), waitForOpen(ws2)]);

      const sessions: SessionInfo[] = [
        { id: 's1', color: '#89b4fa', colorIndex: 0, startedAt: 1000 },
      ];

      // Send session list only to device-B
      bus.sendSessionList(sessions, 'takeover', [], [], 'device-B');

      // device-B should receive
      const msg2 = await waitForMessage(ws2, TEST_KEY);
      expect(JSON.parse(msg2)).toEqual({
        type: 'connected',
        sessions,
        mode: 'takeover',
        recentEvents: [],
        pendingInteractions: [],
      });

      // device-A should NOT receive
      const msgs1 = await collectMessages(ws1, 1, 200, TEST_KEY);
      expect(msgs1).toHaveLength(0);

      ws1.close();
      ws2.close();
      await Promise.all([waitForClose(ws1), waitForClose(ws2)]);
    }, 15_000);

    it('disconnect(deviceId) closes specific device only', async () => {
      bus.attach(httpServer);

      const ws1 = new WebSocket(wsUrl(port, TEST_KEY_B64, { deviceId: 'device-A' }));
      const ws2 = new WebSocket(wsUrl(port, TEST_KEY_B64, { deviceId: 'device-B' }));
      await Promise.all([waitForOpen(ws1), waitForOpen(ws2)]);

      bus.disconnect('device-A');
      await waitForClose(ws1);

      expect(bus.hasClient('device-A')).toBe(false);
      expect(bus.hasClient('device-B')).toBe(true);

      // device-B should still receive messages
      const message: GatewayMessage = { type: 'mode_changed', mode: 'takeover' };
      bus.broadcast(message);
      const msg = await waitForMessage(ws2, TEST_KEY);
      expect(JSON.parse(msg)).toEqual(message);

      ws2.close();
      await waitForClose(ws2);
    }, 15_000);

    it('disconnect() without args closes all devices', async () => {
      bus.attach(httpServer);

      const ws1 = new WebSocket(wsUrl(port, TEST_KEY_B64, { deviceId: 'device-A' }));
      const ws2 = new WebSocket(wsUrl(port, TEST_KEY_B64, { deviceId: 'device-B' }));
      await Promise.all([waitForOpen(ws1), waitForOpen(ws2)]);
      await new Promise((resolve) => setTimeout(resolve, 50));

      bus.disconnect();
      await Promise.all([waitForClose(ws1), waitForClose(ws2)]);

      expect(bus.hasClient()).toBe(false);
    }, 15_000);

    it('auto-generates deviceId when not provided (backward compat)', async () => {
      bus.attach(httpServer);

      // Connect without deviceId — should still work
      const ws = new WebSocket(wsUrl(port, TEST_KEY_B64));
      await waitForOpen(ws);
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Should be tracked
      expect(bus.hasClient()).toBe(true);

      ws.close();
      await waitForClose(ws);
    }, 15_000);

    it('two connections without deviceId get separate auto-generated IDs', async () => {
      bus.attach(httpServer);

      const ws1 = new WebSocket(wsUrl(port, TEST_KEY_B64));
      const ws2 = new WebSocket(wsUrl(port, TEST_KEY_B64));

      // Both should connect successfully (auto-generated IDs)
      await Promise.all([waitForOpen(ws1), waitForOpen(ws2)]);
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Both should be tracked (separate auto-generated IDs)
      expect(bus.hasClient()).toBe(true);

      ws1.close();
      ws2.close();
      await Promise.all([waitForClose(ws1), waitForClose(ws2)]);
    }, 15_000);
  });

  describe('heartbeat', () => {
    it('connection stays alive — heartbeat pongs keep socket open', async () => {
      bus.attach(httpServer);

      const ws = new WebSocket(wsUrl(port, TEST_KEY_B64));
      await waitForOpen(ws);

      expect(bus.hasClient()).toBe(true);
      expect(ws.readyState).toBe(ws.OPEN);

      // Send and receive a message to confirm bidirectional communication
      const message: GatewayMessage = { type: 'mode_changed', mode: 'takeover' };
      bus.broadcast(message);
      const msg = await waitForMessage(ws, TEST_KEY);
      expect(JSON.parse(msg)).toEqual(message);

      expect(bus.hasClient()).toBe(true);

      ws.close();
      await waitForClose(ws);
    });

    it('terminates connection that fails pong response', async () => {
      bus.attach(httpServer);

      const ws = new WebSocket(wsUrl(port, TEST_KEY_B64));
      await waitForOpen(ws);
      expect(bus.hasClient()).toBe(true);

      ws.terminate(); // Force close without close frame
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(bus.hasClient()).toBe(false);
    });
  });
});
