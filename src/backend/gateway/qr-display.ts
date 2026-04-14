import qrcode from 'qrcode-terminal';
import type { PairingInfo } from '../../shared/protocol.js';

/**
 * Display QR code and connection info in the terminal.
 */
export function displayConnectionInfo(host: string, port: number, key: Buffer): void {
  const keyB64 = key.toString('base64');
  const payload: PairingInfo = { h: host, p: port, k: keyB64 };
  const data = JSON.stringify(payload);
  console.log('');
  console.log('━━━ Pairing Info ━━━');
  console.log(`  Host: ${host}:${port}`);
  console.log(`  Key:  ${keyB64}`);
  console.log('');

  qrcode.generate(data, { small: true }, (qr: string) => {
    console.log(qr);
    console.log('Scan QR code or enter manually in MyPilot app');
    console.log('');
  });
}
