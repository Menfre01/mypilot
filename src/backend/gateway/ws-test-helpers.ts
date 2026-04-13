import { WebSocket } from 'ws';

export function waitForOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
}

export function waitForMessage(ws: WebSocket): Promise<string> {
  return new Promise((resolve) => {
    ws.once('message', (data) => resolve(data.toString()));
  });
}

export function waitForClose(ws: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    if (ws.readyState === ws.CLOSED) return resolve();
    ws.once('close', resolve);
  });
}

export function collectMessages(ws: WebSocket, count: number, timeout = 3000): Promise<string[]> {
  return new Promise((resolve) => {
    const messages: string[] = [];
    const timer = setTimeout(() => resolve(messages), timeout);
    ws.on('message', (data) => {
      messages.push(data.toString());
      if (messages.length >= count) {
        clearTimeout(timer);
        resolve(messages);
      }
    });
  });
}
