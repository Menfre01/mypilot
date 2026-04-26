import { DEMO_KEY_B64 } from './protocol';
import { DemoGatewayDO } from './demo-gateway';

export { DemoGatewayDO };

interface Env {
  DEMO_GATEWAY: DurableObjectNamespace;
  PUSH_RELAY_URL?: string;
  PUSH_RELAY_API_KEY?: string;
}

function corsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function qrPageHtml(host: string): string {
  const pairingInfo = JSON.stringify({
    h: host,
    p: 443,
    k: DEMO_KEY_B64,
    links: [{
      id: 'tunnel-demo',
      type: 'tunnel',
      label: 'Demo Server',
      url: `wss://${host}`,
      enabled: true,
    }],
  });

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>MyPilot Demo</title>
<script src="https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.min.js"></script>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, sans-serif;
    background: #1e1e2e;
    color: #cdd6f4;
    display: flex;
    justify-content: center;
    align-items: center;
    min-height: 100vh;
  }
  .container {
    text-align: center;
    padding: 32px;
    max-width: 420px;
  }
  h1 {
    font-size: 28px;
    font-weight: 700;
    color: #89b4fa;
    margin-bottom: 8px;
    letter-spacing: -0.5px;
  }
  .subtitle {
    font-size: 15px;
    color: #a6adc8;
    line-height: 1.5;
    margin-bottom: 24px;
  }
  .qr-wrap {
    background: #fff;
    padding: 24px;
    border-radius: 16px;
    display: inline-block;
    margin-bottom: 24px;
    box-shadow: 0 4px 24px rgba(0,0,0,0.3);
  }
  .qr-wrap svg { display: block; }
  .steps {
    text-align: left;
    margin: 0 auto;
    max-width: 320px;
  }
  .steps h2 {
    font-size: 16px;
    color: #89b4fa;
    margin-bottom: 12px;
    font-weight: 600;
  }
  .steps ol {
    padding-left: 20px;
    color: #bac2de;
    font-size: 14px;
    line-height: 1.8;
  }
  .hint {
    margin-top: 24px;
    font-size: 12px;
    color: #585b70;
  }
  .badge {
    display: inline-block;
    background: #313244;
    color: #a6e3a1;
    font-size: 11px;
    padding: 4px 10px;
    border-radius: 6px;
    margin-top: 16px;
    font-weight: 500;
  }
</style>
</head>
<body>
<div class="container">
  <h1>MyPilot Demo</h1>
  <p class="subtitle">Scan this QR code with the MyPilot app to connect to the demo server.</p>
  <div class="qr-wrap" id="qr"></div>
  <div class="steps">
    <h2>How to test</h2>
    <ol>
      <li>Open MyPilot on your iOS device</li>
      <li>Tap the scan button to scan this QR code</li>
      <li>Events will start streaming automatically</li>
      <li>Try responding to permission requests and questions</li>
    </ol>
  </div>
  <span class="badge">Auto-playing simulation</span>
  <p class="hint">This demo server simulates Claude Code events to showcase all MyPilot features.</p>
</div>
<script>
  var data = ${pairingInfo};
  var qr = qrcode(0, 'M');
  qr.addData(JSON.stringify(data));
  qr.make();
  document.getElementById('qr').innerHTML = qr.createSvgTag(6, 0);
</script>
</body>
</html>`;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    // QR code page
    if (url.pathname === '/' || url.pathname === '') {
      const host = request.headers.get('Host') || 'demo.mypilot.dev';
      return new Response(qrPageHtml(host), {
        headers: { 'Content-Type': 'text/html; charset=utf-8', ...corsHeaders() },
      });
    }

    // Pairing endpoint
    if (url.pathname === '/pair') {
      const key = url.searchParams.get('key');
      if (key !== DEMO_KEY_B64) {
        return new Response(JSON.stringify({ ok: false }), {
          status: 403,
          headers: { 'Content-Type': 'application/json', ...corsHeaders() },
        });
      }
      const host = request.headers.get('Host') || 'demo.mypilot.dev';
      return new Response(JSON.stringify({ ok: true, host, port: 443 }), {
        headers: { 'Content-Type': 'application/json', ...corsHeaders() },
      });
    }

    // WebSocket endpoint
    if (url.pathname === '/ws-gateway') {
      const id = env.DEMO_GATEWAY.idFromName('demo');
      const stub = env.DEMO_GATEWAY.get(id);
      return stub.fetch(request);
    }

    return new Response('Not Found', { status: 404, headers: corsHeaders() });
  },
};
