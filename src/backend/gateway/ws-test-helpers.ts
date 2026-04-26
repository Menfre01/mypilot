import { WebSocket } from 'ws';
import { encrypt, decrypt } from './crypto.js';

export async function waitForOpen(ws: WebSocket, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`WebSocket open timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    ws.once('open', () => {
      clearTimeout(timer);
      resolve();
    });
    ws.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

export function waitForMessage(ws: WebSocket, key?: Buffer): Promise<string> {
  return new Promise((resolve) => {
    ws.once('message', (data) => {
      const raw = data.toString();
      if (key) {
        resolve(decrypt(key, JSON.parse(raw)));
      } else {
        resolve(raw);
      }
    });
  });
}

export function waitForClose(ws: WebSocket, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    if (ws.readyState === ws.CLOSED) return resolve();
    const timer = setTimeout(() => {
      reject(new Error(`WebSocket close timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    ws.once('close', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

export function collectMessages(ws: WebSocket, count: number, timeout = 3000, key?: Buffer): Promise<string[]> {
  return new Promise((resolve) => {
    const messages: string[] = [];
    const timer = setTimeout(() => resolve(messages), timeout);
    ws.on('message', (data) => {
      const raw = data.toString();
      if (key) {
        messages.push(decrypt(key, JSON.parse(raw)));
      } else {
        messages.push(raw);
      }
      if (messages.length >= count) {
        clearTimeout(timer);
        resolve(messages);
      }
    });
  });
}

export function encSend(ws: WebSocket, key: Buffer, obj: unknown): void {
  ws.send(encrypt(key, JSON.stringify(obj)));
}

export function decRaw(key: Buffer, raw: string): string {
  return decrypt(key, JSON.parse(raw));
}

/** Build WebSocket URL with properly URL-encoded key. */
export function wsUrl(port: number, key: string, extra?: Record<string, string>): string {
  const params = new URLSearchParams({ key, ...extra });
  return `ws://localhost:${port}/ws-gateway?${params.toString()}`;
}
