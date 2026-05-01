## 开发原则

### assistant 始终以中文回复

- 所有对话、解释、注释均使用中文
- 代码标识符、技术术语保留原样

### 不要过度设计

- 避免抽象和过度封装
- 先让它工作，再考虑优化
- 简单的数据结构（JSON 文件）比复杂的存储更好

### 大型任务拆分与并行执行

- 大型任务必须拆分成小的、独立的子任务（wave）
- 同一 wave 内无依赖关系的子任务应并行执行（使用 Agent 工具）
- 识别任务间的依赖关系，按依赖顺序组织 wave 执行
- 每个 wave 完成后再启动下一个依赖它的 wave

### TDD 开发流程

**严格遵循：先写测试，再写功能**

```bash
# 1. 先写测试
# 2. 运行测试（失败）
# 3. 编写最小代码让测试通过
# 4. 重构（如果需要）
# 5. 重复
```

### 命令

```bash
npm run dev           # 启动 Gateway（tsx 热重载）
npm run stop:dev      # 停止开发服务器
npm run restart:dev   # 重启开发服务器
npm run build         # 构建后端（tsc）
npm start             # 启动 Gateway（生产环境）
npm stop              # 停止 Gateway（生产环境）
npm test              # 运行测试（vitest）
npm run typecheck     # 仅类型检查

# Docker
npm run docker:build   # 构建 Docker 镜像
npm run docker:up      # 启动 Docker 容器
npm run docker:down    # 停止 Docker 容器
```

### 架构

数据目录：`~/.mypilot/`

### 文档绘图使用 Mermaid

- 所有文档中的图表、流程图、时序图等均使用 Mermaid 语法
- 禁止使用 ASCII art 或其他绘图方式

### 参考资料

- Claude Code Hooks 文档：https://code.claude.com/docs/en/hooks

### 关联项目

- **客户端项目**：`../cc-notify/` — Flutter 移动端应用
- **架构**：本项目为服务端，cc-notify 为客户端，采用 C/S 架构

### 协议版本管理

`src/shared/protocol.ts` 中的 `PROTOCOL_VERSION` 定义当前协议版本（单一递增整数，不使用 Semver）。客户端项目 `../cc-notify/` 中也有同名常量。

客户端连接时校验 `MIN_SERVER_VERSION ≤ serverVersion ≤ PROTOCOL_VERSION`，超出范围则提示用户升级对应端。

修改规则：

- **新增可选字段、新增消息类型** → 不升版本，未知消息类型被忽略（Tolerant Reader）
- **删除/重命名字段、变更加密** → 升版本号，旧客户端收到更新提示
- **修改 `PROTOCOL_VERSION` 时** 必须同步修改 `../cc-notify/` 中的对应常量，保持两边值一致
