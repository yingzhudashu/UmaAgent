# UmaAgent 代码审查记录

本文件是当前仓库的稳定审查入口，记录人工抽查结论、自动检查证据和未覆盖风险。自动扫描结果不等同于逐行人工审查；每次发布前必须重新运行 `npm run audit:source`、`npm run check` 和测试门禁，并在本文件补充对应 commit。

## 当前契约

- UmaAgent 版本：1.3.0
- Protocol：v15，HTTP API `/api/v15`
- SQLite：schema 22 唯一支持格式；其他版本直接拒绝启动
- Trace：独立 `telemetry.db`；业务状态位于 `state.db`

## 审查边界

| 区域 | 职责边界 | 已核对内容 | 证据 | 未覆盖风险 |
| --- | --- | --- | --- | --- |
| `packages/core` | 运行、权限、工具、队列、数据库 | 状态转换、事务、取消、恢复、所有权 | Core 单元测试、`npm run check` | 真实外部服务故障组合仍需隔离演练 |
| `packages/protocol` | TypeBox 契约和事件 | v15 schema、严格字段、事件载荷 | Protocol 构建与测试 | 新事件消费者需在变更中同步审查 |
| `packages/client` | HTTP/WebSocket 客户端边界 | traceparent、错误、重连、分页 | Client 测试 | 弱网长时间运行需 soak |
| `packages/telemetry` | Span、资源样本、分页和 OTLP | 脱敏、属性上限、未完成 Span、独立数据库 | Telemetry/Core 测试 | 跨服务 OTLP 实网端到端需显式配置 |
| `apps/server` | Fastify、认证、所有权和 HTTP 映射 | v15 路由、错误分类、健康检查 | Server 测试、E2E | 反向代理特殊头部需生产验收 |
| `apps/web` | 聊天、设置、附件和响应式布局 | 状态文案、长文本、登出、附件协议 | Web 单测、Playwright | 浏览器差异需发布后抽查 |
| 部署与文档 | 发布、备份、恢复、版本事实源 | schema/PAT 门禁和 release 流程 | `docs/deployment.md`、CI | 生产发布受保护 secret 存在性阻断 |

## 重点审查结论

1. 数据库启动严格要求 schema 22；没有迁移实现、降级路径或兼容层。
2. 新 Trace 只写入 `telemetry.db`。`state.db` 中的 `trace_spans` 仅保留为历史结构，不得由新代码写入。
3. Trace 属性、错误和事件均有长度限制和敏感字段脱敏；诊断失败不能改变业务结果。
4. 所有生产发布必须先备份 SQLite、执行完整性检查，并验证受保护用户的令牌元数据和对象指纹。
5. 机器审计只能发现模式性问题，不能替代复杂状态机、取消、并发和数据保护边界的人工审查。

## 移动端登录修复审查（2026-09-06）

- `android/app/src/main/java/site/robotclaw/umaagent/Api.kt` 的共享请求层曾将无参数 `POST`、`PUT`、`PATCH` 编码为 0 字节 JSON body，Fastify JSON 解析器会拒绝该请求并返回 `Body cannot be empty when content-type is set to 'application/json'`。
- 修复后无参数 JSON 请求发送 `{}`，不改变有业务参数请求、认证头或 multipart 上传协议。
- `android/app/src/test/java/site/robotclaw/umaagent/ApiTest.kt` 已断言 bootstrap 请求的方法、JSON media type 和 `{}` body；Android `:app:testDebugUnitTest` 的 37 个测试通过。
- 线上 APK 发布仍受正式签名 keystore 门禁约束；当前只完成源码修复和本地构建，未替换生产 APK。

## 当前证据（2026-09-02）

- `npm run audit:source`：完成一方源文件的模式审计；结果用于定位热路径、IO、并发和凭据边界，不冒充人工逐行结论。
- `npm run check`：架构、Biome 和 TypeScript 通过，共检查 232 个文件；已记录的大文件尺寸债务均未继续增长。
- `npm run build`：Protocol、Core、Server、CLI、Web、Xianyu Adapter、Browser Worker 全部构建通过。
- `npm test`：51 个测试文件、273 项测试通过；覆盖 Trace 幂等、诊断聚合和快捷命令边界。
- `npm run test:web:e2e`：Chromium 5 个用例全部通过；测试复用首个测试账户以遵守测试服务器每日注册限流，未修改生产限流策略。
- `npm run test:eval:faux`：6 个公开行为用例通过，包括澄清、Plan 确认、工具、凭据和提示注入边界。
- `npm run test:perf`：20 个请求基准通过；最终数值记录在 `docs/architecture-quality.md`。
- 短时 Faux soak：36.6 秒、41 条消息、492 个事件；RSS 143,351,808 -> 145,514,496 bytes，WAL 峰值 1,961,152 bytes，均在预算内；长时 soak 仍由 CI/nightly 执行。
- 真实 Provider：服务器隔离端口两次真实 smoke 均通过，完成注册、模型调用、Run 和 Trace 查询；测试使用临时资源并已清理，生产服务未重启。
- 容器：当前 Windows 主机没有 Docker CLI；容器构建与 smoke 由 CI 和候选服务器继续验证。
- Android：Gradle Wrapper 与 API 35 的 JVM 测试 37 项、debug assemble 已通过；本次登录修复已加入回归断言，设备 instrumented 测试和正式 APK 发布仍待执行。
- 生产：本轮未连接生产服务器，未执行旧渠道运行面清理、咸鱼 secret 注入或真实账号 smoke。

## 追加线上核查（2026-09-06）

- 只读核查 `https://robotclaw.site/api/v15/health/live` 返回 200；Core 未因本次 Android 修复重启或切换。
- 只读核查 `/app/latest.json` 返回线上 Android `versionCode 4`、`versionName 1.1.2`、release `4-b54f787`；当前 APK 仍为旧构建，未发布本次修复。
- 线上 APK 的正式签名主体为 `CN=UmaAgent`。本机未找到原 keystore，因此没有执行不安全的 Debug/新证书替换。

## 固定验证命令

```text
npm run audit:source
npm run check
npm test
npm run build
npm run build:web:embed
npm run test:web:e2e
npm run test:perf
npm run test:soak:faux
```

真实 API 测试必须使用隔离 state、workspace、临时用户和临时令牌，并显式设置 `UMA_REAL_API=1`；缺少配置时必须明确报告未执行，不得把 Faux 结果冒充真实结果。
