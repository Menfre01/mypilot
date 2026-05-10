# 主动会话系统测试计划

## 前置条件

```bash
# 构建并启动 Gateway
cd /Users/menfre/Workbench/mypilot
npm install && npm run build && npm start

# 启动 Flutter 客户端
cd /Users/menfre/Workbench/cc-notify
flutter run
```

---

## 一、CLI Session 命令

| # | 场景 | 操作 | 预期 |
|---|------|------|------|
| 1 | 新建 PTY 会话 | `mypilot session` | 进入 Claude Code TUI，`--list` 显示该会话，模式 PTY |
| 2 | 新建命名会话 | `mypilot session --name "dev"` | `--list` 显示名称为 "dev" |
| 3 | 指定工作目录 | `mypilot session --cwd /tmp` | Claude Code 在 `/tmp` 启动 |
| 4 | 指定模型 | `mypilot session --model claude-sonnet-4-6` | 使用指定模型 |
| 5 | 列出所有会话 | `mypilot session --list` | 表格显示 ID、名称、模式、来源 |
| 6 | `--list` 无会话 | 所有 session 结束后执行 | 输出 `No active sessions.` |
| 7 | Gateway 未启动 | 未启动 Gateway 时执行 session 命令 | 提示 Gateway 未运行并退出 |
| 8 | 续接指定会话 | `mypilot session --resume <id>` | 进入已有会话的 TUI |
| 9 | 续接最近会话 | `mypilot session --last` | 进入最近活跃会话的 TUI |
| 10 | Attach 已分离会话 | `mypilot session --attach <id>` | 恢复之前分离的 PTY 会话 |
| 11 | Attach 手机创建的会话 | `mypilot session --attach <headless-id>` | headless → PTY handoff，触发模式切换 |
| 12 | Attach 不存在会话 | `mypilot session --attach nonexist` | 显示错误信息 |
| 13 | Kill 会话 | `mypilot session --kill <id>` | 进程终止，`--list` 不再显示 |
| 14 | Kill 不存在会话 | `mypilot session --kill nonexist` | 显示错误信息 |

## 二、PTY 中继与终端 I/O

| # | 场景 | 操作 | 预期 |
|---|------|------|------|
| 15 | 终端输入转发 | CLI 中键入 prompt | 输入通过 WS → Gateway → PTY → Claude Code stdin |
| 16 | 终端输出显示 | Claude Code 响应 | PTY stdout → Gateway → WS → 终端 stdout |
| 17 | Ctrl+C 分离不杀进程 | CLI 中按 Ctrl+C | 终端 raw mode 恢复，Gateway 仍持有进程 |
| 18 | Ctrl+C 后 `--list` | detach 后 `--list` | 会话仍存在，来源显示 detached |
| 19 | 终端窗口调整 | 拖动改变终端窗口大小 | `pty_resize` 消息转发到 PTY |
| 20 | 终端 raw mode 恢复 | CLI 退出（任何路径） | `stdin.setRawMode(false)` 被调用 |

## 三、单终端 Attach 冲突

| # | 场景 | 操作 | 预期 |
|---|------|------|------|
| 21 | 两个终端 attach 同一会话 | 终端 A 已 attach，终端 B 尝试 attach | 终端 B 收到错误：Session already attached |
| 22 | `--force` 强制接管 | 终端 B `--attach <id> --force` | 终端 A 被踢出并显示 detach 提示，终端 B 接管 |
| 23 | 被踢终端恢复 | 终端 A 被 `--force` 踢出 | raw mode 恢复，stdout 输出 "Session detached" |

## 四、Headless 模式（手机端发起）

| # | 场景 | 操作 | 预期 |
|---|------|------|------|
| 24 | 新建会话 | Flutter FAB → 输入名称 → 开始 | `start_session` 发送，Gateway spawn headless Claude Code |
| 25 | 新建会话（无名称） | FAB → 直接点开始 | 成功创建，显示截断的 session ID |
| 26 | 发送 prompt | MessageFlow 输入文字 → 发送 | `send_prompt` 发送，消息流正常返回 |
| 27 | 连续发送多条 | 快速发送多条 prompt | 消息有序处理，不丢失不重复 |
| 28 | 终止会话 | 触发 `stopSession()` | `stop_session` → SIGTERM → 5s → SIGKILL |
| 29 | 删除会话 | 会话列表左滑删除 | `ClientDeleteSession` → 本地移除 + 服务端清理 |

## 五、模式切换（Handoff）

| # | 场景 | 操作 | 预期 |
|---|------|------|------|
| 30 | CLI attach headless | `mypilot session --attach <headless-id>` | headless → PTY handoff |
| 31 | 手机收到切换 snackbar | 执行上个场景 | 手机弹出 "xxx 已切换至 桌面端" |
| 32 | CLI detach 后来源 | `Ctrl+C` detach → 手机查看 | 来源图标变为 detached（`link_off`） |
| 33 | 手机收到 detach snackbar | 执行上个场景 | 手机弹出 "xxx 已切换至 已分离" |

## 六、Session 来源图标（手机 UI）

| # | 场景 | 操作 | 预期 |
|---|------|------|------|
| 34 | desktop 图标 | 查看 CLI 创建的会话 | 会话名旁显示 `desktop_windows` 图标，颜色 `overlay0` |
| 35 | mobile 图标 | 查看手机创建的会话 | 会话名旁显示 `phone_android` 图标 |
| 36 | detached 图标 | CLI `Ctrl+C` 后查看 | 会话名旁显示 `link_off` 图标 |
| 37 | 旧协议兼容 | 连旧版 Gateway（无 source 字段） | 不显示来源图标，不 crash |

## 七、新建会话 BottomSheet

| # | 场景 | 操作 | 预期 |
|---|------|------|------|
| 38 | 打开 BottomSheet | 点击 FAB | 弹出底部面板，TextField 自动聚焦 |
| 39 | 键盘弹起适配 | 点击 TextField | 面板随键盘上移（`viewInsets.bottom`） |
| 40 | 回车提交 | 输入名称后按回车 | 等同于点击"开始"，创建会话并关闭面板 |
| 41 | 取消 | 点击面板外部区域 | 面板关闭，不创建会话 |

## 八、Stop 事件降级

| # | 场景 | 操作 | 预期 |
|---|------|------|------|
| 42 | 服务端不阻塞 | Claude Code 触发 Stop hook | hook handler 返回 `{}`，不阻塞 |
| 43 | 客户端不进队列 | 手机收到 Stop 事件 | blocking indicator 不出现 |
| 44 | 消息流正常显示 | 查看消息流 | Stop 事件以 info 样式（紫色 `#cba6f7`，`⏸` 图标）显示 |

## 九、Session 生命周期

| # | 场景 | 操作 | 预期 |
|---|------|------|------|
| 45 | 正常退出 | Claude Code 正常退出 | `session_ended` 广播，进程资源清理 |
| 46 | 异常崩溃 | Claude Code 进程 crash | `session_ended` 广播，资源正确清理 |
| 47 | 手动 kill | `mypilot session --kill <id>` | `session_ended` 广播，进程终止 |
| 48 | Gateway shutdown | `mypilot stop` | 所有 session SIGTERM → 5s → SIGKILL |
| 49 | 24h 不活跃清理 | session 24h 无活动 | `cleanupStaleSessions` kill 进程 + removeSession |

## 十、WebSocket 多路复用

| # | 场景 | 操作 | 预期 |
|---|------|------|------|
| 50 | PTY relay 与 ws-gateway 不冲突 | 同时连接 CLI 和手机 | 两个 WebSocketServer 各自正常工作 |
| 51 | 手机断连不影响 PTY | 关闭手机 App | CLI PTY 会话继续运行 |
| 52 | CLI 断连不影响手机 | 关闭 CLI | 手机仍能观测 session 状态，来源变为 detached |
| 53 | 手机重连恢复 | 杀 App 后重新打开 | `GatewayConnected` 带回 sessions、source、pending interactions |

## 十一、并发场景

| # | 场景 | 操作 | 预期 |
|---|------|------|------|
| 54 | 多个活跃会话 | 创建 3+ 个会话（PTY + headless 混合） | 各自独立运行，`--list` 全部显示 |
| 55 | PTY 和 headless 同时操作 | CLI 和手机各自操作不同 session | 互不干扰 |
| 56 | 手机旁观 PTY 会话 | 手机进入 desktop 会话消息流 | 看到实时消息 |

## 十二、错误恢复

| # | 场景 | 操作 | 预期 |
|---|------|------|------|
| 57 | Claude Code 未安装 | 在无 Claude Code 的环境中创建 session | 错误提示，不 crash Gateway |
| 58 | stream-json 非 JSON 行 | headless 输出含 TUI escape codes | `adaptStreamJsonLine` 返回 null 过滤，不中断流 |
| 59 | PTY relay WS 异常断开 | 网络抖动 | 不 kill session，可重新 attach |

---

## 快速冒烟（核心路径）

优先执行以下 12 个场景，覆盖主要架构变更：

```
 1. CLI 新建会话并进入 TUI
15. 终端输入/输出正常交互
17. Ctrl+C 分离不杀进程
21. 双终端 attach 冲突检测
24. 手机新建 headless 会话
26. 手机发送 prompt
30. CLI attach headless → handoff
31. 手机收到切换 snackbar
34. 手机端 source 图标显示
42. Stop 事件不阻塞
45. Session 正常退出清理
49. 24h 不活跃自动清理
```
