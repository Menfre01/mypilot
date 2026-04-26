## Development

### Task Execution

Large tasks must be decomposed into small, independent waves that can be parallelized using multiple Agent tool calls. Each wave groups independent subtasks; depend on prior wave results before launching the next.

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

### 参考资料

- Claude Code Hooks 文档: https://code.claude.com/docs/en/hooks

### 关联项目

- **客户端项目**: `../cc-notify/` — Flutter 移动端应用
- **架构**: 本项目为服务端，cc-notify 为客户端，采用 C/S 架构

### 协议版本管理

`src/shared/protocol.ts` 中的 `PROTOCOL_VERSION` 定义当前协议版本，客户端项目 `../cc-notify/` 中也有同名常量。

修改规则：

- **新增可选字段** → 不升版本，两边兼容 Tolerant Reader
- **新增消息类型** → MINOR bump，旧端忽略未知消息
- **删除/重命名字段、变更加密** → MAJOR bump，旧端断开连接
- **修改 `PROTOCOL_VERSION` 时** 必须同步修改 `../cc-notify/` 中的对应常量，保持两边值一致
- **`MIN_CLIENT_VERSION`** 仅在确认不再支持旧客户端时提升