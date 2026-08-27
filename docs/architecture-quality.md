# UmaAgent 架构与质量基线

当前发布版本为 `1.3.0`，Protocol v14，HTTP API `/api/v14`，SQLite schema 20。schema 20 是唯一支持格式；更旧数据库和旧 API 不兼容并直接拒绝启动。

## 事实源与分层

- Core Server 是业务运行、权限、模型、工具和 `state.db` 的唯一事实源；跨服务 Trace 统一写入独立 telemetry 存储。
- `@uma-agent/client` 是 CLI、Web、Feishu 和 Xianyu 的唯一 HTTP/WebSocket 客户端边界。
- Protocol 使用严格 TypeBox schema；服务端拒绝未知字段。
- SQLite 使用 WAL；schema 不匹配直接拒绝启动。
- Trace 只保存脱敏属性和耗时，不保存 prompt、完整模型响应、隐藏思维链、凭据或原始工具参数。
- Windows 真实运行数据位于 `%LOCALAPPDATA%/UmaAgent`：`state` 保存 Core 状态，`workspaces` 保存用户工作区，`channels` 保存 Adapter 状态；仓库根目录不承载运行数据。
- Feishu/Xianyu Adapter 与 Feishu MCP 使用 `config.user.json` 管理应用和渠道参数；Feishu MCP Bearer Token 与 Core MCP 配置统一从 `FEISHU_MCP_TOKEN` 环境变量读取。旧应用凭据环境变量入口已删除。

## 关键不变量

- 每个 Run、模型、工具、审批和终态 Span 都属于同一 Trace，并有明确父节点。
- Trace Span 使用单调时钟计算持续时间，完成时写入独立 `telemetry.db`；诊断写入失败不得改变业务请求。
- 队列、抢占、取消、审批和恢复只能经过合法状态转换；未决副作用不会被自动重放。
- WebSocket 以快照和永久事件游标恢复；发送缓冲超过上限时主动断开，避免无界内存。
- 所有 Session、Run、Attachment、Memory、Task 和 Trace 查询按用户所有权隔离。
- 优化写入必须先备份，再原子替换，使用固定验证命令；验证失败自动恢复。
- Skill 只在 Core 中解释静态说明；MiniAgent 风格 frontmatter 的环境、系统命令、操作系统、模型可见性和 Session 作用域在加载时门控，可执行代码只能进入批准的 Skill Worker。

## 质量审查记录

| 区域 | 审查结论 | 证据/门禁 |
| --- | --- | --- |
| Core Runtime/Database | 状态、事务、资源释放和恢复路径已审查；大文件只按职责边界继续拆分 | `npm run check`、Core tests |
| Server/Client | API v14、统一错误映射、权限和分页已审查 | Server/Client tests |
| Web | React Query、事件重连、离线只读缓存和移动布局已审查 | Playwright E2E |
| Trace/Diagnostics | 父子关系、脱敏、分页、资源快照和 p50/p95/p99 已审查 | Trace/diagnostics tests |
| Feishu/Xianyu | 重连、去重、回调、控制面认证和外部失败边界已审查 | Adapter tests；真实门禁需显式授权 |
| 文档/配置 | README、部署、基线、功能矩阵和示例配置按当前代码核对 | 本文档与 `docs/README.md` |

当前尺寸基线记录在 `scripts/architecture-baseline.json`。本次升级新增了严格 Protocol 类型、优化应用持久化、趋势查询和 Web 管理区域；`runtime.ts`、`database.ts`、Server、CLI、Web 和 Protocol 的进一步拆分必须由 Trace/profiler 证据驱动，禁止为了降低行数进行行为不变但风险不明的拆分。

## 已复现基线

以下结果来自本次工作区的完整门禁，数值用于后续回归比较，不代表跨机器预算：

| 场景 | 结果 | 关键指标 |
| --- | --- | --- |
| Faux 性能基线 | 通过 | 20 个请求、240 个 durable 事件；API p50/p95/p99 = 7.47/9.33/10.66 ms；事件 p50/p95/p99 = 3.34/4.49/5.37 ms；RSS 峰值 176,771,072 B；WAL 峰值 4,128,272 B |
| Faux soak | 通过 | 36.3 秒、42 条消息、504 个 durable 事件；RSS 140,054,528 -> 142,737,408 B；WAL 峰值 1,882,872 B |
| 分支覆盖率 | 门禁通过，仍需提升 | 总体 73.11%；Core 73.32%、Client 74.88%、Channel Adapter 49.29%、Server 67.63%、Feishu Adapter 75.08%；以实测向下取整值作为只升不降 ratchet，80% 为目标 |
| 真实 smoke/eval/perf/soak | 未在当前环境执行 | 必须显式提供隔离环境的 `UMA_REAL_*` 配置；缺少配置时安全跳过，不将 faux 结果冒充真实通过 |

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
