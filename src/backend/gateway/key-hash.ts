import { createHash } from 'node:crypto';

export function deriveKeyIdentifiers(key: Buffer): { gatewayId: string; keyHash: string } {
  const hex = createHash('sha256').update(key).digest('hex');
  return { gatewayId: hex.slice(0, 16), keyHash: hex.slice(0, 32) };
}
