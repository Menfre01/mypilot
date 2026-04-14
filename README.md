# MyPilot

Gateway server for [MyPilot](https://apps.apple.com/app/mypilot) — the iOS remote interaction console for Claude Code.

MyPilot receives Claude Code hook events and streams them to your iPhone via WebSocket. In takeover mode, you can approve/deny permissions, answer questions, and submit prompts from your phone.

## Requirements

- **Node.js** >= 20
- **iPhone** with the MyPilot app installed ([App Store](https://apps.apple.com/app/mypilot))
- **Claude Code** CLI

## Quick Start

```bash
# 1. Install
npm install -g mypilot

# 2. Configure Claude Code hooks
mypilot init-hooks

# 3. Start the gateway
mypilot gateway
```

Scan the QR code displayed in your terminal with the MyPilot app on your iPhone.

## Architecture

```
Claude Code ──(command hook / curl)──▶ Gateway (:16321)
                                        ├── POST /hook         ← hook event endpoint
                                        ├── GET  /pair         ← token validation
                                        └── WS   /ws-gateway   ← WebSocket to MyPilot app
```

## CLI Commands

```bash
mypilot gateway     # Start the Gateway server (foreground)
mypilot status      # Check Gateway status (PID, port)
mypilot init-hooks  # Configure Claude Code hooks (auto-merge into ~/.claude/settings.json)
mypilot pair-info              # Show pairing info (IP + QR code) for reconnecting
mypilot pair-info my.domain.com     # Use custom domain (NAT traversal), port defaults to 443
mypilot pair-info my.domain.com:8080    # Custom domain with port
```

## Hook Configuration

Run `mypilot init-hooks` to automatically configure all required hooks. The command:

- **Preserves** your existing hooks — only adds missing entries
- **Prompts** for confirmation before modifying `~/.claude/settings.json`
- Configures both blocking events (with timeout) and informational events

<details>
<summary>Manual configuration (advanced)</summary>

If you prefer to configure hooks manually, add the following to the `hooks` field in `~/.claude/settings.json`:

```json
{
  "hooks": {
    "PreToolUse": [{"matcher": "", "hooks": [{"type": "command", "command": "curl --noproxy localhost --noproxy 127.0.0.1 -s -X POST 'http://127.0.0.1:16321/hook' -H 'Content-Type: application/json' -d @-", "timeout": 999999}]}],
    "PostToolUse": [{"matcher": "", "hooks": [{"type": "command", "command": "curl --noproxy localhost --noproxy 127.0.0.1 -s -X POST 'http://127.0.0.1:16321/hook' -H 'Content-Type: application/json' -d @-"}]}],
    "PostToolUseFailure": [{"matcher": "", "hooks": [{"type": "command", "command": "curl --noproxy localhost --noproxy 127.0.0.1 -s -X POST 'http://127.0.0.1:16321/hook' -H 'Content-Type: application/json' -d @-"}]}],
    "PermissionRequest": [{"matcher": "", "hooks": [{"type": "command", "command": "curl --noproxy localhost --noproxy 127.0.0.1 -s -X POST 'http://127.0.0.1:16321/hook' -H 'Content-Type: application/json' -d @-", "timeout": 999999}]}],
    "UserPromptSubmit": [{"matcher": "", "hooks": [{"type": "command", "command": "curl --noproxy localhost --noproxy 127.0.0.1 -s -X POST 'http://127.0.0.1:16321/hook' -H 'Content-Type: application/json' -d @-", "timeout": 999999}]}],
    "Elicitation": [{"matcher": "", "hooks": [{"type": "command", "command": "curl --noproxy localhost --noproxy 127.0.0.1 -s -X POST 'http://127.0.0.1:16321/hook' -H 'Content-Type: application/json' -d @-", "timeout": 999999}]}],
    "Stop": [{"matcher": "", "hooks": [{"type": "command", "command": "curl --noproxy localhost --noproxy 127.0.0.1 -s -X POST 'http://127.0.0.1:16321/hook' -H 'Content-Type: application/json' -d @-", "timeout": 999999}]}],
    "SubagentStop": [{"matcher": "", "hooks": [{"type": "command", "command": "curl --noproxy localhost --noproxy 127.0.0.1 -s -X POST 'http://127.0.0.1:16321/hook' -H 'Content-Type: application/json' -d @-", "timeout": 999999}]}],
    "SessionStart": [{"matcher": "", "hooks": [{"type": "command", "command": "curl --noproxy localhost --noproxy 127.0.0.1 -s -X POST 'http://127.0.0.1:16321/hook' -H 'Content-Type: application/json' -d @-"}]}],
    "SessionEnd": [{"matcher": "", "hooks": [{"type": "command", "command": "curl --noproxy localhost --noproxy 127.0.0.1 -s -X POST 'http://127.0.0.1:16321/hook' -H 'Content-Type: application/json' -d @-"}]}],
    "Notification": [{"matcher": "", "hooks": [{"type": "command", "command": "curl --noproxy localhost --noproxy 127.0.0.1 -s -X POST 'http://127.0.0.1:16321/hook' -H 'Content-Type: application/json' -d @-"}]}]
  }
}
```

Events with `timeout: 999999` are blocking events that may need user interaction. See [Hook documentation](https://code.claude.com/docs/en/hooks) for details.

</details>

## Working Modes

### Bystander Mode (default)

All hook events are streamed to the app. Events return `{}` immediately — Claude Code is unaffected.

### Takeover Mode

User interaction events (PermissionRequest, Stop, Elicitation) block until you respond in the MyPilot app. Disconnect automatically returns to bystander mode.

## Pairing

When you start the gateway, a QR code is displayed in the terminal. Open the MyPilot app and scan it to connect.

If you need to reconnect later (e.g., app was closed), run:

```bash
mypilot pair-info
```

This displays the pairing QR code and connection details (IP, port, token) without restarting the gateway.

### NAT Traversal

If your iPhone is not on the same LAN (e.g., using a tunnel service like frp, ngrok, Cloudflare Tunnel), provide your domain:

```bash
mypilot pair-info tunnel.example.com        # defaults to port 443
mypilot pair-info tunnel.example.com:8080   # custom port
```

The QR code will use the domain as the host, allowing the iOS app to connect through the tunnel.

## Docker

```bash
docker compose build
# Set LAN_IP to your machine's local IP (the iPhone must be on the same network)
LAN_IP=192.168.x.x docker compose up -d
```

The `LAN_IP` variable tells the gateway which IP address to advertise in the QR code. Without it, the QR code may contain an incorrect or unreachable address inside Docker.

## Development

```bash
npm install
npm run dev          # tsx dev server
npm test             # vitest
npm run build        # tsc
npm run typecheck    # type check only
```

## Troubleshooting

| Problem | Solution |
|---------|----------|
| Gateway won't start | Check if already running: `mypilot status`. Kill stale process if needed. |
| QR code won't scan | Ensure iPhone and computer are on the same WiFi network. Try `mypilot pair-info` for a fresh QR code. |
| App can't connect | Check firewall settings. Port 16321 must be open on your machine. |
| Hooks not firing | Verify hooks are in `~/.claude/settings.json`. Run `mypilot init-hooks` to reconfigure. |
| Wrong IP in QR code | Set `LAN_IP` env var or run `mypilot pair-info` after starting the gateway. For remote access, use `mypilot pair-info <domain>`. |

## Data Directory

`~/.mypilot/` — stores token, PID file, and event logs.

## License

MIT
