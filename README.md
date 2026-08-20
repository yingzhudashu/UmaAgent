# UmaAgent

UmaAgent 是一个 TypeScript Agent 平台。Agent 核心、会话、模型凭据、工具和持久化运行在独立 Core Server；CLI、Web 和渠道 Adapter 通过同一 HTTP/WebSocket 客户端访问它。当前版本为 `0.7.0`，协议版本为 `6`，SQLite schema 为 `7`。

## 当前能力

- Pi `0.84.2` 的多模型流式 Agent loop，支持 OpenAI Responses 与兼容 Chat Completions 端点
- 自适应预检：直接执行、澄清或显示计划；计划任务结束后执行一次结果验证
- SQLite WAL 会话、运行、transcript、工具、审批、附件、记忆和 FTS5 知识库
- 服务器工作区边界、符号链接逃逸检查、HTTP SSRF 基础防护、shell/MCP 审批
- `SKILL.md` 发现以及 MCP stdio/Streamable HTTP 工具
- 共享 `@uma-agent/client`、行式 CLI、响应式 Web 工作台
- Snapshot + 永久事件游标同步、运行检查点和显式副作用恢复决策
- Web IndexedDB 离线只读缓存、PWA shell 和独立 Channel Adapter 契约
- Bearer Token、HttpOnly Web Cookie、Origin 校验、登录限流和日志脱敏
- 持久化 once/interval/cron 调度、Tavily/Stack Exchange 搜索和只读运营报告
- PDF、DOCX、PPTX、XLSX 异步知识摄取，以及独立 Playwright Browser MCP Worker
- 只通过 Client SDK 运行的黑盒 Eval Runner

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

CLI 是独立客户端进程，但不包含 Core。远程连接时使用：

```powershell
$env:UMA_SERVER_URL = "https://core.example.com"
$env:UMA_TOKEN = "服务器访问令牌"
npm run cli -- doctor
npm run cli -- chat
```

也可使用 `--server=https://core.example.com --token=...`，命令行参数优先于环境变量。`doctor` 会检查健康状态、协议版本、认证和模型目录。

开发时分别运行 `npm run dev` 和 `npm run dev:web`，Web 开发服务器位于 `http://127.0.0.1:3211`。

## 独立 Web 部署

Web 默认连接 `window.location.origin`，因此仍可由 Core Server 同源托管。独立部署到 CDN、Caddy 或 Nginx 时，在构建阶段指定 Core 地址：

```powershell
$env:VITE_UMA_CORE_URL = "https://core.example.com"
npm run build:web
```

将 `apps/web/dist` 作为普通静态站点发布，并把该站点的精确 Origin（例如 `https://uma.example.com`）加入 Core 配置的 `server.webOrigins`。跨站 Cookie 仅在 HTTPS 下使用 `SameSite=None; Secure`；生产环境必须由反向代理终止 TLS。

无需模型密钥的端到端开发服务器使用 Pi faux provider：

```powershell
npm run dev:faux
```

默认地址为 `http://127.0.0.1:3210`，默认开发令牌为 `uma-dev-token`，并允许同源 Web 与 `http://127.0.0.1:3211` Vite 开发端。可通过 `UMA_FAUX_PORT`、`UMA_FAUX_TOKEN`、`UMA_FAUX_STATE` 和逗号分隔的 `UMA_FAUX_WEB_ORIGINS` 覆盖；该入口只用于本地开发与测试。

## 配置

UmaAgent 只读取一个严格 JSON 配置文件，未知字段会导致启动失败。使用 `UMA_CONFIG` 或 `--config=路径` 指定文件。秘密只能通过配置中声明的环境变量传入。

- `server.workspaceRoots`：服务器允许建立会话的真实目录根列表
- `server.webOrigins`：允许访问 Core 的精确 Web Origin，不接受路径或通配符
- `providers`、`models`、`roles`：Provider 凭据、模型 profile 和 default/reasoning/fast/vision 路由；所有角色必须显式配置
- `skillsDirs`：递归扫描 `SKILL.md`，只加载说明，不执行技能代码
- `mcpServers`：`stdio` 需要 `command/args`，`http` 需要 Streamable HTTP `url`
- `runtime.maxParallelSessions`：跨会话并发上限；单会话始终 FIFO

数据库只接受当前 `PRAGMA user_version`。版本不匹配会拒绝启动；本项目不提供旧格式迁移或兼容层。

## API 摘要

- `GET/POST /api/v6/sessions`
- `GET /api/v6/sessions/:id/snapshot`
- `GET /api/v6/sessions/:id/events?after=<sequence>` 增量事件
- `GET /api/v6/sessions/:id/history?before=<sequence>` 历史分页
- `POST /api/v6/sessions/:id/messages|cancel|compact`
- `GET /api/v6/attachments/:id/content`
- `GET /api/v6/runs/:id/checkpoints|actions`
- `POST /api/v6/runs/:id/resume|cancel`
- `POST /api/v6/runs/:id/actions/:actionId/decide`
- `POST /api/v6/approvals/:id`、`POST /api/v6/uploads`
- `GET /api/v6/health/live|ready`
- `GET /api/v6/events` WebSocket
- `/api/v6/models`、`skills`、`mcp`、`knowledge`、`tasks`、`memory`、`audit`
- `/api/v6/schedules` 调度 CRUD、立即执行与运行历史
- `GET /api/v6/reports/operations` 脱敏运行统计

WebSocket 使用 Cookie，或在连接后的第一帧发送 `{ "type": "auth", "token": "..." }`，随后发送 `{ "type": "subscribe", "sessions": [{ "id": "...", "lastSequence": 42 }] }`。快照始终是事实源，客户端使用永久事件游标补齐断线期间的变更。

## 飞书 Adapter

飞书接入是独立进程，不访问 Core SQLite。构建后使用以下环境变量启动：

```powershell
$env:FEISHU_APP_ID = "..."
$env:FEISHU_APP_SECRET = "..."
$env:FEISHU_VERIFICATION_TOKEN = "..."
$env:FEISHU_ENCRYPT_KEY = "..."
$env:FEISHU_ALLOWED_OPEN_IDS = "ou_owner_open_id"
$env:UMA_SERVER_URL = "http://127.0.0.1:3210"
$env:UMA_TOKEN = $env:UMA_AUTH_TOKEN
$env:FEISHU_HOST = "127.0.0.1"
npm run build --workspace=@uma-agent/feishu-adapter
npm run start --workspace=@uma-agent/feishu-adapter
```

Adapter 只接受 `FEISHU_ALLOWED_OPEN_IDS` 白名单中的所有者。Webhook 在签名校验后先持久化去重记录并立即 ACK，后台 Worker 再处理；重启会恢复 pending 入站。私聊全部进入 Core，群聊仅处理白名单用户 @机器人或回复 Adapter 已发送消息的内容；文本、图片和文件会转换为标准消息与 Attachment。运行卡片支持审批、恢复及副作用 Action 决策，更新采用一秒尾随节流且终态立即定稿。按钮只携带短期 opaque token，重复点击保持幂等。Adapter 自己的 SQLite 只保存会话映射、入站队列、卡片游标和回调状态。
通用渠道类型、指数退避和节流工具由 `@uma-agent/channel-adapter` 提供；Core 不依赖任何渠道 SDK。

## 浏览器 Worker 与评测

Browser Worker 是独立 MCP Streamable HTTP 服务，只监听 `127.0.0.1:3230`，不挂载 Core state 或 workspace。所有页面请求和重定向都执行公网地址校验；Core 端仍把其工具视为 MCP 副作用并要求审批。启动后在 `mcpServers` 中配置 `http://127.0.0.1:3230/mcp`：

```powershell
npm run build --workspace=@uma-agent/browser-worker
npm run start --workspace=@uma-agent/browser-worker
```

黑盒评测只使用公开 Client SDK：

```powershell
$env:UMA_SERVER_URL = "http://127.0.0.1:3210"
$env:UMA_TOKEN = $env:UMA_AUTH_TOKEN
node apps/eval-runner/dist/main.js eval-suite.json
```

评测只读取终态 Run 和公开 transcript，不读取数据库、隐藏思维链，也不修改代码或执行 Git。

## 部署

```bash
export UMA_AUTH_TOKEN="$(openssl rand -hex 32)"
export OPENAI_API_KEY="..."
docker compose up --build
```

飞书服务使用独立 profile 启动：

```bash
docker compose --profile feishu up --build
```

Compose 默认只发布到 `127.0.0.1`，镜像包含健康检查并使用 `/data/state`、`/data/workspace` 独立卷。公网部署应通过 Caddy/Nginx 终止 TLS，并在配置中列出允许的 `webOrigins`。Core Server 使用状态目录锁和单进程 SQLite，不能横向启动多个副本共享同一状态卷。

### 停机备份与恢复

先停止 Core，确认进程已经退出，再备份状态目录中的 `state.db`、存在时的 `state.db-wal`、`uploads/`，以及正在使用的配置模板。不要备份 `.env`、API Key、Bearer Token 或渠道 Secret。恢复时使用同一 UmaAgent 版本，把这些文件放回新的状态目录并保持原有相对结构；schema 版本不匹配时必须显式重置，不能用旧数据库启动或自动升级。飞书 Adapter 的 `feishu.db` 应在停止 Adapter 后单独备份，它不属于 Core 状态卷。

非回环地址（例如 `0.0.0.0`）必须配置至少一个 `server.webOrigins`。服务令牌和每个模型的 API Key 都必须通过声明的环境变量提供，否则 Server 拒绝启动。

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
npm run test:coverage
npm run build
npx playwright install chromium
npm run test:web:e2e
```

单元与集成测试覆盖 Runtime、SQLite、Protocol、Client、Server、CLI JSON 流、Web 离线缓存和飞书持久队列；Playwright 使用两个独立浏览器上下文验证同一 Session 的实时同步与离线只读。Docker 构建也属于 CI 门禁；本机没有 Docker 时可先完成其余门禁，再在 CI 或具备 Docker Engine 的环境验证两个镜像。
