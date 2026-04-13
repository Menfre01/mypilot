import { describe, it, expect, vi } from 'vitest';
import { displayConnectionInfo } from './qr-display.js';

describe('qr-display', () => {
  it('calls console.log with connection info', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    displayConnectionInfo('192.168.1.100', 16321, 'test-token');

    const output = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(output).toContain('192.168.1.100:16321');
    expect(output).toContain('test-token');

    logSpy.mockRestore();
  });
});
