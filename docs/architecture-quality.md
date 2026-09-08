# UmaAgent 架构与质量基线

当前发布版本为 `1.3.0`，Protocol v15，HTTP API `/api/v15`，SQLite schema 24。schema 24 是当前格式；旧数据库直接拒绝启动，发布前清理旧 state.db，不执行迁移。

## 事实源与分层

- Core Server 是业务运行、权限、模型、工具和 `state.db` 的唯一事实源；跨服务 Trace 与资源样本统一写入 `UMA_TELEMETRY_DIR/telemetry.db`。Server、Browser Worker、SMath Worker 和 Xianyu Adapter 必须显式使用同一个目录。
- Protocol 使用严格 TypeBox schema；服务端拒绝未知字段。
- SQLite 使用 WAL；schema 不匹配直接拒绝启动。
- Trace 只保存脱敏属性和耗时，不保存 prompt、完整模型响应、隐藏思维链、凭据或原始工具参数；state.db 不包含 Trace/资源历史表。
- Windows 真实运行数据位于 `%LOCALAPPDATA%/UmaAgent`：`state` 保存 Core 状态，`workspaces` 保存用户工作区，`channels` 保存 Adapter 状态；仓库根目录不承载运行数据。

## 关键不变量

- 每个 Run、模型、工具、审批和终态 Span 都属于同一 Trace，并有明确父节点。
- Trace Span 使用单调时钟计算持续时间，完成时写入独立 `telemetry.db`；诊断写入失败不得改变业务请求。
- 队列、抢占、取消、审批和恢复只能经过合法状态转换；未决副作用不会被自动重放。
- WebSocket 以快照和永久事件游标恢复；发送缓冲超过上限时主动断开，避免无界内存。
- 所有 Session、Run、Attachment、Memory、Task 和 Trace 查询按用户所有权隔离。普通用户的 Trace 查询在 SQLite 分页前约束为所属 Run 子树，不能因为 traceId 相同而读取别人的 Run；管理员可查询完整跨服务链路。
- 优化写入必须先备份，再原子替换，使用固定验证命令；验证失败自动恢复。
- Skill 只在 Core 中解释静态说明；MiniAgent 风格 frontmatter 的环境、系统命令、操作系统、模型可见性和 Session 作用域在加载时门控，包含可执行代码的包会被拒绝。

## 质量审查记录

| 区域 | 审查结论 | 证据/门禁 |
| --- | --- | --- |
| Core Runtime/Database | 状态、事务、资源释放和恢复路径已审查；大文件只按职责边界继续拆分 | `npm run check`、Core tests |
| Server/Client | API v15、统一错误映射、权限和分页已审查 | Server/Client tests |
| Web | React Query、事件重连、离线只读缓存和移动布局已审查 | Playwright E2E |
| Trace/Diagnostics | 父子关系、值级错误脱敏、分页、资源快照和单次窗口分位数查询已审查 | `packages/telemetry/test`、`apps/server/test/error-mapping.test.ts` |
| 文档/配置 | README、部署、基线、功能矩阵和示例配置按当前代码核对 | 本文档与 `docs/README.md` |

当前尺寸基线记录在 `scripts/architecture-baseline.json`。本次升级新增了严格 Protocol 类型、优化应用持久化、趋势查询和 Web 管理区域；`runtime.ts`、`database.ts`、Server、CLI、Web 和 Protocol 的进一步拆分必须由 Trace/profiler 证据驱动，禁止为了降低行数进行行为不变但风险不明的拆分。

2026-09-08 逐文件复核重点覆盖 `packages/telemetry/src/index.ts`、`packages/core/src/trace.ts`、`packages/core/src/runtime.ts`、`packages/core/src/mcp.ts`、`apps/server/src/httpTelemetry.ts`、`apps/server/src/runtimeLogging.ts`、`apps/server/src/error-mapping.ts`、`apps/browser-worker/src/main.ts`、`apps/smath-worker/src/main.ts` 和 `apps/xianyu-adapter/src/main.ts`。确认 HTTP、WebSocket、Run、queue、preflight、model、tool、approval、MCP、Browser Worker、SMath Worker 和 Xianyu Adapter 的 traceparent 传播路径；并发、取消、失败和重启路径均有终态处理。SMath Worker 与 Xianyu Adapter 的 telemetry 目录现在必须由 `UMA_TELEMETRY_DIR` 显式提供，缺失时直接拒绝启动。大文件尺寸债务保留，未做无证据拆分。

## 复核基线

当前本地门禁、性能实测与未完成项统一见 [发布验收](release-acceptance.md)。Core 保留原有模型、工具和 Trace 效果，通过按需加载 SDK、批量查询和减少 WAL 提交开销优化。资源报告同时统计业务库与遥测库 WAL。

真实 Provider、跨服务实网 OTLP 和持续 soak 的结果必须单独记录，不能用 Faux 代替。不得将密钥、完整 Prompt 或模型正文写入诊断报告。

## 验收命令

```text
npm test
npm run check
npm run build
npm run test:eval:faux
npm run test:perf
npm run test:soak:faux
npm run test:web:e2e
```

真实 Provider 测试必须显式设置 `UMA_REAL_API=1` 和完整 `UMA_REAL_*` 环境变量；密钥只由受控环境注入，不读取 MiniAgent 配置，也不得进入文件、数据库、Trace、日志或报告。
