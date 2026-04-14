import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import type { EncryptedEnvelope } from '../../shared/protocol.js';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

/**
 * Encrypt a plaintext string with AES-256-GCM.
 * Returns a JSON string: {"iv":"<base64>","data":"<base64>"}
 * where data contains ciphertext + 16-byte auth tag.
 */
export function encrypt(key: Buffer, plaintext: string): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  return JSON.stringify({
    iv: iv.toString('base64'),
    data: encrypted.toString('base64'),
  });
}

/**
 * Decrypt an AES-256-GCM envelope.
 * Expects {iv: string, data: string} where data is base64(ciphertext + auth tag).
 * Returns the original plaintext string.
 * Throws on auth tag mismatch (wrong key or tampered data).
 */
export function decrypt(key: Buffer, envelope: EncryptedEnvelope): string {
  const iv = Buffer.from(envelope.iv, 'base64');
  const combined = Buffer.from(envelope.data, 'base64');
  const ciphertext = combined.subarray(0, combined.length - AUTH_TAG_LENGTH);
  const authTag = combined.subarray(combined.length - AUTH_TAG_LENGTH);
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]).toString('utf8');
}
