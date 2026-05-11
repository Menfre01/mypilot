<div align="center">
  <img src="assets/logo.svg" width="128" height="128" alt="MyPilot Logo" />
  <h1>MyPilot</h1>

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)

Gateway server for [MyPilot](https://apps.apple.com/hk/app/mypilot/id6762133874) — a third-party mobile client for [Claude Code](https://code.claude.com).

[中文](README.md) | English
</div>

> **Download MyPilot** — iOS: [App Store](https://apps.apple.com/hk/app/mypilot/id6762133874) in most regions (not available in mainland China). Users in mainland China can join via [TestFlight](https://testflight.apple.com/join/gU2Tw8Hg). Android: [GitHub Releases](https://github.com/Menfre01/mypilot/releases) APK.

<p align="center">
  <img src="assets/qrcodes/ios-appstore.png" width="160" alt="iOS App Store" />
  &nbsp;&nbsp;&nbsp;&nbsp;
  <img src="assets/qrcodes/testflight.png" width="160" alt="TestFlight" />
  &nbsp;&nbsp;&nbsp;&nbsp;
  <img src="assets/qrcodes/android-apk.png" width="160" alt="Android APK" />
</p>
<p align="center">
  <strong>iOS App Store</strong>&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;
  <strong>TestFlight</strong>&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;
  <strong>Android APK</strong>
</p>

MyPilot is a third-party mobile client for Claude Code. Monitor Claude Code activity, receive real-time event streams, approve permissions, answer questions, submit prompts, and even initiate new Claude Code sessions — all from your phone.

> **Apple Watch push** — APNs notifications are automatically mirrored to your paired Apple Watch with zero configuration. Cellular models receive push independently when away from iPhone. Stay on top of Claude Code activity right from your wrist.

<p align="center">
<img src="assets/iphone-welcome.png" width="220" alt="Welcome page on iPhone" />
<img src="assets/iphone-events.png" width="220" alt="Live event stream on iPhone" />
<img src="assets/iphone-interact.png" width="220" alt="Takeover interaction on iPhone" />
</p>

<p align="center"><strong>iPhone</strong> — welcome page · live events · takeover mode</p>

## Requirements

- **Node.js** >= 20
- **Client**: [MyPilot iOS App](https://apps.apple.com/hk/app/mypilot/id6762133874) (App Store, most regions), [TestFlight](https://testflight.apple.com/join/gU2Tw8Hg) (mainland China), or [Android APK](https://github.com/Menfre01/mypilot/releases/latest)
- **Claude Code** CLI — [Installation guide](https://docs.anthropic.com/en/docs/claude-code/overview#installing-claude-code)

## Quick Start

```bash
# 0. Make sure Claude Code is installed and logged in
claude --version

# 1. Install
npm install -g mypilot

# 2. Configure Claude Code hooks
mypilot init-hooks

# 3. Start the gateway (background)
mypilot start
```

Scan the QR code displayed in your terminal with the MyPilot app on your phone to complete pairing. The QR code contains the gateway address and encryption key — everything needed for a secure connection.

Once paired, your phone can remotely control Claude Code on your computer. Start sessions directly from the app, or use `mypilot session` in the terminal for a PTY session. See the [Session Guide](#session-guide) for details.

> **Tip**: If `npm install -g` fails with a permissions error, try `npm install -g mypilot --prefix ~/.local` or see the [npm docs](https://docs.npmjs.com/resolving-eacces-permissions-errors-when-installing-packages-globally). Push notifications are auto-registered on first start — no extra setup required.

## Session Guide

A Session is the core unit that connects your phone to Claude Code via MyPilot. Each session represents a running Claude Code conversation that can flow freely between the mobile app and your computer terminal.

### Starting a Session from Your Phone

1. Open the MyPilot app and confirm the status indicator is green (connected to gateway)
2. Confirm you are in takeover mode (switch to takeover in the app)
3. Tap the 【+】 button in the bottom-right corner, select a working directory, optionally enter a session name, and tap Start — Claude Code starts in the background on your computer
4. The new session appears in the session list — tap to enter, then start a task by typing a prompt

### Viewing Sessions in the Terminal

Phone-initiated sessions run in the background and can be viewed and managed from the terminal:

```bash
# List all active sessions
mypilot session ls
```

Example output:

```
ID             名称           模式       来源
────────────── ──────────── ──────── ────────
a1b2c3d4       my-project    PTY      mobile
e5f6g7h8       -             PTY      desktop
```

- **mobile** — session started from the phone
- **desktop** — session started via `mypilot session` from the terminal

### Flowing a Phone Session to the Terminal

Any session started on your phone can be taken over in the terminal at any time, with interaction state seamlessly transferred:

```bash
# Resume the most recent session (from either phone or terminal)
mypilot session --continue

# Resume a session by shortid
mypilot session --resume a1b2c3d4
```

Once resumed, the terminal enters PTY interactive mode — your keyboard input goes directly to Claude Code. The phone app continues to show real-time output, and control can be switched between the two at any time (see [Working Modes](#working-modes)).

### Starting a Session from the Terminal and Letting Your Phone Take Over

```bash
# Create a new session in the terminal
mypilot session --name my-project
```

Once the terminal is in PTY interactive mode, open the MyPilot app and switch to takeover mode to take control on your phone. Interactive events (permission requests, questions, etc.) will then wait for responses on the phone.

### Ending a Session

Three ways to end a session:

1. **Exit from Claude Code TUI**: type `exit` in the PTY terminal to quit Claude Code normally — the session ends automatically
2. **Force kill from terminal**: `mypilot session kill <shortid>` forcefully terminates the specified session
3. **Delete from phone**: swipe left on the session in the MyPilot app's session list to delete

### Live Watch

```bash
# Watch the session list update in real time
mypilot session ls -w
```

This continuously refreshes the session list, useful for observing phone-side activity from the terminal.

## Working Modes

### Bystander Mode (default)

View session message streams and activity status in real time. Cannot input prompts or create new sessions.

### Takeover Mode

Full interactive control over Claude Code sessions: input prompts, answer questions, approve permissions, initiate new sessions, and more. Disconnect automatically returns to bystander mode.

When multiple devices are connected, takeover is exclusive — only one device can hold takeover ownership at a time. If another device initiates takeover, it preempts the current owner, which reverts to bystander mode.

### Switching Between Terminal and Phone

Claude Code sessions can be started from either terminal or phone, with control switched at any time:

- **Start from phone**: Create a new session directly in the MyPilot app — Claude Code runs in the background on your computer, with the phone as the primary controller
- **Start from terminal**: Run `mypilot session` to enter PTY mode and interact with Claude Code directly
- **Switch to phone**: Switch to takeover mode in the MyPilot app — interactive events (e.g., permission requests) will then wait for responses on the phone
- **Switch to terminal**: Run `mypilot session --resume <id>` to take over a specific session in the terminal, with current interaction state seamlessly handed over
- **Detach terminal**: Press `Ctrl+C` to detach the PTY connection; the Claude Code session continues in the background, unaffected on the phone side

## Architecture

```
                                        POST /hook         ← hook events
Claude Code ──(hook / curl)──▶          GET  /pair         ← key validation
                                        GET  /sessions     ← session list (CLI)
Claude Code ──(PTY spawn)──▶  ── Gateway (:16321) ── WS /ws-gateway  ──▶ MyPilot App (encrypted WebSocket, multi-device)
                               │       WS  /pty-relay     ← PTY relay (terminal)
Terminal ──(mypilot session)──▶│
                               │
                               └──▶ Push Relay ──(APNs)──▶ MyPilot App (push / Apple Watch)
```

All WebSocket communication between the Gateway and the MyPilot app is end-to-end encrypted with **AES-256-GCM** using a pre-shared key distributed via QR code. The same key is used for both connection authentication and message encryption — no separate token is needed.

### Push Notifications

When a client disconnects from WebSocket, the Gateway forwards new events via Push Relay → APNs → device.

**Trigger**: push is sent automatically when a device is offline (no WebSocket connection) and was last seen within 24 hours. Once the device reconnects, Gateway stops pushing and resumes real-time WebSocket delivery.

**Apple Watch behavior**:
- When iOS registers an APNs push token, notification mirroring is automatically enabled on the paired Apple Watch — no separate token registration needed
- APNs delivers notifications to both iPhone and the paired watch via system-level mirroring
- GPS-only watches receive notifications via Bluetooth/Wi-Fi from the paired iPhone; cellular watches receive directly via built-in eSIM when away from iPhone
- Notifications are readable directly on the watch, keeping you aware of Claude Code activity without reaching for your phone

### Security & Reliability

- **End-to-end encryption** — AES-256-GCM with a unique random 12-byte IV per message and 16-byte authentication tag; the gateway cannot read plaintext without the key, and any tampering is detected via the auth tag
- **Key-based authentication** — clients authenticate via the pre-shared key in the WebSocket URL
- **Multi-device support** — connect multiple iPhones/iPads/Android devices simultaneously; each device gets a unique `deviceId`, receives all broadcasts, and can send commands independently; same-device reconnection seamlessly replaces the old connection
- **Apple Watch push** — APNs notifications are delivered to paired Apple Watch automatically with no extra setup; cellular models can receive notifications independently when away from iPhone
- **Heartbeat** — 30-second keep-alive pings detect stale connections per device
- **Event persistence** — all events are logged to JSONL files (`~/.mypilot/logs/`)
- **Reconnection recovery** — clients can resume from the last received sequence number after reconnecting, with a per-device offline message buffer of up to 200 events

## CLI Commands

```bash
mypilot gateway                        # Start the Gateway server (foreground)
mypilot start                          # Start Gateway in background
mypilot stop                           # Stop background Gateway
mypilot restart                        # Restart Gateway (stop + start)
mypilot status                         # Check Gateway status (PID, port)
mypilot init-hooks                     # Configure Claude Code hooks (auto-merge into ~/.claude/settings.json)
mypilot pair-info                      # Show pairing info (IP + QR code) for reconnecting
mypilot link list                      # List all communication links
mypilot link add <lan|tunnel> <url> [--label <label>]  # Add a link (LAN direct or tunnel)
mypilot link remove <id>               # Remove a link
mypilot link enable <id>               # Enable a link
mypilot link disable <id>              # Disable a link
mypilot push status                    # Check push notification status
mypilot push setup <relay-url> <api-key>  # Configure push notifications
mypilot push disable                   # Disable push notifications
mypilot session                        # Create a new session
mypilot session --name <name>          # Create a named session
mypilot session --cwd <path>           # Set working directory
mypilot session --model <model>        # Set model
mypilot session --continue             # Resume the most recent session
mypilot session --resume <shortid>     # Resume session by shortid
mypilot session kill <shortid>         # Kill a session
mypilot session ls                     # List all active sessions
mypilot session ls -w                  # Watch sessions live
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
    "PreToolUse": [
      { "matcher": "", "hooks": [{ "type": "command", "command": "curl --noproxy localhost --noproxy 127.0.0.1 -s -X POST 'http://127.0.0.1:16321/hook' -H 'Content-Type: application/json' -d @-", "timeout": 999999 }] }
    ],
    "PostToolUse": [
      { "matcher": "", "hooks": [{ "type": "command", "command": "curl --noproxy localhost --noproxy 127.0.0.1 -s -X POST 'http://127.0.0.1:16321/hook' -H 'Content-Type: application/json' -d @-" }] }
    ],
    "PostToolUseFailure": [
      { "matcher": "", "hooks": [{ "type": "command", "command": "curl --noproxy localhost --noproxy 127.0.0.1 -s -X POST 'http://127.0.0.1:16321/hook' -H 'Content-Type: application/json' -d @-" }] }
    ],
    "PermissionRequest": [
      { "matcher": "", "hooks": [{ "type": "command", "command": "curl --noproxy localhost --noproxy 127.0.0.1 -s -X POST 'http://127.0.0.1:16321/hook' -H 'Content-Type: application/json' -d @-", "timeout": 999999 }] }
    ],
    "UserPromptSubmit": [
      { "matcher": "", "hooks": [{ "type": "command", "command": "curl --noproxy localhost --noproxy 127.0.0.1 -s -X POST 'http://127.0.0.1:16321/hook' -H 'Content-Type: application/json' -d @-", "timeout": 999999 }] }
    ],
    "Elicitation": [
      { "matcher": "", "hooks": [{ "type": "command", "command": "curl --noproxy localhost --noproxy 127.0.0.1 -s -X POST 'http://127.0.0.1:16321/hook' -H 'Content-Type: application/json' -d @-", "timeout": 999999 }] }
    ],
    "Stop": [
      { "matcher": "", "hooks": [{ "type": "command", "command": "curl --noproxy localhost --noproxy 127.0.0.1 -s -X POST 'http://127.0.0.1:16321/hook' -H 'Content-Type: application/json' -d @-", "timeout": 999999 }] }
    ],
    "SubagentStop": [
      { "matcher": "", "hooks": [{ "type": "command", "command": "curl --noproxy localhost --noproxy 127.0.0.1 -s -X POST 'http://127.0.0.1:16321/hook' -H 'Content-Type: application/json' -d @-" }] }
    ],
    "SessionStart": [
      { "matcher": "", "hooks": [{ "type": "command", "command": "curl --noproxy localhost --noproxy 127.0.0.1 -s -X POST 'http://127.0.0.1:16321/hook' -H 'Content-Type: application/json' -d @-" }] }
    ],
    "SessionEnd": [
      { "matcher": "", "hooks": [{ "type": "command", "command": "curl --noproxy localhost --noproxy 127.0.0.1 -s -X POST 'http://127.0.0.1:16321/hook' -H 'Content-Type: application/json' -d @-" }] }
    ],
    "InstructionsLoaded": [
      { "matcher": "", "hooks": [{ "type": "command", "command": "curl --noproxy localhost --noproxy 127.0.0.1 -s -X POST 'http://127.0.0.1:16321/hook' -H 'Content-Type: application/json' -d @-" }] }
    ],
    "Notification": [
      { "matcher": "", "hooks": [{ "type": "command", "command": "curl --noproxy localhost --noproxy 127.0.0.1 -s -X POST 'http://127.0.0.1:16321/hook' -H 'Content-Type: application/json' -d @-" }] }
    ],
    "SubagentStart": [
      { "matcher": "", "hooks": [{ "type": "command", "command": "curl --noproxy localhost --noproxy 127.0.0.1 -s -X POST 'http://127.0.0.1:16321/hook' -H 'Content-Type: application/json' -d @-" }] }
    ],
    "StopFailure": [
      { "matcher": "", "hooks": [{ "type": "command", "command": "curl --noproxy localhost --noproxy 127.0.0.1 -s -X POST 'http://127.0.0.1:16321/hook' -H 'Content-Type: application/json' -d @-" }] }
    ],
    "PermissionDenied": [
      { "matcher": "", "hooks": [{ "type": "command", "command": "curl --noproxy localhost --noproxy 127.0.0.1 -s -X POST 'http://127.0.0.1:16321/hook' -H 'Content-Type: application/json' -d @-" }] }
    ],
    "ConfigChange": [
      { "matcher": "", "hooks": [{ "type": "command", "command": "curl --noproxy localhost --noproxy 127.0.0.1 -s -X POST 'http://127.0.0.1:16321/hook' -H 'Content-Type: application/json' -d @-" }] }
    ],
    "CwdChanged": [
      { "matcher": "", "hooks": [{ "type": "command", "command": "curl --noproxy localhost --noproxy 127.0.0.1 -s -X POST 'http://127.0.0.1:16321/hook' -H 'Content-Type: application/json' -d @-" }] }
    ],
    "FileChanged": [
      { "matcher": "", "hooks": [{ "type": "command", "command": "curl --noproxy localhost --noproxy 127.0.0.1 -s -X POST 'http://127.0.0.1:16321/hook' -H 'Content-Type: application/json' -d @-" }] }
    ],
    "TaskCreated": [
      { "matcher": "", "hooks": [{ "type": "command", "command": "curl --noproxy localhost --noproxy 127.0.0.1 -s -X POST 'http://127.0.0.1:16321/hook' -H 'Content-Type: application/json' -d @-" }] }
    ],
    "TaskCompleted": [
      { "matcher": "", "hooks": [{ "type": "command", "command": "curl --noproxy localhost --noproxy 127.0.0.1 -s -X POST 'http://127.0.0.1:16321/hook' -H 'Content-Type: application/json' -d @-" }] }
    ],
    "TeammateIdle": [
      { "matcher": "", "hooks": [{ "type": "command", "command": "curl --noproxy localhost --noproxy 127.0.0.1 -s -X POST 'http://127.0.0.1:16321/hook' -H 'Content-Type: application/json' -d @-" }] }
    ],
    "ElicitationResult": [
      { "matcher": "", "hooks": [{ "type": "command", "command": "curl --noproxy localhost --noproxy 127.0.0.1 -s -X POST 'http://127.0.0.1:16321/hook' -H 'Content-Type: application/json' -d @-" }] }
    ],
    "WorktreeCreate": [
      { "matcher": "", "hooks": [{ "type": "command", "command": "curl --noproxy localhost --noproxy 127.0.0.1 -s -X POST 'http://127.0.0.1:16321/hook' -H 'Content-Type: application/json' -d @-" }] }
    ],
    "WorktreeRemove": [
      { "matcher": "", "hooks": [{ "type": "command", "command": "curl --noproxy localhost --noproxy 127.0.0.1 -s -X POST 'http://127.0.0.1:16321/hook' -H 'Content-Type: application/json' -d @-" }] }
    ],
    "PreCompact": [
      { "matcher": "", "hooks": [{ "type": "command", "command": "curl --noproxy localhost --noproxy 127.0.0.1 -s -X POST 'http://127.0.0.1:16321/hook' -H 'Content-Type: application/json' -d @-" }] }
    ],
    "PostCompact": [
      { "matcher": "", "hooks": [{ "type": "command", "command": "curl --noproxy localhost --noproxy 127.0.0.1 -s -X POST 'http://127.0.0.1:16321/hook' -H 'Content-Type: application/json' -d @-" }] }
    ]
  }
}
```

Events with `timeout: 999999` are blocking events that may need user interaction. See [Hook documentation](https://code.claude.com/docs/en/hooks) for details.

</details>

## Pairing

If you need to get the QR code again (e.g., switched phones or app was closed), run:

```bash
mypilot pair-info
```

This displays the pairing QR code and connection details (IP, port, key) without restarting the gateway.

### NAT Traversal

If your phone is not on the same LAN (e.g., using a tunnel service like frp, ngrok, Cloudflare Tunnel), add a tunnel link:

```bash
mypilot link add tunnel wss://tunnel.example.com --label "My Tunnel"
```

The QR code will automatically include the tunnel address, allowing the iOS app to connect through the tunnel.

## Docker

```bash
docker compose build
# Set LAN_IP to your machine's local IP (the phone must be on the same network)
LAN_IP=192.168.x.x docker compose up -d
```

The `LAN_IP` variable tells the gateway which IP address to advertise in the QR code. Without it, the QR code may contain an incorrect or unreachable address inside Docker.

## Development

```bash
npm install
npm run dev              # tsx dev server (hot reload)
npm run stop:dev         # Stop dev server
npm run restart:dev      # Restart dev server
npm run build            # tsc compile
npm run typecheck        # Type check only
npm test                 # vitest

# Docker
npm run docker:build     # Build Docker image
npm run docker:up        # Start container (auto-detect LAN_IP)
npm run docker:down      # Stop container
npm run docker:restart   # Rebuild & restart
```

## Troubleshooting

| Problem | Solution |
|---------|----------|
| Gateway won't start | Check if already running: `mypilot status`. Kill stale process if needed. |
| QR code won't scan | Ensure your phone and computer are on the same WiFi network. Try `mypilot pair-info` for a fresh QR code. |
| App can't connect | Check firewall settings. Port 16321 must be open on your machine. |
| Hooks not firing | Verify hooks are in `~/.claude/settings.json`. Run `mypilot init-hooks` to reconfigure. |
| Wrong IP in QR code | Set `LAN_IP` env var or run `mypilot pair-info` after starting the gateway. For remote access, use `mypilot link add tunnel <url>` to add a tunnel link. |
| App issues or suggestions | [Open an issue](../../issues/new/choose) — bugs and feature requests for both the gateway and iOS app are welcome here. |

## Data Directory

```
~/.mypilot/
├── key              # AES-256-GCM encryption key
├── gateway.pid      # PID file for background mode
├── push.json        # Push notification config
├── links.json       # Communication links config
├── gateway-state.json  # Gateway state (mode, takeover ownership, devices)
└── logs/
    ├── events-YYYY-MM-DD.jsonl         # Daily event logs
    └── session-<id>-YYYY-MM-DD.jsonl   # Per-session message logs
```

## License

[Apache License 2.0](LICENSE)
