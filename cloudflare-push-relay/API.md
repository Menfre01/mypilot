# Push Relay API

## Authentication

All authenticated endpoints require an API key passed via the `Authorization` header:

```
Authorization: Bearer <api_key>
```

API keys are generated during user registration (`POST /api/register`).

---

## Endpoints

### `GET /api/health`

Health check. No authentication required.

**Response** `200`

```json
{ "ok": true }
```

---

### `POST /api/register`

Register a new user account. No authentication required.

**Request**

```json
{ "email": "user@example.com" }
```

**Response** `200`

```json
{
  "ok": true,
  "apiKey": "<64-char-hex>",
  "plan": "free",
  "pushLimit": 100,
  "message": "Account created successfully"
}
```

If the account already exists, returns the existing API key:

```json
{
  "ok": true,
  "apiKey": "<64-char-hex>",
  "plan": "free",
  "pushLimit": 100,
  "message": "Account already exists"
}
```

---

### `GET /api/verify`

Verify an API key and retrieve account info.

**Headers**

```
Authorization: Bearer <api_key>
```

**Response** `200`

```json
{
  "ok": true,
  "email": "user@example.com",
  "plan": "free",
  "pushCount": 42,
  "pushLimit": 100
}
```

---

### `POST /api/device/register`

Register a device token for push notifications.

**Headers**

```
Authorization: Bearer <api_key>
```

**Request**

```json
{
  "deviceToken": "<apns_device_token>",
  "gatewayId": "<gateway_identifier>",
  "platform": "ios"
}
```

**Response** `200`

```json
{ "ok": true }
```

---

### `POST /api/push`

Send a push notification via APNs.

**Headers**

```
Authorization: Bearer <api_key>
```

**Request**

```json
{
  "deviceToken": "<apns_device_token>",
  "payload": {
    "aps": {
      "alert": { "title": "Title", "body": "Message" },
      "sound": "default",
      "badge": 1
    },
    "session_id": "<session_id>",
    "event_id": "<event_id>",
    "event_name": "PreToolUse",
    "tool_name": "Bash"
  }
}
```

- `tool_name` is optional.

**Response** `200`

```json
{
  "ok": true,
  "sent": 1,
  "apnsStatus": 200,
  "apnsBody": ""
}
```

---

### `POST /api/device/unregister`

Remove a device token.

**Headers**

```
Authorization: Bearer <api_key>
```

**Request**

```json
{ "deviceToken": "<apns_device_token>" }
```

**Response** `200`

```json
{ "ok": true }
```

---

### `GET /api/user/info`

Get detailed user information including today's push count.

**Headers**

```
Authorization: Bearer <api_key>
```

**Response** `200`

```json
{
  "ok": true,
  "email": "user@example.com",
  "plan": "free",
  "pushCount": 42,
  "pushLimit": 100,
  "todayCount": 5,
  "createdAt": 1713849600000
}
```

---

## Error Responses

All endpoints return errors in this format:

```json
{ "error": "<message>" }
```

| Status | Meaning |
|--------|---------|
| `400` | Missing or invalid request fields |
| `401` | Missing or invalid API key |
| `404` | Resource not found (e.g. user) |
| `429` | Push limit reached (free plan) |
| `500` | Internal server error |

## Rate Limits

| Plan | Daily Push Limit |
|------|-----------------|
| `free` | 100 |
| `pro` | Unlimited |

Rate limit is tracked per day (UTC midnight reset). The counter key expires after 2 days.

When the limit is exceeded:

```json
{
  "error": "Push limit reached",
  "limit": 100,
  "plan": "free",
  "upgradeUrl": "/upgrade"
}
```
