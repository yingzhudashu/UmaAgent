# UmaAgent

 UmaAgent 是一个 TypeScript Agent 平台。Agent 核心、会话、模型凭据、工具和持久化运行在独立 Core Server；CLI、Web 和渠道 Adapter 通过同一 HTTP/WebSocket 客户端访问它。当前版本为 `1.3.0`，协议版本为 `15`，SQLite schema 为 `22`。

生产服务器部署请直接阅读 [服务器部署与验收](docs/deployment.md)；其他设计和质量文档见 [文档索引](docs/README.md)。

## 当前能力

- Pi `0.84.2` 的多模型流式 Agent loop，支持 OpenAI Responses 与兼容 Chat Completions 端点
- 自适应预检：直接执行、澄清或显示计划；计划任务结束后执行一次结果验证
- SQLite WAL 会话、运行、transcript、工具、审批、附件、记忆和 FTS5 知识库
- 服务器工作区边界、符号链接逃逸检查、HTTP SSRF 防护，以及 shell/不可控外部副作用审批
- `SKILL.md` 发现以及 MCP stdio/Streamable HTTP 工具
- 共享 `@uma-agent/client`、行式 CLI、响应式 Web 工作台
- Snapshot + 永久事件游标同步、运行检查点和显式副作用恢复决策
- Web IndexedDB 离线只读缓存、PWA shell 和独立 Channel Adapter 契约
- Bearer Token、HttpOnly Web Cookie、Origin 校验、登录限流和日志脱敏
- 持久化 once/interval/cron 调度、Tavily/Stack Exchange 搜索和只读运营报告
- PDF、DOCX、PPTX、XLSX 异步知识摄取，以及独立 Playwright Browser MCP Worker
- 只通过 Client SDK 运行的黑盒 Eval Runner
- Session 可选择严格 FIFO `queue` 或安全抢占 `preemptive`；澄清消息始终续接原 Run，副作用未决时不会启动替代 Run
- `/review` 三轮内无工具审查与 `/improve` 不可变答案修订链
- Agent Profile、结构化渐进记忆、事实 supersede、历史 rollup 与按需原文回溯
- 技能包 staging、风险扫描、人工启用和热刷新；包含可执行代码的技能包会被拒绝
- 证据化优化提案；接受提案后可在固定验证命令约束下备份、原子应用、失败回滚和人工回滚
- 每 Run 工具循环保护：重复调用、无进展结果和 A/B ping-pong 会先产生公开告警，再以 `tool_loop_detected` 安全终止
- 持久化 Faux/real 评测报告、跨设备评测历史，以及知识搜索、重建索引和终态任务清理
- 每个 Session 可独立设置助手名称和头像；头像仅接受图片附件并校验会话所有权

## 本地启动

要求 Node.js `>=22.19.0`。

```powershell
npm install --ignore-scripts
Copy-Item uma.config.example.json uma.config.json
$env:UMA_OAUTH_REDIRECTS = "uma-mobile|com.example.uma:/oauth/callback"
$env:OPENAI_API_KEY = "你的模型密钥"
npm run build
npm start
```
默认配置唯一使用 tcvps Provider（`https://api.tcvps.cn/v1`）。模型密钥通过 `$env:OPENAI_API_KEY` 注入；不支持备用 Provider 或自动故障转移。
打开 `http://127.0.0.1:3210`。CLI 使用：

```powershell
$env:UMA_TOKEN = "个人访问令牌"
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

## 嵌入现有站点

RobotClaw 等宿主站点使用独立的库构建，不注册 Service Worker，也不修改宿主的 `body`：

```powershell
npm run build:web:embed
```

产物位于 `apps/web/dist-embed`，固定为 `uma-embed.js`、`uma-embed.css` 和包含 SHA-256 的
`embed-manifest.json`。宿主加载 CSS 后调用：

```ts
const mounted = mountUmaAgent(target, {
  coreUrl: window.location.origin,
  embedded: true,
  theme: "light",
})
mounted.setTheme("dark")
mounted.unmount()
```

所有样式均限定在 `.uma-embed`，宿主可通过 `--primary`、`--primary-dark`、`--text`、`--bg`、
`--bg-card`、`--bg-hover`、`--border` 和 `--shadow` 传入现有设计系统变量。

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
- `skillsDirs`：递归扫描 `SKILL.md`；Core 内置 `builtin-web`、`builtin-stackexchange`、`skill-creator`、`skill-vetter`，外部 Skill 可使用 MiniAgent 风格的 `keywords`、`metadata.env/bins/os/always`、`scope`、`user_invocable` 和 `disable_model_invocation`
- `mcpServers`：`stdio` 需要 `command/args`，`http` 需要 Streamable HTTP `url`
- 非回环 HTTP MCP 应设置 `authTokenEnv`，Core 从该环境变量注入 Bearer Token
- `runtime.maxParallelSessions`：跨会话并发上限；单会话默认 FIFO，也可在 Session 上设为安全抢占模式

数据库只接受当前 `PRAGMA user_version`。版本不匹配会拒绝启动；本项目不提供旧格式迁移或兼容层。

## API 摘要

服务器支持多用户隔离：`POST /api/v15/auth/register` 创建用户并一次性返回个人令牌，
`/auth/login` 将令牌交换为绑定用户的 HttpOnly Cookie，`/auth/me`、`/auth/tokens` 提供令牌
查询和撤销。Session、Run、Task、Approval、Message、Attachment 和工作区请求均按用户所有权
校验。移动端或其他网页可使用 `/auth/authorize` + `/auth/token` 的 S256 PKCE 流程；服务器只
接受环境变量 `UMA_OAUTH_REDIRECTS` 中的精确 `clientId|redirectUri` 配对。

- `GET/POST /api/v15/sessions`
- `GET /api/v15/sessions/:id/snapshot`
- `GET /api/v15/sessions/:id/events?after=<sequence>` 增量事件
- `GET /api/v15/sessions/:id/history?before=<sequence>` 历史分页
- `POST /api/v15/sessions/:id/messages|cancel|compact`
- `PATCH /api/v15/sessions/:id` 可更新 `title`、`queueMode`、`assistantName` 和 `assistantAvatarAttachmentId`
- `POST /api/v15/messages/:id/review|improve`、`GET /api/v15/runs/:id/quality`
- `POST /api/v15/sessions/:id/commands` 在 Core 工作区执行始终审批的 Shell 命令
- `GET /api/v15/attachments/:id/content`
- `GET /api/v15/runs/:id/checkpoints|actions`
- `POST /api/v15/runs/:id/resume|cancel`
- `POST /api/v15/runs/:id/actions/:actionId/decide`
- `POST /api/v15/approvals/:id`、`POST /api/v15/uploads`
- `GET /api/v15/health/live|ready`
- `GET /api/v15/events` WebSocket
- `/api/v15/models`、`skills`、`mcp`、`knowledge`、`tasks`、`memory`、`audit`
- `GET /api/v15/knowledge/search`、`POST /api/v15/knowledge/:id/reindex`
- `GET/POST /api/v15/evaluations`、`GET /api/v15/evaluations/:id`
- `DELETE /api/v15/tasks/:id` 仅删除终态任务记录，不删除关联 Session、Run 或审计链
- `/api/v15/profile`、`sessions/:id/activity`、`sessions/:id/history/search`
- `/api/v15/skills/search|install` 与技能 enable/disable/reject 生命周期
- `POST /api/v15/admin/reload` 原子重载模型角色、技能和 MCP；静态字段返回 `restartRequired`
- `GET /api/v15/admin/config` 只返回模型引用、Role、技能/MCP 状态和配置 revision，不返回凭据
- `/api/v15/schedules` 调度 CRUD、立即执行与运行历史
- `GET /api/v15/reports/operations|diagnostics|resources` 脱敏运行、Trace 延迟和 CPU/RSS/WAL 统计
- `GET /api/v15/traces?runId=<runId>` 查询 Run 的完整持久化 Trace Span 树，也支持按 Trace、时间、状态和名称过滤
- `/api/v15/optimization-proposals` 提供证据、建议和人工接受/拒绝；`/api/v15/optimization-applications` 提供验证、回滚记录

WebSocket 使用 Cookie，或在连接后的第一帧发送 `{ "type": "auth", "token": "..." }`，随后发送 `{ "type": "subscribe", "sessions": [{ "id": "...", "lastSequence": 42 }] }`。快照始终是事实源，客户端使用永久事件游标补齐断线期间的变更。



Docker 中请改用 `docker/config.user.example.json` 生成 `docker/config.user.json`；其中 Core 地址必须是 Compose 服务名 `http://uma:3210`。

通用渠道类型、指数退避和节流工具由 `@uma-agent/channel-adapter` 提供；Core 不依赖任何渠道 SDK。

## 咸鱼控制台

咸鱼入口由 Web、CLI 和 Android 统一调用 Core API，客户端不直接访问 Adapter。先在服务端设置 `UMA_XIANYU_CONTROL_TOKEN` 与 `UMA_XIANYU_ADMIN_PASSWORD_HASH`，再启动 `uma-xianyu-adapter`。管理员密码使用 `scrypt$N$r$p$salt$digest` 格式；登录用户解锁后获得仅存于内存、有效 30 分钟的 Grant。CLI 用法：

```text
uma xianyu status|start|stop|pause|resume
uma xianyu history <conversation-id>
uma xianyu item <item-id>
```

Android 工程位于 `android/`，应用 ID 为 `site.robotclaw.umaagent`，生产 Core 地址固定为 `https://robotclaw.site`。登录页可直接注册隔离账户；注册返回的个人访问令牌仅展示一次，复制并继续后由 Android Keystore 加密保存。登录后使用对话、会话、资源和设置四个移动端视图，并跟随系统深浅色主题；离线状态只读。

## 质量、记忆与技能

### 交互模式与执行路由

请求中的 `mode` 是用户选择的执行模式，Preflight 只负责目标、成功标准、问题和假设；`route` 由服务端根据模式派生：

| 用户模式 `mode` | 系统路由 `route` | 行为 |
| --- | --- | --- |
| `plan` | `plan` | 先创建并执行步骤，再统一验证；敏感操作仍需审批。 |
| `agent` | `direct` | 进入完整 Agent loop，可按权限调用工具。 |
| `agent` | `clarify` | 信息不足，Run 进入 `awaiting_input`，下一条消息补充原 Run。 |

因此，`plan` 是“规划并执行”，`agent` 是“直接执行”；`clarify` 只表示 Preflight 阶段确实缺少关键输入，不是用户模式。模型不能覆盖用户选择的执行策略。

`queue` 模式按 Session 严格 FIFO，最多等待 100 条；`preemptive` 在新消息到达时取消旧排队 Run，并请求取消活动 Run。若活动工具可能产生副作用，其 Action 会转为 `uncertain`，必须先 acknowledge 或 reject，新 Run 才能继续。`awaiting_input` 的下一条消息始终作为原 Run 的澄清补充，不参与抢占。

`/review [反馈]` 对目标答案执行最多三轮、无工具的结构化审查；`/improve` 根据最近评估只重写一次，`--force` 先评估，`--reset` 从原始答案而不是最近修订重写。原答案永久不变，新答案使用 `parentMessageId` 建立不可变消息树。

Core 仅向上下文注入 Profile、active 事实和相关历史 rollup。事实 key 出现明确新值时，旧事实转为 `superseded` 并保留来源和证据；原始 transcript 仍是唯一历史原文。`history_search` 与 `history_read` 是只读工具，允许 Agent 从摘要回溯原文。

技能安装先进入 staging：Core 校验元数据、路径、数量、大小、疑似凭据、危险命令和动态执行，再由所有者 enable。Core 只读取 `SKILL.md` 与静态资源，包含可执行代码的技能包会被拒绝。Skill frontmatter 的环境变量、系统命令、操作系统和作用域门控在刷新时生效；被 `disable_model_invocation` 标记的 Skill 不会进入模型提示词。配置和技能重载采用“完整校验后原子替换”；活动 Run 继续使用其冻结的模型与工具快照。`stateDir`、监听地址、认证及 workspace roots 等变更只报告 `restartRequired`。

## 浏览器 Worker 与评测

Browser Worker 是独立 MCP Streamable HTTP 服务，原生启动默认只监听 `127.0.0.1:3230`；Compose 中监听容器网络但不发布宿主机端口。它不挂载 Core 业务 state 或 workspace，只共享独立 telemetry 目录。所有页面请求和重定向都执行公网地址校验；普通浏览器 MCP 操作自动执行，只有被权限策略判定为不可控高风险的动作才要求审批。原生启动后在 `mcpServers` 中配置 `http://127.0.0.1:3230/mcp`：

```powershell
npm run build --workspace=@uma-agent/browser-worker
npm run start --workspace=@uma-agent/browser-worker
```

黑盒评测只使用公开 Client SDK：

```powershell
$env:UMA_SERVER_URL = "http://127.0.0.1:3210"
$env:UMA_TOKEN = "个人访问令牌"
node apps/eval-runner/dist/main.js eval-suite.json
```

评测只读取终态 Run 和公开 transcript，不读取数据库、隐藏思维链，也不修改代码或执行 Git。
完成的不可变报告会通过 Client SDK 上传到 Core；CLI 的 `uma eval`/`/test` 与 Web Evaluation 区域读取同一份跨设备历史。Diagnostics 与 Optimization 区域只展示公开审计聚合和人工提案状态，不提供补丁应用入口。



## 部署

生产部署不要直接复用开发 `.env` 或修改受版本控制的配置。先创建本地密钥文件和生产配置：

```bash
cp .env.example .env
cp deploy/uma.config.production.example.json deploy/uma.config.production.json
# 编辑两个文件，设置独立高熵令牌、模型密钥、Provider/模型信息和精确 webOrigins
docker compose -f docker-compose.yml -f deploy/docker-compose.production.yml config --quiet
docker compose -f docker-compose.yml -f deploy/docker-compose.production.yml up -d --build
```


## 架构边界

```text
apps/web ─┐
apps/cli ─┼─> packages/client ─> packages/protocol
channels ─┘

apps/server ─> packages/core ─> Pi AI/Agent
                  └───────────> packages/protocol
```


## 质量检查

```bash
npm run check
npm test
npm run test:coverage
npm run build
npx playwright install chromium
npm run test:web:e2e
npm run test:eval:faux
npm run test:soak:faux # 默认 4 小时；可用 UMA_SOAK_HOURS=8 延长
npm run test:real:smoke # 需 UMA_REAL_API=1，并显式提供 UMA_REAL_* 配置
npm run test:real:eval
npm run test:real:perf
npm run test:real:soak
```
