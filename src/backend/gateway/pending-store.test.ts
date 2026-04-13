import { describe, it, expect, vi } from 'vitest';
import { PendingStore } from './pending-store.js';
import type { InteractionResponse, SSEHookEvent } from '../../shared/protocol.js';

function makeEvent(): SSEHookEvent {
  return { session_id: 's1', event_name: 'PermissionRequest' };
}

describe('PendingStore', () => {
  it('waitForResponse returns a promise that resolves when resolve() is called', async () => {
    const store = new PendingStore();
    const promise = store.waitForResponse('session-1', 'event-1', makeEvent());

    // Promise should be pending
    let resolved = false;
    promise.then(() => { resolved = true; });

    // Not resolved yet
    await Promise.resolve();
    expect(resolved).toBe(false);

    // Now resolve it
    store.resolve('session-1', 'event-1', { decision: 'allow' });
    const result = await promise;
    expect(result).toEqual({ decision: 'allow' });
  });

  it('resolve with specific response data', async () => {
    const store = new PendingStore();
    const promise = store.waitForResponse('s1', 'e1', makeEvent());

    const response: InteractionResponse = { decision: 'deny', reason: 'unsafe' };
    store.resolve('s1', 'e1', response);

    const result = await promise;
    expect(result).toEqual({ decision: 'deny', reason: 'unsafe' });
  });

  it('resolve with unknown sessionId/eventId is no-op', () => {
    const store = new PendingStore();
    // Should not throw
    expect(() => store.resolve('unknown', 'unknown', {})).not.toThrow();
  });

  it('releaseAll resolves all pending with {}', async () => {
    const store = new PendingStore();
    const p1 = store.waitForResponse('s1', 'e1', makeEvent());
    const p2 = store.waitForResponse('s1', 'e2', makeEvent());
    const p3 = store.waitForResponse('s2', 'e1', makeEvent());

    store.releaseAll();

    await expect(p1).resolves.toEqual({});
    await expect(p2).resolves.toEqual({});
    await expect(p3).resolves.toEqual({});

    // All entries should be cleared
    expect(store.has('s1', 'e1')).toBe(false);
    expect(store.has('s1', 'e2')).toBe(false);
    expect(store.has('s2', 'e1')).toBe(false);
  });

  it('releaseSession resolves only that session\'s pending', async () => {
    const store = new PendingStore();
    const p1 = store.waitForResponse('s1', 'e1', makeEvent());
    const p2 = store.waitForResponse('s1', 'e2', makeEvent());
    const p3 = store.waitForResponse('s2', 'e1', makeEvent());

    store.releaseSession('s1');

    // s1 promises resolved with {}
    await expect(p1).resolves.toEqual({});
    await expect(p2).resolves.toEqual({});

    // s2 promise is still pending
    expect(store.has('s2', 'e1')).toBe(true);

    // Resolve s2 normally
    store.resolve('s2', 'e1', { ok: true });
    await expect(p3).resolves.toEqual({ ok: true });
  });

  it('has returns correct boolean', () => {
    const store = new PendingStore();

    expect(store.has('s1', 'e1')).toBe(false);

    store.waitForResponse('s1', 'e1', makeEvent());
    expect(store.has('s1', 'e1')).toBe(true);

    store.resolve('s1', 'e1', {});
    expect(store.has('s1', 'e1')).toBe(false);
  });

  it('multiple sessions can have pending events simultaneously', async () => {
    const store = new PendingStore();

    const p1 = store.waitForResponse('s1', 'e1', makeEvent());
    const p2 = store.waitForResponse('s2', 'e1', makeEvent());
    const p3 = store.waitForResponse('s3', 'e1', makeEvent());

    expect(store.has('s1', 'e1')).toBe(true);
    expect(store.has('s2', 'e1')).toBe(true);
    expect(store.has('s3', 'e1')).toBe(true);

    store.resolve('s1', 'e1', { from: 's1' });
    store.resolve('s3', 'e1', { from: 's3' });

    await expect(p1).resolves.toEqual({ from: 's1' });
    await expect(p3).resolves.toEqual({ from: 's3' });

    // s2 still pending
    expect(store.has('s2', 'e1')).toBe(true);

    store.resolve('s2', 'e1', { from: 's2' });
    await expect(p2).resolves.toEqual({ from: 's2' });
  });

  it('waitForResponse called twice with same key overwrites previous resolve', async () => {
    const store = new PendingStore();

    // Use a settled check to detect the overwritten promise
    const overwritten = store.waitForResponse('s1', 'e1', makeEvent());
    const active = store.waitForResponse('s1', 'e1', makeEvent());

    // Resolve the active one
    store.resolve('s1', 'e1', { version: 2 });
    await expect(active).resolves.toEqual({ version: 2 });

    // The overwritten promise should never resolve (we just confirm has returns false)
    expect(store.has('s1', 'e1')).toBe(false);
  });

  it('releaseSession is no-op if session not found', () => {
    const store = new PendingStore();
    expect(() => store.releaseSession('nonexistent')).not.toThrow();
  });
});
