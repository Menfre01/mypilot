import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import { encrypt, decrypt } from './crypto.js';

const KEY = randomBytes(32);

describe('crypto', () => {
  describe('encrypt', () => {
    it('produces valid JSON with iv and data fields', () => {
      const result = encrypt(KEY, '{"type":"event"}');
      const parsed = JSON.parse(result);
      expect(parsed).toHaveProperty('iv');
      expect(parsed).toHaveProperty('data');
      expect(typeof parsed.iv).toBe('string');
      expect(typeof parsed.data).toBe('string');
    });

    it('produces different iv for each call (random nonce)', () => {
      const plaintext = '{"type":"event"}';
      const a = JSON.parse(encrypt(KEY, plaintext));
      const b = JSON.parse(encrypt(KEY, plaintext));
      expect(a.iv).not.toBe(b.iv);
      expect(a.data).not.toBe(b.data);
    });

    it('produces base64-encoded iv (12 bytes)', () => {
      const result = JSON.parse(encrypt(KEY, 'hello'));
      const iv = Buffer.from(result.iv, 'base64');
      expect(iv.length).toBe(12);
    });
  });

  describe('decrypt', () => {
    it('recovers original plaintext', () => {
      const original = '{"type":"connected","sessions":[],"mode":"bystander"}';
      const encrypted = encrypt(KEY, original);
      const decrypted = decrypt(KEY, JSON.parse(encrypted));
      expect(decrypted).toBe(original);
    });

    it('handles empty string', () => {
      const encrypted = encrypt(KEY, '');
      const decrypted = decrypt(KEY, JSON.parse(encrypted));
      expect(decrypted).toBe('');
    });

    it('handles unicode content', () => {
      const original = '{"message":"你好世界 🌍"}';
      const encrypted = encrypt(KEY, original);
      const decrypted = decrypt(KEY, JSON.parse(encrypted));
      expect(decrypted).toBe(original);
    });

    it('handles large payload', () => {
      const events = Array.from({ length: 100 }, (_, i) => ({
        session_id: `s${i}`,
        event_name: 'Notification',
        message: `Event ${i} with some data`.repeat(10),
      }));
      const original = JSON.stringify(events);
      const encrypted = encrypt(KEY, original);
      const decrypted = decrypt(KEY, JSON.parse(encrypted));
      expect(decrypted).toBe(original);
    });
  });

  describe('round-trip with wrong key', () => {
    it('throws on wrong key', () => {
      const wrongKey = randomBytes(32);
      const encrypted = encrypt(KEY, '{"type":"event"}');
      expect(() => decrypt(wrongKey, JSON.parse(encrypted))).toThrow();
    });

    it('throws on tampered data', () => {
      const encrypted = JSON.parse(encrypt(KEY, '{"type":"event"}'));
      // Flip a byte in the data
      const data = Buffer.from(encrypted.data, 'base64');
      data[0] ^= 0xff;
      encrypted.data = data.toString('base64');
      expect(() => decrypt(KEY, encrypted)).toThrow();
    });

    it('throws on tampered iv', () => {
      const encrypted = JSON.parse(encrypt(KEY, '{"type":"event"}'));
      const iv = Buffer.from(encrypted.iv, 'base64');
      iv[0] ^= 0xff;
      encrypted.iv = iv.toString('base64');
      expect(() => decrypt(KEY, encrypted)).toThrow();
    });
  });
});
