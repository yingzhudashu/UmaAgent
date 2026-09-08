# UmaAgent 代码审查记录

本文件是当前仓库的稳定审查入口，记录人工抽查结论、自动检查证据和未覆盖风险。自动扫描结果不等同于逐行人工审查；每次发布前必须重新运行 `npm run audit:source`、`npm run check` 和测试门禁，以实际输出确认结果。

## 当前契约

- UmaAgent 版本：1.3.0
- Protocol：v15，HTTP API `/api/v15`
- SQLite：schema 24 为当前格式；旧版本直接拒绝启动，发布前清理旧库，不提供 migration/fallback
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

1. 数据库启动严格要求 schema 24；旧 state.db 必须在发布前清理。
2. Trace 与资源样本只写入 `telemetry.db`；state.db 不再包含 `trace_spans` 或 `resource_snapshots`。
3. Trace 属性、错误和事件均有长度限制和敏感字段脱敏；诊断失败不能改变业务结果。
4. 当前 schema 的常规发布保留业务数据并检查对象指纹；切换旧格式必须停机清理后初始化，再重新建立管理员与发布保护 PAT，不能将旧格式作为新版本回退路径。
5. 机器审计只能发现模式性问题，不能替代复杂状态机、取消、并发和数据保护边界的人工审查。

## 当前实现与证据

- Android 无业务字段的 JSON POST/PUT/PATCH 统一发送 `{}`，API 测试覆盖此约束。
- Web IndexedDB 清理遍历所有记录，并在异步开始前固定账户命名空间。Client logout 取消未完成请求、断开 Socket、清除 PAT 和会话游标；新登录等待旧 Cookie 清理结束。
- Android 账号切换传播协程取消，存储锁串行化令牌/缓存写入与清理，防止迟到写入恢复旧账户数据。此操作不调用渠道停止、退出或清 Cookie 接口。
- Android Shell 使用 Material 3 和明确的 Insets 所有权；设备测试验证系统栏边界和账号本地清理。
- 普通用户 Trace 查询在分页前限定为 Run 子树，防止外部复用 traceId 带出其他账号 Span；回归测试覆盖跨 Run 复用、Worker 子 Span 与分页边界。
- Core 将资源采样及其定时器生命周期收口到 ResourceMonitor；MCP、图片 SDK、Tavily 和网页抓取传输按需加载。
- 原生 service、Compose 和 Worker 镜像统一配置 telemetry 依赖、目录与权限。镜像仍需 Docker 环境实际构建验收。
- 测试数量、覆盖率、性能实测与未完成验收统一见 [发布验收](release-acceptance.md)。本文件不记录过去生产 release、签名路径、线上版本或操作过程。

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
