import { WebSocket } from 'ws';
import { encrypt, decrypt } from './crypto.js';

export function waitForOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
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

export function waitForClose(ws: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    if (ws.readyState === ws.CLOSED) return resolve();
    ws.once('close', resolve);
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
