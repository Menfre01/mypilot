# SessionMessage JSON 格式全集

客户端通过 WebSocket 接收两类消息，用于 MessageFlow UI 渲染。

**数据来源**：`~/.mypilot/logs/events-*.jsonl`（hook event）和 `~/.mypilot/logs/transcript-*.jsonl`（transcript entry）。

---

## 目录

- [WebSocket 消息信封](#websocket-消息信封)
- [TranscripEntry — 全量消息流](#transcriptentry--全量消息流)
  - [block: thinking](#block-thinking)
  - [block: text](#block-text)
  - [block: tool_use](#block-tool_use)
  - [block: tool_result](#block-tool_result)
  - [组合示例](#组合示例)
- [SSEHookEvent — 交互与通知事件](#ssehookevent--交互与通知事件)
  - [SessionStart / SessionEnd](#sessionstart--sessionend)
  - [Stop / SubagentStop / StopFailure](#stop--subagentstop--stopfailure)
  - [PermissionRequest](#permissionrequest)
  - [Notification](#notification)
  - [InstructionsLoaded](#instructionsloaded)
  - [PreToolUse（交互式：AskUserQuestion / ExitPlanMode）](#pretooluse交互式askuserquestion--exitplanmode)
  - [SubagentStart](#subagentstart)
  - [PreCompact / PostCompact](#precompact--postcompact)
  - [ConfigChange](#configchange)
  - [CwdChanged](#cwdchanged)
  - [TaskCreated / TaskCompleted](#taskcreated--taskcompleted)
  - [Elicitation](#elicitation)
  - [ElicitationResult](#elicitationresult)
  - [FileChanged](#filechanged)
  - [PermissionDenied](#permissiondenied)
  - [TeammateIdle](#teammateidle)
  - [WorktreeCreate / WorktreeRemove](#worktreecreate--worktreeremove)
- [过滤事件（客户端不可见）](#过滤事件客户端不可见)

---

## WebSocket 消息信封

客户端通过 WebSocket 接收 `GatewayMessage`，与 MessageFlow 相关的有两种：

```json
// 1. Hook 事件（交互/通知）
{
  "type": "event",
  "sessionId": "466561cc-8041-4ff8-8a89-50b321426e8f",
  "seq": 21365,
  "event": { /* SSEHookEvent — 见下方各节 */ }
}

// 2. Transcript 条目（全量消息流）
{
  "type": "transcript_entry",
  "sessionId": "cd1a0a61-5478-491b-b6d5-674ac4709551",
  "seq": 21366,
  "entry": { /* TranscriptEntry — 见下方 */ }
}
```

**关键区分**：
- `event`：状态变更通知（session 启停、权限请求、错误等），text 类消息不在此通道
- `transcript_entry`：CC 的完整行为过程（思考 → 文本回复 → 工具调用 → 工具结果），用户阅读的主体

---

## TranscriptEntry — 全量消息流

TranscriptEntry 来自 CC transcript JSONL 文件的增量解析，包含 assistant 和 user 两种类型。

### 顶层结构

```json
{
  "index": 37,
  "type": "assistant",
  "timestamp": 1777526559275,
  "model": "deepseek-v4-pro",
  "usage": {
    "input_tokens": 0,
    "output_tokens": 439,
    "cache_read_input_tokens": 157184,
    "cache_creation_input_tokens": 0
  },
  "blocks": [
    /* TranscriptBlock[] — 见下方各节 */
  ]
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `index` | number | transcript 文件行号（从 0 开始），用于去重排序 |
| `type` | `"assistant"` \| `"user"` | 条目来源：assistant = CC 输出，user = 用户输入或工具结果 |
| `timestamp` | number | Unix 毫秒时间戳 |
| `model` | string? | 仅 `assistant` 条目有值，如 `"claude-opus-4-7"`、`"deepseek-v4-pro"` |
| `usage` | TokenUsage? | 仅 `assistant` 条目有值，token 消耗统计 |
| `blocks` | TranscriptBlock[] | 内容块数组，按顺序排列 |

### TokenUsage

```json
{
  "input_tokens": 0,
  "output_tokens": 439,
  "cache_read_input_tokens": 157184,
  "cache_creation_input_tokens": 0
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `input_tokens` | number | 本次输入 token 数（含缓存命中时可能为 0 或负数） |
| `output_tokens` | number | 本次输出 token 数 |
| `cache_read_input_tokens` | number? | 从缓存读取的 token 数 |
| `cache_creation_input_tokens` | number? | 写入缓存的 token 数 |

### block: thinking

assistant 思考过程。内容截断至 300 字符。

```json
{
  "type": "thinking",
  "thinking": "Now let me run the analyze again to make sure the warnings are gone."
}
```

### block: text

assistant 或 user 的纯文本内容。assistant text 截断至 500 字符，user text 截断至 500 字符。

```json
{
  "type": "text",
  "text": "我来帮你分析这个问题。首先让我看看相关的代码文件。"
}
```

### block: tool_use

assistant 调用工具。

```json
{
  "type": "tool_use",
  "id": "call_00_qftjdSQt4J6PYd7LrbMcaHiz",
  "name": "Bash",
  "input": {
    "command": "mypilot restart 2>&1",
    "description": "Restart mypilot service"
  }
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | string | 工具调用 ID，以 `call_00_` 开头 |
| `name` | string | 工具名：`Bash`、`Read`、`Edit`、`Write`、`Agent`、`TaskCreate`、`WebFetch` 等 |
| `input` | object | 工具输入参数，各工具的字段不同 |

**常见工具 input 结构**：

```json
// Bash
{ "command": "npm test 2>&1", "description": "Run tests" }

// Read
{ "file_path": "/path/to/file.ts", "offset": 10, "limit": 50 }

// Edit
{ "file_path": "/path/to/file.ts", "old_string": "...", "new_string": "...", "replace_all": false }

// Write
{ "file_path": "/path/to/file.ts", "content": "..." }

// Agent
{ "description": "Explore code", "prompt": "Find all...", "subagent_type": "Explore" }

// TaskCreate
{ "subject": "Add feature", "description": "Implement..." }

// TaskUpdate
{ "taskId": "3", "status": "completed" }

// WebFetch
{ "url": "https://example.com", "prompt": "Extract..." }

// WebSearch
{ "query": "latest docs" }

// AskUserQuestion (交互式 PreToolUse)
{ "questions": [...] }

// ExitPlanMode (交互式 PreToolUse)
{}
```

### block: tool_result

user 条目中的工具执行结果。内容截断至 1000 字符。

```json
{
  "type": "tool_result",
  "tool_use_id": "call_00_j81Bi9rDFQa0nlhcItonVmtF",
  "content": "Terminal notification sent. Mobile push not sent (Remote Control inactive).",
  "isError": false
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `tool_use_id` | string | 对应 tool_use block 的 ID |
| `content` | string | 工具执行结果文本 |
| `isError` | boolean | 是否为错误结果 |

### 组合示例

**assistant 纯 text 回复（无工具调用）**：
```json
{
  "index": 42,
  "type": "assistant",
  "timestamp": 1777527000000,
  "model": "claude-opus-4-7",
  "usage": { "input_tokens": 5000, "output_tokens": 200, "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0 },
  "blocks": [
    { "type": "thinking", "thinking": "这是一个简单问题，直接回答即可。" },
    { "type": "text", "text": "这段代码的问题在于异步操作没有正确处理错误。建议添加 try-catch 包裹 await 调用。" }
  ]
}
```

**assistant thinking + tool_use（最常见）**：
```json
{
  "index": 50,
  "type": "assistant",
  "timestamp": 1777527100000,
  "model": "deepseek-v4-pro",
  "usage": { "input_tokens": 0, "output_tokens": 116, "cache_read_input_tokens": 34432, "cache_creation_input_tokens": 0 },
  "blocks": [
    { "type": "thinking", "thinking": "需要先查看配置文件确认当前设置。" },
    { "type": "tool_use", "id": "call_00_abc123", "name": "Read", "input": { "file_path": "/path/to/config.ts" } }
  ]
}
```

**user tool_result**：
```json
{
  "index": 51,
  "type": "user",
  "timestamp": 1777527110000,
  "blocks": [
    { "type": "tool_result", "tool_use_id": "call_00_abc123", "content": "export const config = { port: 3000 };", "isError": false }
  ]
}
```

**user tool_result（错误）**：
```json
{
  "index": 51,
  "type": "user",
  "timestamp": 1777527110000,
  "blocks": [
    { "type": "tool_result", "tool_use_id": "call_00_xyz789", "content": "Error: ENOENT: no such file or directory, open '/tmp/nonexistent'", "isError": true }
  ]
}
```

---

## SSEHookEvent — 交互与通知事件

以下 20 种 hook event 不会被 transcript 覆盖，客户端会收到 `{ type: "event", sessionId, event }` 消息。

> **公共字段**：所有 hook event 都包含 `session_id`、`event_name`、`event_id`（base-36 序号）、`timestamp`（毫秒）、`cwd`（当前工作目录）、`transcript_path`。

### SessionStart / SessionEnd

**触发时机**：CC session 启动/结束。

```json
// SessionStart
{
  "session_id": "9c59eb84-b9ce-4f43-9cd1-61cd39f529c5",
  "event_name": "SessionStart",
  "event_id": "fyo",
  "timestamp": 1777519083769,
  "cwd": "/Users/menfre/Workbench/cc-notify",
  "transcript_path": "/Users/menfre/.claude/projects/.../9c59eb84...jsonl",
  "source": "startup"
}
```

```json
// SessionEnd
{
  "session_id": "1c8e5930-1426-4909-a8a1-6cc389916330",
  "event_name": "SessionEnd",
  "event_id": "fyn",
  "timestamp": 1777519083742,
  "cwd": "/Users/menfre/Workbench/cc-notify",
  "transcript_path": "/Users/menfre/.claude/projects/.../1c8e5930...jsonl",
  "reason": "clear"
}
```

| 特有字段 | 类型 | 说明 |
|----------|------|------|
| `source` | string | SessionStart：启动来源 `"startup"` \| `"clear"` \| `"resume"` |
| `reason` | string | SessionEnd：结束原因 `"clear"` \| `"logout"` \| `"prompt"` |

---

### Stop / SubagentStop / StopFailure

**触发时机**：CC 或 subagent 询问是否继续 / 停止失败。

```json
// Stop
{
  "session_id": "466561cc-8041-4ff8-8a89-50b321426e8f",
  "event_name": "Stop",
  "event_id": "fyt",
  "timestamp": 1777519102235,
  "cwd": "/Users/menfre/Workbench/mypilot",
  "transcript_path": "/Users/menfre/.claude/projects/.../466561cc...jsonl",
  "last_assistant_message": "编译成功，Gateway 已重启（PID 77780），QR 码已显示。",
  "stop_hook_active": false,
  "permission_mode": "default"
}
```

```json
// SubagentStop
{
  "session_id": "ba2075b1-812d-4a97-afc1-0cda5423e364",
  "event_name": "SubagentStop",
  "event_id": "g03",
  "timestamp": 1777519438470,
  "cwd": "/Users/menfre/Workbench/cc-notify",
  "transcript_path": "/Users/menfre/.claude/projects/.../ba2075b1...jsonl",
  "agent_id": "a8f25ba4717dc3086",
  "agent_type": "",
  "agent_transcript_path": "/Users/menfre/.claude/projects/.../ba2075b1...jsonl",
  "last_assistant_message": "修复了 `/simplify` 启动多个后台 agent 时 stop...",
  "stop_hook_active": false,
  "permission_mode": "acceptEdits"
}
```

```json
// StopFailure
{
  "session_id": "14c230d7-3ae2-4f76-9026-f2f7a09735f7",
  "event_name": "StopFailure",
  "event_id": "345",
  "timestamp": 1777348297623,
  "cwd": "/Users/menfre/Workbench/cc-notify",
  "transcript_path": "/Users/menfre/.claude/projects/.../14c230d7...jsonl",
  "agent_id": "a6594848c30ee1005",
  "error": "server_error",
  "last_assistant_message": "API Error: 502 all channels failed..."
}
```

| 特有字段 | 类型 | 说明 |
|----------|------|------|
| `last_assistant_message` | string | CC 最近的文本回复摘要 |
| `stop_hook_active` | boolean | Stop hook 是否已激活 |
| `permission_mode` | string? | 权限模式 |
| `agent_id` | string? | SubagentStop/StopFailure：子 agent ID |
| `agent_type` | string? | SubagentStop：子 agent 类型 |
| `agent_transcript_path` | string? | SubagentStop：子 agent transcript 路径 |
| `error` | string? | StopFailure：错误类型 |
| `reason` | string? | StopFailure：失败原因 |

---

### PermissionRequest

**触发时机**：CC 请求用户授权（如执行命令、访问文件）。

```json
{
  "session_id": "4ca6d312-4ee1-4073-a8df-d0ea9181fe98",
  "event_name": "PermissionRequest",
  "event_id": "fzo",
  "timestamp": 1777519343215,
  "cwd": "/Users/menfre/Workbench/mypilot",
  "transcript_path": "/Users/menfre/.claude/projects/.../4ca6d312...jsonl",
  "tool_name": "WebFetch",
  "tool_input": {
    "url": "https://www.weather.com/zh-CN/weather/today/l/CHXX0299:1:CH",
    "prompt": "揭阳今天天气怎么样？温度、湿度、风力..."
  },
  "permission_mode": "default",
  "permission_suggestions": [
    {
      "type": "addRules",
      "destination": "localSettings",
      "rules": [
        {
          "toolName": "WebFetch",
          "ruleContent": "Allow WebFetch for weather.com"
        }
      ]
    }
  ]
}
```

| 特有字段 | 类型 | 说明 |
|----------|------|------|
| `tool_name` | string? | 请求权限的工具名 |
| `tool_input` | object? | 工具输入参数 |
| `permission_mode` | string | 当前权限模式 |
| `permission_suggestions` | object[]? | 权限建议（规则模板） |

---

### Notification

**触发时机**：系统状态通知。

```json
// idle_prompt — CC 在等待用户输入
{
  "session_id": "9c59eb84-b9ce-4f43-9cd1-61cd39f529c5",
  "event_name": "Notification",
  "event_id": "fyu",
  "timestamp": 1777519143790,
  "cwd": "/Users/menfre/Workbench/cc-notify",
  "transcript_path": "/Users/menfre/.claude/projects/.../9c59eb84...jsonl",
  "notification_type": "idle_prompt",
  "message": "Claude is waiting for your input"
}
```

```json
// permission_prompt — 权限请求提示
{
  "notification_type": "permission_prompt",
  "message": "Claude needs your permission to continue"
}
```

| 特有字段 | 类型 | 说明 |
|----------|------|------|
| `notification_type` | `"idle_prompt"` \| `"permission_prompt"` | 通知类型 |
| `message` | string | 通知文本 |

---

### InstructionsLoaded

**触发时机**：CLAUDE.md / 系统指令加载完成。

```json
{
  "session_id": "4ca6d312-4ee1-4073-a8df-d0ea9181fe98",
  "event_name": "InstructionsLoaded",
  "event_id": "fzd",
  "timestamp": 1777519286382,
  "cwd": "/Users/menfre/Workbench/mypilot",
  "transcript_path": "/Users/menfre/.claude/projects/.../4ca6d312...jsonl",
  "file_path": "/Users/menfre/.claude/CLAUDE.md",
  "load_reason": "session_start",
  "memory_type": "User"
}
```

| 特有字段 | 类型 | 说明 |
|----------|------|------|
| `file_path` | string | 加载的指令文件路径 |
| `load_reason` | string | 加载原因 `"session_start"` \| `"file_changed"` 等 |
| `memory_type` | string | 指令类型 `"User"` \| `"Project"` 等 |

---

### PreToolUse（交互式：AskUserQuestion / ExitPlanMode）

**触发时机**：CC 使用交互工具（仅这两个不会在管道中被过滤）。

```json
// AskUserQuestion
{
  "session_id": "abc123...",
  "event_name": "PreToolUse",
  "event_id": "g2a",
  "timestamp": 1777520100000,
  "cwd": "/Users/menfre/Workbench/mypilot",
  "transcript_path": "/Users/menfre/.claude/projects/.../abc123...jsonl",
  "tool_name": "AskUserQuestion",
  "tool_use_id": "call_00_xyz789",
  "tool_input": {
    "questions": [
      {
        "question": "Which library should we use?",
        "header": "Library",
        "options": [
          { "label": "lodash", "description": "Full-featured utility library" },
          { "label": "ramda", "description": "Functional programming style" }
        ]
      }
    ]
  },
  "permission_mode": "default"
}
```

```json
// ExitPlanMode
{
  "tool_name": "ExitPlanMode",
  "tool_use_id": "call_00_abc123",
  "tool_input": {},
  "permission_mode": "default"
}
```

| 特有字段 | 类型 | 说明 |
|----------|------|------|
| `tool_name` | `"AskUserQuestion"` \| `"ExitPlanMode"` | 交互工具名 |
| `tool_use_id` | string | 工具调用 ID |
| `tool_input` | object | 工具参数（AskUserQuestion 含 questions 数组） |

---

### SubagentStart

**触发时机**：子 agent 启动。

```json
{
  "session_id": "b4efe7bd-a53b-455a-97f7-33f5a7b39541",
  "event_name": "SubagentStart",
  "event_id": "g1n",
  "timestamp": 1777520019398,
  "cwd": "/Users/menfre/Workbench/cc-notify",
  "transcript_path": "/Users/menfre/.claude/projects/.../b4efe7bd...jsonl",
  "agent_id": "aa26b470fd6a71913",
  "agent_type": "Explore"
}
```

| 特有字段 | 类型 | 说明 |
|----------|------|------|
| `agent_id` | string | 子 agent 唯一 ID |
| `agent_type` | string | 子 agent 类型 |

---

### PreCompact / PostCompact

**触发时机**：CC 上下文压缩前后。

```json
// PreCompact
{
  "session_id": "68c5ba04-4924-4693-9623-0ba167c19039",
  "event_name": "PreCompact",
  "event_id": "g54",
  "timestamp": 1777520538467,
  "cwd": "/Users/menfre/Workbench/mypilot",
  "transcript_path": "/Users/menfre/.claude/projects/.../68c5ba04...jsonl",
  "trigger": "auto",
  "custom_instructions": null
}
```

```json
// PostCompact
{
  "session_id": "68c5ba04-4924-4693-9623-0ba167c19039",
  "event_name": "PostCompact",
  "event_id": "g56",
  "timestamp": 1777520674913,
  "cwd": "/Users/menfre/Workbench/mypilot",
  "transcript_path": "/Users/menfre/.claude/projects/.../68c5ba04...jsonl",
  "trigger": "auto",
  "compact_summary": "<analysis>\nLet me chronologically trace the conversation:\n\n1. **Initial research**: User asked whether..."
}
```

| 特有字段 | 类型 | 说明 |
|----------|------|------|
| `trigger` | string | 触发方式 `"auto"` \| `"manual"` |
| `custom_instructions` | string? | PreCompact：自定义压缩指令 |
| `compact_summary` | string? | PostCompact：压缩摘要 |

---

### ConfigChange

**触发时机**：Claude Code 配置变更。

```json
{
  "session_id": "466561cc-8041-4ff8-8a89-50b321426e8f",
  "event_name": "ConfigChange",
  "event_id": "em2",
  "timestamp": 1777480911806,
  "cwd": "/Users/menfre/Workbench/mypilot",
  "transcript_path": "/Users/menfre/.claude/projects/.../466561cc...jsonl",
  "file_path": "/Users/menfre/.claude/settings.json",
  "source": "user_settings"
}
```

| 特有字段 | 类型 | 说明 |
|----------|------|------|
| `file_path` | string | 变更的配置文件路径 |
| `source` | string | 变更来源 |

---

### CwdChanged

**触发时机**：CC 工作目录变更。

```json
{
  "session_id": "68c5ba04-4924-4693-9623-0ba167c19039",
  "event_name": "CwdChanged",
  "event_id": "gds",
  "timestamp": 1777521853740,
  "cwd": "/Users/menfre/Workbench/mypilot",
  "transcript_path": "/Users/menfre/.claude/projects/.../68c5ba04...jsonl",
  "old_cwd": "/Users/menfre/Workbench/mypilot",
  "new_cwd": "/Users/menfre/Workbench/cc-notify"
}
```

| 特有字段 | 类型 | 说明 |
|----------|------|------|
| `old_cwd` | string | 旧工作目录 |
| `new_cwd` | string | 新工作目录 |

---

### TaskCreated / TaskCompleted

**触发时机**：CC 任务（待办事项）创建/完成。

```json
// TaskCreated
{
  "session_id": "68c5ba04-4924-4693-9623-0ba167c19039",
  "event_name": "TaskCreated",
  "event_id": "g0n",
  "timestamp": 1777519932531,
  "cwd": "/Users/menfre/Workbench/mypilot",
  "transcript_path": "/Users/menfre/.claude/projects/.../68c5ba04...jsonl",
  "task_id": "3",
  "task_subject": "Phase 1: 新增 protocol 类型 + PROTOCOL_VERSION bump",
  "task_description": "在 src/shared/protocol.ts 中添加 TranscriptBlock..."
}
```

```json
// TaskCompleted
{
  "event_name": "TaskCompleted",
  "task_id": "3",
  "task_subject": "Phase 1: 新增 protocol 类型 + PROTOCOL_VERSION bump",
  "task_description": "在 src/shared/protocol.ts 中添加 TranscriptBlock..."
}
```

| 特有字段 | 类型 | 说明 |
|----------|------|------|
| `task_id` | string | 任务 ID |
| `task_subject` | string | 任务标题 |
| `task_description` | string | 任务描述 |

> ⚠️ **注意**：TaskCreated / TaskCompleted 当前在 `TRANSCRIPT_REPLACEABLE_EVENTS` 中被 transcript 覆盖（过滤不推送）。上表仅供了解其结构。未来如果用 TranscriptTailer 全量推送 transcript，这两个 hook event 会被过滤。

---

### Elicitation

**触发时机**：CC 向用户提问收集信息（如 "What is your name?"）。

```json
{
  "session_id": "abc123...",
  "event_name": "Elicitation",
  "event_id": "g2b",
  "timestamp": 1777520200000,
  "cwd": "/Users/menfre/Workbench/mypilot",
  "transcript_path": "/Users/menfre/.claude/projects/.../abc123...jsonl",
  "message": "What is your name?",
  "action": "ask_user",
  "content": "Please provide your name to continue."
}
```

| 特有字段 | 类型 | 说明 |
|----------|------|------|
| `message` | string | 提问内容 |
| `action` | string | 引导动作类型 |
| `content` | string | 引导详细内容 |

---

### ElicitationResult

**触发时机**：用户对 Elicitation 的响应。

```json
{
  "session_id": "abc123...",
  "event_name": "ElicitationResult",
  "event_id": "g2c",
  "timestamp": 1777520250000,
  "cwd": "/Users/menfre/Workbench/mypilot",
  "transcript_path": "/Users/menfre/.claude/projects/.../abc123...jsonl",
  "result": "My name is John"
}
```

| 特有字段 | 类型 | 说明 |
|----------|------|------|
| `result` | string | 用户响应内容 |

---

### FileChanged

**触发时机**：CC 监控到文件变更。

```json
{
  "session_id": "abc123...",
  "event_name": "FileChanged",
  "event_id": "g2d",
  "timestamp": 1777520300000,
  "cwd": "/Users/menfre/Workbench/mypilot",
  "transcript_path": "/Users/menfre/.claude/projects/.../abc123...jsonl",
  "file_path": "/Users/menfre/Workbench/mypilot/src/index.ts",
  "change_type": "modified"
}
```

| 特有字段 | 类型 | 说明 |
|----------|------|------|
| `file_path` | string | 变更的文件路径 |
| `change_type` | string | 变更类型 `"modified"` \| `"created"` \| `"deleted"` |

---

### PermissionDenied

**触发时机**：用户拒绝权限请求。

```json
{
  "session_id": "abc123...",
  "event_name": "PermissionDenied",
  "event_id": "g2e",
  "timestamp": 1777520350000,
  "cwd": "/Users/menfre/Workbench/mypilot",
  "transcript_path": "/Users/menfre/.claude/projects/.../abc123...jsonl",
  "tool_name": "WebFetch",
  "tool_input": { "url": "https://example.com" }
}
```

| 特有字段 | 类型 | 说明 |
|----------|------|------|
| `tool_name` | string | 被拒绝的工具名 |
| `tool_input` | object? | 被拒绝的工具参数 |

---

### TeammateIdle

**触发时机**：Teammate agent 进入空闲状态。

```json
{
  "session_id": "abc123...",
  "event_name": "TeammateIdle",
  "event_id": "g2f",
  "timestamp": 1777520400000,
  "cwd": "/Users/menfre/Workbench/mypilot",
  "transcript_path": "/Users/menfre/.claude/projects/.../abc123...jsonl",
  "agent_id": "agent_001",
  "agent_type": "general-purpose"
}
```

| 特有字段 | 类型 | 说明 |
|----------|------|------|
| `agent_id` | string | 进入空闲的 agent ID |
| `agent_type` | string | agent 类型 |

---

### WorktreeCreate / WorktreeRemove

**触发时机**：Git worktree 创建/移除。

```json
// WorktreeCreate
{
  "session_id": "abc123...",
  "event_name": "WorktreeCreate",
  "event_id": "g2g",
  "timestamp": 1777520450000,
  "cwd": "/Users/menfre/Workbench/mypilot",
  "transcript_path": "/Users/menfre/.claude/projects/.../abc123...jsonl",
  "worktree_path": "/Users/menfre/.claude/worktrees/feature-x"
}
```

```json
// WorktreeRemove
{
  "event_name": "WorktreeRemove",
  "event_id": "g2h",
  "worktree_path": "/Users/menfre/.claude/worktrees/feature-x"
}
```

| 特有字段 | 类型 | 说明 |
|----------|------|------|
| `worktree_path` | string | 工作树路径 |

---

## 过滤事件（客户端不可见）

以下 6 种 hook event 被 transcript 完全覆盖，**不会推送给客户端**。客户端只需关注 `transcript_entry` 消息即可获取对应内容。

| Hook Event | 过滤原因 | 客户端从 TranscriptEntry 获取 |
|---|---|---|
| `PreToolUse`（非交互） | Transcript 中 assistant entry 的 tool_use block 更完整 | `blocks[].type === "tool_use"` |
| `PostToolUse` | Transcript 中 user entry 的 tool_result block 更完整 | `blocks[].type === "tool_result"` |
| `PostToolUseFailure` | Transcript 中 `isError: true` 的 tool_result | `blocks[].type === "tool_result"` + `isError: true` |
| `UserPromptSubmit` | Transcript 中 user entry 的 text block | `type === "user"` + `blocks[].type === "text"` |
| `TaskCreated` | Transcript 中 task 相关条目 | `blocks[].type === "tool_use"` + `name === "TaskCreate"` |
| `TaskCompleted` | Transcript 中 task 相关条目 | `blocks[].type === "tool_use"` + `name === "TaskUpdate"` + status |

**唯一例外**：交互式 `PreToolUse`（`AskUserQuestion` / `ExitPlanMode`）保留推送，因为 takeover 模式需要阻塞等待用户响应。

---

## 客户端 UI 适配建议

### 消息流渲染顺序

同一 session 中，`transcript_entry` 和 `event` 消息按 `seq`（或接收时间）交错展示：

```
SessionStart (event)         ← 展示 session 头部
  ├─ transcript_entry #1     ← assistant: "我来分析这个问题"
  ├─ transcript_entry #2     ← tool_use: Read file
  ├─ transcript_entry #3     ← tool_result: file content
  ├─ transcript_entry #4     ← assistant: "文件内容显示..."
  ├─ PermissionRequest (event) ← 展示权限请求卡片
  └─ transcript_entry #5     ← tool_use: Edit file
```

### entry 类型 → UI 组件

| entry 内容 | 建议 UI |
|---|---|
| `type: "assistant"` + text block | 文本气泡（markdown 渲染） |
| `type: "assistant"` + thinking block | 折叠的思考过程（可展开） |
| `type: "assistant"` + tool_use block | 工具调用卡片（显示工具名 + 简要参数） |
| `type: "user"` + tool_result block | 工具结果卡片（`isError` 时红色；内容截断，可展开） |
| `type: "user"` + text block | 用户输入气泡（右对齐） |

### event 类型 → UI 组件

| event | 建议 UI |
|---|---|
| `SessionStart` / `SessionEnd` | 系统分隔线 |
| `Stop` / `SubagentStop` | "是否继续？" 交互按钮（takeover 模式） |
| `PermissionRequest` | 权限请求卡片（Allow / Deny 按钮） |
| `Notification` | 系统提示条 / Toast |
| `InstructionsLoaded` | 可选：系统小字提示 |
| `PreToolUse`（交互式） | 用户提问 / Plan 审批 UI |
| `SubagentStart` | 子 agent 状态标记 |
| `PreCompact` / `PostCompact` | 上下文压缩提示 |
| `ConfigChange` / `CwdChanged` | 可选：系统小字提示 |
| `TaskCreated` / `TaskCompleted` | 任务进度内联卡片 |
| `Elicitation` | 问题输入框（takeover 模式） |
