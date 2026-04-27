# MyPilot Push Relay

Cloudflare Workers service for relaying APNs push notifications.

## Overview

This service acts as a relay between MyPilot Gateway and Apple Push Notification Service (APNs). It allows iOS devices (iPhone and Apple Watch) to receive push notifications when they are disconnected from the Gateway.

```
Gateway → Push Relay → APNs → iPhone / Apple Watch
```

## Plans

| Plan | Push Limit | Price |
|------|------------|-------|
| Free | 100/day | Free |
| Pro | Unlimited | TBD |

## Setup

### 1. Prerequisites

- Cloudflare account
- Apple Developer account
- APNs Auth Key (.p8 file) from Apple Developer portal

### 2. Create KV Namespace

```bash
wrangler kv:namespace create PUSH_KV
```

Copy the output ID to `wrangler.toml`.

### 3. Set Secrets

```bash
wrangler secret put APNS_KEY_ID
wrangler secret put APNS_TEAM_ID
wrangler secret put APNS_KEY
```

- `APNS_KEY_ID`: Apple APNs Key ID (10 characters, e.g., `ABC1234DEF`)
- `APNS_TEAM_ID`: Apple Developer Team ID (10 characters, e.g., `DEF1234ABC`)
- `APNS_KEY`: Content of your .p8 key file (including BEGIN/END lines)

### 4. Deploy

```bash
npm run deploy
```

### 5. Test Health Endpoint

```bash
curl https://your-worker.workers.dev/api/health
# Should return: {"ok":true}
```

## API Endpoints

### Public Endpoints

#### GET /api/health

Health check endpoint.

#### POST /api/register

Register a new account and get API key.

**Request:**
```json
{
  "email": "user@example.com"
}
```

**Response:**
```json
{
  "ok": true,
  "apiKey": "your-api-key",
  "plan": "free",
  "pushLimit": 100,
  "message": "Account created successfully"
}
```

#### GET /api/verify?apiKey=xxx

Verify API key and get account info.

**Response:**
```json
{
  "ok": true,
  "email": "user@example.com",
  "plan": "free",
  "pushCount": 42,
  "pushLimit": 100
}
```

### Authenticated Endpoints

All authenticated endpoints require `apiKey` in request body.

#### POST /api/device/register

Register a device token.

**Request:**
```json
{
  "apiKey": "your-api-key",
  "deviceToken": "apns-device-token",
  "gatewayId": "gateway-id",
  "platform": "ios"
}
```

#### POST /api/push

Send a push notification.

**Request:**
```json
{
  "apiKey": "your-api-key",
  "deviceToken": "apns-device-token",
  "payload": {
    "aps": {
      "alert": { "title": "...", "body": "..." },
      "sound": "default",
      "badge": 1
    },
    "session_id": "...",
    "event_id": "..."
  }
}
```

**Response (limit reached):**
```json
{
  "error": "Push limit reached",
  "limit": 100,
  "plan": "free",
  "upgradeUrl": "/upgrade"
}
```

#### POST /api/device/unregister

Remove a device token.

**Request:**
```json
{
  "apiKey": "your-api-key",
  "deviceToken": "apns-device-token"
}
```

#### GET /api/user/info?apiKey=xxx

Get user account info including today's push count.

**Response:**
```json
{
  "ok": true,
  "email": "user@example.com",
  "plan": "free",
  "pushCount": 42,
  "pushLimit": 100,
  "todayCount": 15,
  "createdAt": 1714000000000
}
```

## Configure Gateway

### 1. Register Account

```bash
# Register and get API key
mypilot push register your-email@example.com

# Or if you already have an API key
mypilot push setup https://your-worker.workers.dev YOUR_API_KEY
```

### 2. Check Status

```bash
mypilot push status
```

### 3. Disable Push

```bash
mypilot push disable
mypilot restart
```

## Rate Limiting

- Free plan: 100 pushes per day
- Pro plan: Unlimited (coming soon)
- Counter resets at midnight UTC

## Troubleshooting

### Push notifications not received

1. Check Gateway push status: `mypilot push status`
2. Verify relay health: `curl https://your-worker.workers.dev/api/health`
3. Check iOS device has notification permission enabled
4. Verify APNs key is valid in Apple Developer portal

### Push limit reached

- Check your daily usage: `mypilot push status`
- Wait until tomorrow for counter reset
- Upgrade to Pro plan (coming soon)

### API Key errors

- Ensure API key is correct
- Check if account exists: `curl https://your-worker.workers.dev/api/verify?apiKey=YOUR_KEY`
