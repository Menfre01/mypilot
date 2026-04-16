import qrcode from 'qrcode-terminal';
import type { PairingInfo, LinkConfig } from '../../shared/protocol.js';

/**
 * Display QR code and connection info in the terminal.
 */
export function displayConnectionInfo(host: string, port: number, key: Buffer, links: LinkConfig[] = []): void {
  const keyB64 = key.toString('base64');
  const enabledLinks = links.filter(l => l.enabled);
  const payload: PairingInfo = {
    h: host,
    p: port,
    k: keyB64,
    links: enabledLinks.length > 0 ? enabledLinks : undefined,
  };
  const data = JSON.stringify(payload);

  console.log('');
  console.log('━━━ Pairing Info ━━━');
  console.log(`  Host: ${host}:${port}`);
  console.log(`  Key:  ${keyB64}`);

  if (enabledLinks.length > 0) {
    console.log('');
    console.log('  Links:');
    for (const link of enabledLinks) {
      console.log(`    [${link.type}] ${link.label}: ${link.url}`);
    }
  }

  console.log('');

  qrcode.generate(data, { small: true }, (qr: string) => {
    console.log(qr);
    console.log('Scan QR code or enter manually in MyPilot app');
    console.log('');
  });
}
