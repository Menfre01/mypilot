export interface Env {
  PUSH_KV: KVNamespace;
  APNS_KEY_ID: string;
  APNS_TEAM_ID: string;
  APNS_KEY: string;
  APNS_TOPIC: string; // Bundle ID, e.g., com.mypilot.app
  APNS_ENVIRONMENT: string; // "sandbox" or "production"
}

// ── Types ──

interface UserRecord {
  email: string;
  apiKey: string;
  plan: 'free' | 'pro';
  pushCount: number;
  pushLimit: number;
  createdAt: number;
}

interface RegisterRequest {
  email: string;
}

interface PushRequest {
  apiKey: string;
  deviceToken: string;
  payload: {
    aps: {
      alert: { title: string; body: string };
      sound: string;
      badge: number;
    };
    session_id: string;
    event_id: string;
    event_name: string;
    tool_name?: string;
  };
}

interface RegisterDeviceRequest {
  apiKey: string;
  deviceToken: string;
  gatewayId: string;
  platform: string;
}

// ── Constants ──

const FREE_PUSH_LIMIT = 100; // 100 pushes per day for free plan
const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

// ── Main Handler ──

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    try {
      // Public endpoints (no auth required)
      if (path === '/api/health') {
        return jsonResponse({ ok: true });
      }

      // Registration flow
      if (path === '/api/register' && request.method === 'POST') {
        return await handleRegister(request, env);
      }

      if (path === '/api/verify' && request.method === 'GET') {
        return await handleVerify(request, env);
      }

      // Authenticated endpoints
      if (path === '/api/device/register' && request.method === 'POST') {
        return await handleDeviceRegister(request, env);
      }

      if (path === '/api/push' && request.method === 'POST') {
        return await handlePush(request, env);
      }

      if (path === '/api/device/unregister' && request.method === 'POST') {
        return await handleDeviceUnregister(request, env);
      }

      // User info
      if (path === '/api/user/info' && request.method === 'GET') {
        return await handleUserInfo(request, env);
      }

      return jsonResponse({ error: 'Not Found' }, 404);
    } catch (error) {
      console.error('Error:', error);
      return jsonResponse({ error: 'Internal Server Error' }, 500);
    }
  },
};

// ── Handlers ──

async function handleRegister(request: Request, env: Env): Promise<Response> {
  const body = (await request.json()) as RegisterRequest;

  if (!body.email || !body.email.includes('@')) {
    return jsonResponse({ error: 'Valid email required' }, 400);
  }

  const email = body.email.toLowerCase().trim();

  // Check if user already exists
  const existingUser = await env.PUSH_KV.get(`user:${email}`, 'json');
  if (existingUser) {
    const user = existingUser as UserRecord;
    return jsonResponse({
      ok: true,
      apiKey: user.apiKey,
      plan: user.plan,
      pushLimit: user.pushLimit,
      message: 'Account already exists',
    });
  }

  // Generate API key
  const apiKey = generateApiKey();

  // Create user record
  const user: UserRecord = {
    email,
    apiKey,
    plan: 'free',
    pushCount: 0,
    pushLimit: FREE_PUSH_LIMIT,
    createdAt: Date.now(),
  };

  // Store user
  await env.PUSH_KV.put(`user:${email}`, JSON.stringify(user));
  await env.PUSH_KV.put(`apikey:${apiKey}`, email);

  return jsonResponse({
    ok: true,
    apiKey,
    plan: user.plan,
    pushLimit: user.pushLimit,
    message: 'Account created successfully',
  });
}

async function handleVerify(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const apiKey = url.searchParams.get('apiKey');

  if (!apiKey) {
    return jsonResponse({ error: 'API key required' }, 400);
  }

  const email = await env.PUSH_KV.get(`apikey:${apiKey}`);
  if (!email) {
    return jsonResponse({ error: 'Invalid API key' }, 401);
  }

  const userData = await env.PUSH_KV.get(`user:${email}`, 'json');
  if (!userData) {
    return jsonResponse({ error: 'User not found' }, 404);
  }

  const user = userData as UserRecord;
  return jsonResponse({
    ok: true,
    email: user.email,
    plan: user.plan,
    pushCount: user.pushCount,
    pushLimit: user.pushLimit,
  });
}

async function handleDeviceRegister(request: Request, env: Env): Promise<Response> {
  const body = (await request.json()) as RegisterDeviceRequest;

  if (!body.apiKey || !body.deviceToken || !body.gatewayId || !body.platform) {
    return jsonResponse({ error: 'Missing required fields' }, 400);
  }

  // Verify API key
  const user = await verifyApiKey(env, body.apiKey);
  if (!user) {
    return jsonResponse({ error: 'Invalid API key' }, 401);
  }

  // Store device token
  await env.PUSH_KV.put(
    `token:${body.deviceToken}`,
    JSON.stringify({
      email: user.email,
      gatewayId: body.gatewayId,
      platform: body.platform,
      registeredAt: Date.now(),
    }),
  );

  return jsonResponse({ ok: true });
}

async function handlePush(request: Request, env: Env): Promise<Response> {
  console.log('[PushRelay] Received push request');
  let body: PushRequest;
  try {
    body = (await request.json()) as PushRequest;
  } catch (e) {
    console.error('[PushRelay] Failed to parse request body:', e);
    return jsonResponse({ error: 'Invalid JSON' }, 400);
  }

  console.log(`[PushRelay] Device token: ${body.deviceToken?.substring(0, 16)}...`);
  console.log(`[PushRelay] Payload: ${JSON.stringify(body.payload?.aps?.alert)}`);

  if (!body.apiKey || !body.deviceToken || !body.payload) {
    console.log('[PushRelay] Missing required fields');
    return jsonResponse({ error: 'Missing required fields' }, 400);
  }

  // Verify API key
  const user = await verifyApiKey(env, body.apiKey);
  if (!user) {
    console.log('[PushRelay] Invalid API key');
    return jsonResponse({ error: 'Invalid API key' }, 401);
  }
  console.log(`[PushRelay] User: ${user.email}, Plan: ${user.plan}`);

  // Check push limit for free plan
  if (user.plan === 'free') {
    const today = new Date().toISOString().slice(0, 10);
    const counterKey = `counter:${user.email}:${today}`;
    const counterData = await env.PUSH_KV.get(counterKey, 'json');
    const count = counterData ? (counterData as { count: number }).count : 0;

    console.log(`[PushRelay] Today's push count: ${count}/${user.pushLimit}`);

    if (count >= user.pushLimit) {
      console.log('[PushRelay] Push limit reached');
      return jsonResponse({
        error: 'Push limit reached',
        limit: user.pushLimit,
        plan: user.plan,
        upgradeUrl: '/upgrade',
      }, 429);
    }

    // Increment counter
    console.log('[PushRelay] Incrementing counter...');
    await env.PUSH_KV.put(counterKey, JSON.stringify({ count: count + 1 }), {
      expirationTtl: 86400 * 2, // 2 days TTL
    });
    console.log('[PushRelay] Counter incremented');
  }

  // Send push notification via APNs
  const result = await sendAPNsPush(env, body.deviceToken, body.payload);

  if (result.ok) {
    user.pushCount++;
    await env.PUSH_KV.put(`user:${user.email}`, JSON.stringify(user));
  }

  return jsonResponse({
    ok: result.ok,
    sent: result.ok ? 1 : 0,
    apnsStatus: result.apnsStatus,
    apnsBody: result.apnsBody,
  });
}

async function handleDeviceUnregister(request: Request, env: Env): Promise<Response> {
  const body = (await request.json()) as { apiKey: string; deviceToken: string };

  if (!body.apiKey || !body.deviceToken) {
    return jsonResponse({ error: 'Missing required fields' }, 400);
  }

  // Verify API key
  const user = await verifyApiKey(env, body.apiKey);
  if (!user) {
    return jsonResponse({ error: 'Invalid API key' }, 401);
  }

  // Remove device token
  await env.PUSH_KV.delete(`token:${body.deviceToken}`);

  return jsonResponse({ ok: true });
}

async function handleUserInfo(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const apiKey = url.searchParams.get('apiKey');

  if (!apiKey) {
    return jsonResponse({ error: 'API key required' }, 400);
  }

  const user = await verifyApiKey(env, apiKey);
  if (!user) {
    return jsonResponse({ error: 'Invalid API key' }, 401);
  }

  // Get today's push count
  const today = new Date().toISOString().slice(0, 10);
  const counterKey = `counter:${user.email}:${today}`;
  const counterData = await env.PUSH_KV.get(counterKey, 'json');
  const todayCount = counterData ? (counterData as { count: number }).count : 0;

  return jsonResponse({
    ok: true,
    email: user.email,
    plan: user.plan,
    pushCount: user.pushCount,
    pushLimit: user.pushLimit,
    todayCount,
    createdAt: user.createdAt,
  });
}

// ── Helpers ──

async function verifyApiKey(env: Env, apiKey: string): Promise<UserRecord | null> {
  const email = await env.PUSH_KV.get(`apikey:${apiKey}`);
  if (!email) return null;

  const userData = await env.PUSH_KV.get(`user:${email}`, 'json');
  if (!userData) return null;

  return userData as UserRecord;
}

function generateApiKey(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...CORS_HEADERS,
    },
  });
}

async function sendAPNsPush(
  env: Env,
  deviceToken: string,
  payload: PushRequest['payload'],
): Promise<{ ok: boolean; apnsStatus: number; apnsBody: string }> {
  try {
    const jwtToken = await createAPNsJWT(env);

    const isSandbox = env.APNS_ENVIRONMENT === 'sandbox';
    const apnsHost = isSandbox
      ? 'https://api.development.push.apple.com'
      : 'https://api.push.apple.com';
    const apnsUrl = `${apnsHost}/3/device/${deviceToken}`;

    const response = await fetch(apnsUrl, {
      method: 'POST',
      headers: {
        authorization: `bearer ${jwtToken}`,
        'apns-topic': env.APNS_TOPIC,
        'apns-push-type': 'alert',
        'apns-priority': '10',
        'content-type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    const responseBody = await response.text();
    console.log(`[APNs] status=${response.status} body=${responseBody}`);

    return { ok: response.ok, apnsStatus: response.status, apnsBody: responseBody };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error('[APNs] Push failed:', msg);
    return { ok: false, apnsStatus: 0, apnsBody: msg };
  }
}

async function createAPNsJWT(env: Env): Promise<string> {
  const now = Math.floor(Date.now() / 1000);

  const header = { alg: 'ES256', kid: env.APNS_KEY_ID };
  const claims = { iss: env.APNS_TEAM_ID, iat: now };

  const headerB64 = btoa(JSON.stringify(header))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  const claimsB64 = btoa(JSON.stringify(claims))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

  const message = `${headerB64}.${claimsB64}`;

  const keyData = env.APNS_KEY.replace(/-----BEGIN PRIVATE KEY-----/, '')
    .replace(/-----END PRIVATE KEY-----/, '')
    .replace(/\s/g, '');
  const keyBytes = Uint8Array.from(atob(keyData), (c) => c.charCodeAt(0));

  const privateKey = await crypto.subtle.importKey(
    'pkcs8',
    keyBytes,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  );

  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    privateKey,
    new TextEncoder().encode(message),
  );

  const signatureB64 = btoa(String.fromCharCode(...new Uint8Array(signature)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

  return `${message}.${signatureB64}`;
}
