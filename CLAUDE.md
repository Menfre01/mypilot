## Development

### TDD Flow

Write tests first, then implement.

### Commands

```bash
npm run dev           # Start Gateway (tsx hot reload)
npm run stop:dev      # Stop dev server
npm run restart:dev   # Restart dev server
npm run build         # Build backend (tsc)
npm test              # Run tests (vitest)
npm run typecheck     # Type check only

# Docker
npm run docker:build   # Build Docker image
npm run docker:up      # Start Docker container
npm run docker:down    # Stop Docker container
```

### Architecture

- `src/backend/cli.ts` — CLI entry point (gateway, status)
- `src/backend/gateway/server.ts` — HTTP + WebSocket server
- `src/backend/gateway/hook-handler.ts` — Hook event processing
- `src/backend/gateway/ws-bus.ts` — WebSocket message bus
- `src/backend/gateway/qr-display.ts` — Terminal QR code
- `src/backend/gateway/event-logger.ts` — JSONL event persistence
- `src/backend/gateway/token-store.ts` — Token management
- `src/backend/gateway/session-store.ts` — Session tracking
- `src/backend/gateway/pending-store.ts` — Pending interaction queue
- `src/shared/protocol.ts` — Protocol types (GatewayMessage, ClientMessage)
- `src/shared/events.ts` — Event classification

Data dir: `~/.mypilot/`
