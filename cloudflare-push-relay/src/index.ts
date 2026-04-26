export interface Env {
  PUSH_KV: KVNamespace;
  APNS_KEY_ID: string;
  APNS_TEAM_ID: string;
  APNS_KEY: string;
  APNS_TOPIC: string; // Bundle ID, e.g., com.mypilot.app
}

// ── Types ──

interface UserRecord {
  email?: string;
  gatewayId?: string;
  apiKey: string;
  plan: 'free' | 'pro';
  pushCount: number;
  pushLimit: number;
  createdAt: number;
}

interface RegisterRequest {
  email: string;
}

interface AutoRegisterRequest {
  gatewayId: string;
}

interface PushRequest {
  deviceToken: string;
  environment?: string;
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

      if (path === '/api/auto-register' && request.method === 'POST') {
        return await handleAutoRegister(request, env);
      }

      if (path === '/api/upgrade' && request.method === 'POST') {
        return await handleUpgrade(request, env);
      }

      // Registration flow (retained for future paywall)
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

  // Store user (use full KV key in apikey mapping for consistency with auto-register)
  await env.PUSH_KV.put(`user:${email}`, JSON.stringify(user));
  await env.PUSH_KV.put(`apikey:${apiKey}`, `user:${email}`);

  return jsonResponse({
    ok: true,
    apiKey,
    plan: user.plan,
    pushLimit: user.pushLimit,
    message: 'Account created successfully',
  });
}

async function handleAutoRegister(request: Request, env: Env): Promise<Response> {
  const body = (await request.json()) as AutoRegisterRequest;

  if (!body.gatewayId) {
    return jsonResponse({ error: 'gatewayId required' }, 400);
  }

  const gatewayId = body.gatewayId.trim();
  const storageKey = `gw:${gatewayId}`;

  // Check if already registered
  const existingUser = await env.PUSH_KV.get(storageKey, 'json');
  if (existingUser) {
    const user = existingUser as UserRecord;
    return jsonResponse({
      ok: true,
      apiKey: user.apiKey,
      plan: user.plan,
      pushLimit: user.pushLimit,
      message: 'Already registered',
    });
  }

  // Generate API key
  const apiKey = generateApiKey();

  const user: UserRecord = {
    gatewayId,
    apiKey,
    plan: 'free',
    pushCount: 0,
    pushLimit: FREE_PUSH_LIMIT,
    createdAt: Date.now(),
  };

  await env.PUSH_KV.put(storageKey, JSON.stringify(user));
  await env.PUSH_KV.put(`apikey:${apiKey}`, storageKey);

  return jsonResponse({
    ok: true,
    apiKey,
    plan: user.plan,
    pushLimit: user.pushLimit,
    message: 'Auto-registered successfully',
  });
}

async function handleUpgrade(request: Request, env: Env): Promise<Response> {
  const body = (await request.json()) as { apiKey?: string; email?: string };

  if (!body.apiKey) {
    return jsonResponse({ error: 'apiKey required' }, 400);
  }

  const verified = await verifyApiKey(env, body.apiKey);
  if (!verified) {
    return jsonResponse({ error: 'Invalid API key' }, 401);
  }

  const { user, storageKey } = verified;

  if (user.plan === 'pro') {
    return jsonResponse({ ok: true, plan: 'pro', message: 'Already on pro plan' });
  }

  user.plan = 'pro';
  user.pushLimit = Infinity as unknown as number;

  // If email provided, migrate from gw:{gatewayId} to user:{email}
  if (body.email && !user.email) {
    const email = body.email.toLowerCase().trim();
    const newKey = `user:${email}`;
    user.email = email;

    await env.PUSH_KV.put(newKey, JSON.stringify(user));
    await env.PUSH_KV.put(`apikey:${body.apiKey}`, newKey);
    if (storageKey.startsWith('gw:')) {
      await env.PUSH_KV.delete(storageKey);
    }
  } else {
    await env.PUSH_KV.put(storageKey, JSON.stringify(user));
  }

  return jsonResponse({
    ok: true,
    plan: 'pro',
    message: 'Upgraded to pro',
  });
}

async function handleVerify(request: Request, env: Env): Promise<Response> {
  const apiKey = extractApiKey(request);

  if (!apiKey) {
    return jsonResponse({ error: 'Authorization required' }, 401);
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
  const apiKey = extractApiKey(request);
  if (!apiKey) {
    return jsonResponse({ error: 'Authorization required' }, 401);
  }

  const body = (await request.json()) as RegisterDeviceRequest;

  if (!body.deviceToken || !body.gatewayId || !body.platform) {
    return jsonResponse({ error: 'Missing required fields' }, 400);
  }

  const verified = await verifyApiKey(env, apiKey);
  if (!verified) {
    return jsonResponse({ error: 'Invalid API key' }, 401);
  }

  // Store device token
  await env.PUSH_KV.put(
    `token:${body.deviceToken}`,
    JSON.stringify({
      email: verified.user.email,
      gatewayId: verified.user.gatewayId ?? body.gatewayId,
      platform: body.platform,
      registeredAt: Date.now(),
    }),
  );

  return jsonResponse({ ok: true });
}

async function handlePush(request: Request, env: Env): Promise<Response> {
  console.log('[PushRelay] Received push request');
  const apiKey = extractApiKey(request);
  if (!apiKey) {
    return jsonResponse({ error: 'Authorization required' }, 401);
  }

  let body: PushRequest;
  try {
    body = (await request.json()) as PushRequest;
  } catch (e) {
    console.error('[PushRelay] Failed to parse request body:', e);
    return jsonResponse({ error: 'Invalid JSON' }, 400);
  }

  console.log(`[PushRelay] Device token: ${body.deviceToken?.substring(0, 16)}...`);
  console.log(`[PushRelay] Payload: ${JSON.stringify(body.payload?.aps?.alert)}`);

  if (!body.deviceToken || !body.payload) {
    console.log('[PushRelay] Missing required fields');
    return jsonResponse({ error: 'Missing required fields' }, 400);
  }

  const verified = await verifyApiKey(env, apiKey);
  if (!verified) {
    console.log('[PushRelay] Invalid API key');
    return jsonResponse({ error: 'Invalid API key' }, 401);
  }
  const { user, storageKey } = verified;
  console.log(`[PushRelay] User: ${user.email ?? user.gatewayId}, Plan: ${user.plan}`);

  const identity = user.email || user.gatewayId || '';

  // Check push limit for free plan
  if (user.plan === 'free') {
    const today = new Date().toISOString().slice(0, 10);
    const counterKey = `counter:${identity}:${today}`;
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

    // Defer counter increment until after successful APNs push
  }

  // Send push notification via APNs
  const environment = body.environment ?? 'sandbox';
  const result = await sendAPNsPush(env, body.deviceToken, body.payload, environment);

  if (result.ok) {
    user.pushCount++;
    await env.PUSH_KV.put(storageKey, JSON.stringify(user));

    // Increment daily counter only on success
    if (user.plan === 'free') {
      const today = new Date().toISOString().slice(0, 10);
      const counterKey = `counter:${identity}:${today}`;
      const counterData = await env.PUSH_KV.get(counterKey, 'json');
      const count = counterData ? (counterData as { count: number }).count : 0;
      await env.PUSH_KV.put(counterKey, JSON.stringify({ count: count + 1 }), {
        expirationTtl: 86400 * 2,
      });
    }
  } else {
    // Clean up invalid device tokens
    if (result.apnsStatus === 410) {
      console.log('[PushRelay] Device token unregistered (410), removing from KV');
      await env.PUSH_KV.delete(`token:${body.deviceToken}`);
    } else if (result.apnsStatus === 400) {
      console.error('[PushRelay] APNs rejected push (400 BadDeviceToken): %s', result.apnsBody);
    }
  }

  return jsonResponse({
    ok: result.ok,
    sent: result.ok ? 1 : 0,
    apnsStatus: result.apnsStatus,
    apnsBody: result.apnsBody,
  });
}

async function handleDeviceUnregister(request: Request, env: Env): Promise<Response> {
  const apiKey = extractApiKey(request);
  if (!apiKey) {
    return jsonResponse({ error: 'Authorization required' }, 401);
  }

  const body = (await request.json()) as { deviceToken: string };

  if (!body.deviceToken) {
    return jsonResponse({ error: 'Missing required fields' }, 400);
  }

  const verified = await verifyApiKey(env, apiKey);
  if (!verified) {
    return jsonResponse({ error: 'Invalid API key' }, 401);
  }

  // Remove device token
  await env.PUSH_KV.delete(`token:${body.deviceToken}`);

  return jsonResponse({ ok: true });
}

async function handleUserInfo(request: Request, env: Env): Promise<Response> {
  const apiKey = extractApiKey(request);

  if (!apiKey) {
    return jsonResponse({ error: 'Authorization required' }, 401);
  }

  const verified = await verifyApiKey(env, apiKey);
  if (!verified) {
    return jsonResponse({ error: 'Invalid API key' }, 401);
  }

  const { user } = verified;
  const identity = user.email || user.gatewayId || '';

  // Get today's push count
  const today = new Date().toISOString().slice(0, 10);
  const counterKey = `counter:${identity}:${today}`;
  const counterData = await env.PUSH_KV.get(counterKey, 'json');
  const todayCount = counterData ? (counterData as { count: number }).count : 0;

  return jsonResponse({
    ok: true,
    email: user.email,
    gatewayId: user.gatewayId,
    plan: user.plan,
    pushCount: user.pushCount,
    pushLimit: user.pushLimit,
    todayCount,
    createdAt: user.createdAt,
  });
}

// ── Helpers ──

function extractApiKey(request: Request): string | null {
  const auth = request.headers.get('Authorization');
  if (auth?.startsWith('Bearer ')) {
    return auth.slice(7).trim() || null;
  }
  return null;
}

async function verifyApiKey(env: Env, apiKey: string): Promise<{ user: UserRecord; storageKey: string } | null> {
  let storageKey = await env.PUSH_KV.get(`apikey:${apiKey}`);
  if (!storageKey) return null;

  // Backward compat: old format stored plain email, new format stores full KV key
  if (!storageKey.includes(':')) {
    storageKey = `user:${storageKey}`;
  }

  const userData = await env.PUSH_KV.get(storageKey, 'json');
  if (!userData) return null;

  return { user: userData as UserRecord, storageKey };
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
  environment: string,
): Promise<{ ok: boolean; apnsStatus: number; apnsBody: string }> {
  try {
    const jwtToken = await createAPNsJWT(env);

    const isSandbox = environment === 'sandbox';
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

  const headerB64 = toBase64URL(btoa(JSON.stringify(header)));
  const claimsB64 = toBase64URL(btoa(JSON.stringify(claims)));

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

  const signatureB64 = toBase64URL(btoa(String.fromCharCode(...new Uint8Array(signature))));

  return `${message}.${signatureB64}`;
}

function toBase64URL(s: string): string {
  return s.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
