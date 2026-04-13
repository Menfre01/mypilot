import qrcode from 'qrcode-terminal';
import type { PairingInfo } from '../../shared/protocol.js';

/**
 * Display QR code and connection info in the terminal.
 */
export function displayConnectionInfo(host: string, port: number, token: string): void {
  const payload: PairingInfo = { h: host, p: port, t: token };
  const data = JSON.stringify(payload);

  console.log('');
  console.log('━━━ Pairing Info ━━━');
  console.log(`  Host:  ${host}:${port}`);
  console.log(`  Token: ${token}`);
  console.log('');

  qrcode.generate(data, { small: true }, (qr: string) => {
    console.log(qr);
    console.log('Scan QR code or enter manually in MyPilot app');
    console.log('');
  });
}
