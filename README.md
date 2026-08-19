# UmaAgent

UmaAgent 是一个 TypeScript Agent 平台。Agent 核心、会话、模型凭据、工具和持久化运行在独立 Core Server；CLI 和 Web 通过同一 HTTP/WebSocket 客户端访问它。

## 当前能力

- Pi `0.84.2` 的多模型流式 Agent loop，支持 OpenAI Responses 与兼容 Chat Completions 端点
- 自适应预检：直接执行、澄清或显示计划；计划任务结束后执行一次结果验证
- SQLite WAL 会话、运行、transcript、工具、审批、附件、记忆和 FTS5 知识库
- 服务器工作区边界、符号链接逃逸检查、HTTP SSRF 基础防护、shell/MCP 审批
- `SKILL.md` 发现以及 MCP stdio/Streamable HTTP 工具
- 共享 `@uma-agent/client`、行式 CLI、响应式 Web 工作台
- Bearer Token、HttpOnly Web Cookie、Origin 校验、登录限流和日志脱敏

## 本地启动

要求 Node.js `>=22.19.0`。

```powershell
npm install --ignore-scripts
Copy-Item uma.config.example.json uma.config.json
$env:UMA_AUTH_TOKEN = "生成一个高熵令牌"
$env:OPENAI_API_KEY = "你的模型密钥"
npm run build
npm start
```

打开 `http://127.0.0.1:3210`。CLI 使用：

```powershell
$env:UMA_TOKEN = $env:UMA_AUTH_TOKEN
node apps/cli/dist/main.js chat
```

开发时分别运行 `npm run dev` 和 `npm run dev --workspace=@uma-agent/web`，Web 开发服务器位于 `http://127.0.0.1:3211`。

无需模型密钥的端到端开发服务器使用 Pi faux provider：

```powershell
npm run dev:faux
```

默认地址为 `http://127.0.0.1:3210`，默认开发令牌为 `uma-dev-token`。可通过 `UMA_FAUX_PORT`、`UMA_FAUX_TOKEN` 和 `UMA_FAUX_STATE` 覆盖；该入口只用于本地开发与测试。

## 配置

UmaAgent 只读取一个严格 JSON 配置文件，未知字段会导致启动失败。使用 `UMA_CONFIG` 或 `--config=路径` 指定文件。秘密只能通过配置中声明的环境变量传入。

- `server.workspaceRoots`：服务器允许建立会话的真实目录根列表
- `models`：显式模型目录；同一 provider 的模型必须共享 `baseUrl` 和 `apiKeyEnv`
- `skillsDirs`：递归扫描 `SKILL.md`，只加载说明，不执行技能代码
- `mcpServers`：`stdio` 需要 `command/args`，`http` 需要 Streamable HTTP `url`
- `runtime.maxParallelSessions`：跨会话并发上限；单会话始终 FIFO

数据库只接受当前 `PRAGMA user_version`。版本不匹配会拒绝启动；本项目不提供旧格式迁移或兼容层。

## API 摘要

- `GET/POST /api/v1/sessions`
- `GET/PATCH/DELETE /api/v1/sessions/:id`
- `POST /api/v1/sessions/:id/messages`，返回 `202 { runId, status }`
- `POST /api/v1/sessions/:id/cancel`
- `POST /api/v1/approvals/:id`
- `POST /api/v1/uploads`
- `GET /api/v1/events` WebSocket
- `/api/v1/models`、`skills`、`mcp`、`knowledge`

WebSocket 使用 Cookie，或在连接后的第一帧发送 `{ "type": "auth", "token": "..." }`，随后发送 `{ "type": "subscribe", "sessionIds": [...] }`。快照始终是事实源，客户端重连后重新拉取快照。

## 部署

```bash
export UMA_AUTH_TOKEN="$(openssl rand -hex 32)"
export OPENAI_API_KEY="..."
docker compose up --build
```

Compose 默认只发布到 `127.0.0.1`。公网部署应通过 Caddy/Nginx 终止 TLS，并在配置中列出允许的 `webOrigins`。Core Server 使用单进程 SQLite，不能横向启动多个副本共享同一状态卷。

## 架构边界

```text
apps/web ─┐
apps/cli ─┼─> packages/client ─> packages/protocol
channels ─┘

apps/server ─> packages/core ─> Pi AI/Agent
                  └───────────> packages/protocol
```

`core` 不依赖 Fastify 或 UI；客户端不直接访问数据库或 Agent 对象。未来飞书、桌面端和移动端应使用共享 Client SDK，不把渠道 SDK 引入 Core。

## 质量检查

```bash
npm run check
npm test
npm run build
```
