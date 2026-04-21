import { describe, it, expect, vi } from 'vitest';
import { displayConnectionInfo } from './qr-display.js';
import type { LinkConfig } from '../../shared/protocol.js';

describe('qr-display', () => {
  it('calls console.log with connection info', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const key = Buffer.alloc(32, 0xAB);

    displayConnectionInfo('192.168.1.100', 16321, key);

    const output = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(output).toContain('192.168.1.100:16321');
    expect(output).toContain(key.toString('base64'));

    logSpy.mockRestore();
  });

  it('includes links in QR payload when provided', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const key = Buffer.alloc(32, 0xAB);
    const links: LinkConfig[] = [
      { id: 'lan-default', type: 'lan', label: 'LAN Direct', url: 'ws://192.168.1.100:16321', enabled: true },
      { id: 'tunnel-1', type: 'tunnel', label: 'ngrok', url: 'wss://abc.ngrok-free.app', enabled: true },
    ];

    displayConnectionInfo('192.168.1.100', 16321, key, links);

    const output = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(output).toContain('LAN Direct');
    expect(output).toContain('ngrok');
    expect(output).toContain('wss://abc.ngrok-free.app');

    logSpy.mockRestore();
  });

  it('omits links section when no links provided', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const key = Buffer.alloc(32, 0xAB);

    displayConnectionInfo('192.168.1.100', 16321, key);

    const output = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(output).not.toContain('Links:');

    logSpy.mockRestore();
  });

  it('only shows enabled links', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const key = Buffer.alloc(32, 0xAB);
    const links: LinkConfig[] = [
      { id: 'lan-default', type: 'lan', label: 'LAN Direct', url: 'ws://192.168.1.100:16321', enabled: true },
      { id: 'tunnel-1', type: 'tunnel', label: 'Disabled', url: 'wss://disabled.com', enabled: false },
    ];

    displayConnectionInfo('192.168.1.100', 16321, key, links);

    const output = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(output).toContain('LAN Direct');
    expect(output).not.toContain('Disabled');

    logSpy.mockRestore();
  });
});
