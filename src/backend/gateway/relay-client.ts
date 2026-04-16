import type { ClientMessage, GatewayMessage } from '../../shared/protocol.js';

export interface RelayClient {
  connect(relayUrl: string, gatewayId: string, key: Buffer): Promise<void>;
  disconnect(): void;
  onMessage(handler: (msg: ClientMessage, deviceId: string) => void): void;
  broadcast(message: GatewayMessage): void;
}

export function createRelayClient(): RelayClient {
  throw new Error('Relay not implemented');
}
