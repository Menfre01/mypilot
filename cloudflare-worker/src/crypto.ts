import type { EncryptedEnvelope } from './protocol';

const keyCache = new Map<string, CryptoKey>();

function base64Encode(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64Decode(s: string): Uint8Array {
  const binary = atob(s);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

// Extract a standalone ArrayBuffer from a Uint8Array (avoids shared buffer issues)
function toBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

export async function importKey(keyB64: string): Promise<CryptoKey> {
  const cached = keyCache.get(keyB64);
  if (cached) return cached;

  const keyBytes = base64Decode(keyB64);
  const key = await crypto.subtle.importKey(
    'raw',
    toBuffer(keyBytes),
    { name: 'AES-GCM' },
    false,
    ['encrypt', 'decrypt'],
  );
  keyCache.set(keyB64, key);
  return key;
}

export async function encrypt(key: CryptoKey, plaintext: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(plaintext);
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: toBuffer(iv) },
    key,
    encoded,
  );
  const envelope: EncryptedEnvelope = {
    iv: base64Encode(iv),
    data: base64Encode(new Uint8Array(encrypted)),
  };
  return JSON.stringify(envelope);
}

export async function decrypt(key: CryptoKey, envelopeJson: string): Promise<string> {
  const envelope: EncryptedEnvelope = JSON.parse(envelopeJson);
  const iv = base64Decode(envelope.iv);
  const data = base64Decode(envelope.data);
  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: toBuffer(iv) },
    key,
    toBuffer(data),
  );
  return new TextDecoder().decode(decrypted);
}
