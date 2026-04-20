import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ClientMessage, GatewayMessage } from '../../shared/protocol.js';
import { encrypt, decrypt } from './crypto.js';
import { createRelayClient } from './relay-client.js';

// ── Mock WebSocket ─────────────────────────────────────────────────────────────
interface MockWs {
  readyState: number;
  sentMessages: string[];
  on: (event: string, handler: Function) => void;
  _emit: (event: string, ...args: unknown[]) => void;
  send: (data: string) => void;
  close: () => void;
}

function createMockWs(): MockWs {
  const handlers: Record<string, Function[]> = {};
  return {
    readyState: 0,
    sentMessages: [] as string[],
    on(event: string, handler: Function) {
      (handlers[event] ??= []).push(handler);
    },
    _emit(event: string, ...args: unknown[]) {
      if (event === 'open') this.readyState = 1; // WebSocket.OPEN
      (handlers[event] ?? []).forEach((h) => h(...args));
    },
    send(data: string) {
      this.sentMessages.push(data);
    },
    close() {
      this.readyState = 3;
      this._emit('close');
    },
  };
}

describe('createRelayClient', () => {
  // AES-256 requires 32-byte key (32 zero bytes for predictable test output)
  const TEST_KEY = Buffer.alloc(32, 0);

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('connect', () => {
    it('calls wsFactory with correct URL', async () => {
      const mockWs = createMockWs();
      const factory = vi.fn(() => mockWs);

      const client = createRelayClient(factory);
      setTimeout(() => mockWs._emit('open'), 0);
      await client.connect('wss://relay.example.com', 'gw-abc', TEST_KEY);

      expect(factory).toHaveBeenCalledOnce();
      expect(factory).toHaveBeenCalledWith(
        expect.stringContaining('wss://relay.example.com/relay?gatewayId=gw-abc&key='),
      );
    });

    it('resolves when connection opens', async () => {
      const mockWs = createMockWs();
      const factory = () => mockWs;

      const client = createRelayClient(factory);
      setTimeout(() => mockWs._emit('open'), 0);
      await expect(client.connect('wss://relay.example.com', 'gw-abc', TEST_KEY)).resolves.toBeUndefined();
    });

    it('rejects on connection error', async () => {
      const mockWs = createMockWs();
      const factory = () => mockWs;

      const client = createRelayClient(factory);
      setTimeout(() => mockWs._emit('error', new Error('Connection refused')), 0);
      await expect(client.connect('wss://relay.example.com', 'gw-abc', TEST_KEY)).rejects.toThrow('Connection refused');
    });

    it('rejects on connection timeout', async () => {
      const mockWs = createMockWs();
      const factory = () => mockWs;

      const client = createRelayClient(factory);
      // CONNECTION_TIMEOUT_MS = 10_000 in relay-client; use vi.useFakeTimers to advance past it
      vi.useFakeTimers();
      const connectPromise = client.connect('wss://relay.example.com', 'gw-abc', TEST_KEY);
      vi.advanceTimersByTime(10_000);
      vi.useRealTimers();
      await expect(connectPromise).rejects.toThrow('Connection timeout');
    });
  });

  describe('broadcast', () => {
    it('sends encrypted envelope when socket is open', async () => {
      const mockWs = createMockWs();
      const factory = () => mockWs;

      const client = createRelayClient(factory);
      setTimeout(() => mockWs._emit('open'), 0);
      await client.connect('wss://relay.example.com', 'gw-abc', TEST_KEY);

      const msg: GatewayMessage = { type: 'mode_changed', mode: 'takeover' };
      client.broadcast(msg);

      expect(mockWs.sentMessages).toHaveLength(1);
      const sent = JSON.parse(mockWs.sentMessages[0]);
      expect(sent.encrypted).toBeDefined();

      // Verify round-trip
      const plaintext = decrypt(TEST_KEY, sent.encrypted);
      expect(JSON.parse(plaintext)).toEqual(msg);
    });

    it('does not send when socket is not open', async () => {
      const mockWs = createMockWs();
      const factory = () => mockWs;

      const client = createRelayClient(factory);
      // Emit open to resolve connect(), then set to CONNECTING to test guard
      setTimeout(() => mockWs._emit('open'), 0);
      await client.connect('wss://relay.example.com', 'gw-abc', TEST_KEY);
      mockWs.readyState = 0; // CONNECTING

      client.broadcast({ type: 'mode_changed', mode: 'takeover' });

      expect(mockWs.sentMessages).toHaveLength(0);
    });
  });

  describe('onMessage', () => {
    it('calls handler with decrypted ClientMessage', async () => {
      const mockWs = createMockWs();
      const factory = () => mockWs;

      const client = createRelayClient(factory);
      const handler = vi.fn();
      client.onMessage(handler);

      setTimeout(() => mockWs._emit('open'), 0);
      await client.connect('wss://relay.example.com', 'gw-abc', TEST_KEY);

      const clientMsg: ClientMessage = { type: 'takeover' };
      const envelope = encrypt(TEST_KEY, JSON.stringify(clientMsg));

      setTimeout(() => {
        mockWs._emit('message', JSON.stringify({ encrypted: JSON.parse(envelope) }));
      }, 0);

      await new Promise((r) => setTimeout(r, 10));
      expect(handler).toHaveBeenCalledOnce();
      expect(handler).toHaveBeenCalledWith(clientMsg, 'gw-abc');
    });

    it('ignores messages without encrypted field', async () => {
      const mockWs = createMockWs();
      const factory = () => mockWs;

      const client = createRelayClient(factory);
      const handler = vi.fn();
      client.onMessage(handler);

      setTimeout(() => mockWs._emit('open'), 0);
      await client.connect('wss://relay.example.com', 'gw-abc', TEST_KEY);

      setTimeout(() => mockWs._emit('message', 'not json'), 0);
      setTimeout(() => mockWs._emit('message', JSON.stringify({})), 0);
      setTimeout(() => mockWs._emit('message', JSON.stringify({ encrypted: null })), 0);

      await new Promise((r) => setTimeout(r, 10));
      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe('disconnect', () => {
    it('closes the WebSocket', async () => {
      const mockWs = createMockWs();
      const factory = () => mockWs;

      const client = createRelayClient(factory);
      setTimeout(() => mockWs._emit('open'), 0);
      await client.connect('wss://relay.example.com', 'gw-abc', TEST_KEY);

      client.disconnect();

      expect(mockWs.readyState).toBe(3);
    });
  });
});
