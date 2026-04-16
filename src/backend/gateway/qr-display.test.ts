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

  it('includes enabled links in output', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const key = Buffer.alloc(32, 0xAB);
    const links: LinkConfig[] = [
      { id: 'lan-default', type: 'lan', label: 'LAN Direct', url: 'ws://192.168.1.100:16321', enabled: true },
      { id: 'tunnel-1', type: 'tunnel', label: 'ngrok', url: 'wss://abc.ngrok-free.app', enabled: true },
    ];

    displayConnectionInfo('192.168.1.100', 16321, key, links);

    const output = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(output).toContain('Links:');
    expect(output).toContain('[lan] LAN Direct: ws://192.168.1.100:16321');
    expect(output).toContain('[tunnel] ngrok: wss://abc.ngrok-free.app');

    logSpy.mockRestore();
  });

  it('excludes disabled links from output', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const key = Buffer.alloc(32, 0xAB);
    const links: LinkConfig[] = [
      { id: 'lan-default', type: 'lan', label: 'LAN Direct', url: 'ws://192.168.1.100:16321', enabled: true },
      { id: 'tunnel-1', type: 'tunnel', label: 'ngrok', url: 'wss://abc.ngrok-free.app', enabled: false },
    ];

    displayConnectionInfo('192.168.1.100', 16321, key, links);

    const output = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(output).toContain('[lan] LAN Direct: ws://192.168.1.100:16321');
    expect(output).not.toContain('[tunnel] ngrok: wss://abc.ngrok-free.app');

    logSpy.mockRestore();
  });

  it('generates QR payload with links when provided', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const key = Buffer.alloc(32, 0xAB);
    const links: LinkConfig[] = [
      { id: 'lan-default', type: 'lan', label: 'LAN Direct', url: 'ws://192.168.1.100:16321', enabled: true },
    ];

    displayConnectionInfo('192.168.1.100', 16321, key, links);

    // Verify links are shown in the output
    const output = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(output).toContain('[lan] LAN Direct: ws://192.168.1.100:16321');

    logSpy.mockRestore();
  });
});
