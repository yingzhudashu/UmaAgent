# UmaAgent 架构与质量基线

当前发布版本为 `1.3.0`，Protocol v14，HTTP API `/api/v14`，SQLite schema 20。schema 19 通过唯一的相邻事务迁移升级；更旧数据库和旧 API 不兼容。

## 事实源与分层

- Core Server 是运行、权限、模型、工具、SQLite 和 Trace 的唯一事实源。
- `@uma-agent/client` 是 CLI、Web、Feishu 和 Xianyu 的唯一 HTTP/WebSocket 客户端边界。
- Protocol 使用严格 TypeBox schema；服务端拒绝未知字段。
- SQLite 使用 WAL；schema 不匹配直接拒绝启动。
- Trace 只保存脱敏属性和耗时，不保存 prompt、完整模型响应、隐藏思维链、凭据或原始工具参数。
- Windows 真实运行数据位于 `%LOCALAPPDATA%/UmaAgent`：`state` 保存 Core 状态，`workspaces` 保存用户工作区，`channels` 保存 Adapter 状态；仓库根目录不承载运行数据。
- Feishu/Xianyu Adapter 与 Feishu MCP 使用 `config.user.json` 管理应用和渠道参数；Feishu MCP Bearer Token 与 Core MCP 配置统一从 `FEISHU_MCP_TOKEN` 环境变量读取。旧应用凭据环境变量入口已删除。

## 关键不变量

- 每个 Run、模型、工具、审批和终态 Span 都属于同一 Trace，并有明确父节点。
- Trace Span 使用单调时钟计算持续时间，完成时同步写入 SQLite；写入失败直接暴露。
- 队列、抢占、取消、审批和恢复只能经过合法状态转换；未决副作用不会被自动重放。
- WebSocket 以快照和永久事件游标恢复；发送缓冲超过上限时主动断开，避免无界内存。
- 所有 Session、Run、Attachment、Memory、Task 和 Trace 查询按用户所有权隔离。
- 优化写入必须先备份，再原子替换，使用固定验证命令；验证失败自动恢复。
- Skill 只在 Core 中解释静态说明；MiniAgent 风格 frontmatter 的环境、系统命令、操作系统、模型可见性和 Session 作用域在加载时门控，可执行代码只能进入批准的 Skill Worker。

## 质量审查记录

| 区域 | 审查结论 | 证据/门禁 |
| --- | --- | --- |
| Core Runtime/Database | 状态、事务、资源释放和恢复路径已审查；大文件只按职责边界继续拆分 | `npm run check`、Core tests |
| Server/Client | API v12、统一错误映射、权限和分页已审查 | Server/Client tests |
| Web | React Query、事件重连、离线只读缓存和移动布局已审查 | Playwright E2E |
| Trace/Diagnostics | 父子关系、脱敏、分页、资源快照和 p50/p95/p99 已审查 | Trace/diagnostics tests |
| Feishu/Xianyu | 重连、去重、回调、控制面认证和外部失败边界已审查 | Adapter tests；真实门禁需显式授权 |
| 文档/配置 | README、部署、基线、功能矩阵和示例配置按当前代码核对 | 本文档与 `docs/README.md` |

当前尺寸基线记录在 `scripts/architecture-baseline.json`。本次升级新增了严格 Protocol 类型、优化应用持久化、趋势查询和 Web 管理区域；`runtime.ts`、`database.ts`、Server、CLI、Web 和 Protocol 的进一步拆分必须由 Trace/profiler 证据驱动，禁止为了降低行数进行行为不变但风险不明的拆分。

## 已复现基线

以下结果来自本次工作区的完整门禁，数值用于后续回归比较，不代表跨机器预算：

| 场景 | 结果 | 关键指标 |
| --- | --- | --- |
| Faux 性能基线 | 通过 | API p50/p95/p99 = 4.46/5.69/6.75 ms；事件 p50/p95/p99 = 2.36/3.01/3.34 ms；RSS 峰值 161,742,848 B；WAL 峰值 1,178,352 B |
| Faux soak | 通过 | 1 条消息；RSS 140,283,904 B；活动/排队 Run 均为 0 |
| 真实 smoke | 通过 | Run completed；Trace 3 spans；RSS 135,626,752 B；CPU user/system 47,000/16,000 us |
| 真实 Eval | 通过 | 3/3 cases；Trace latency p50/p95/p99 = 7,183/49,709/49,709 ms；RSS 120,188,928 B；event-loop 23.18 ms |
| 真实 perf | 通过 | 3/3 runs；请求 p50/p95/p99 = 9.61/15.99/15.99 ms；RSS 峰值 120,803,328 B；WAL 峰值 3,551,472 B |
| 真实短 soak | 通过 | 1 条消息；请求 p50/p95/p99 = 20.19/20.19/20.19 ms；RSS 峰值 119,922,688 B；WAL 峰值 910,552 B |

真实结果中的 Trace ID、token 和配置凭据只在当前进程输出，未写入仓库文件、数据库或报告。

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

真实 Provider 测试必须显式设置 `UMA_REAL_API=1`，并从受控环境或 `D:\AIhub\miniagent-python\config.user.json` 临时读取密钥；密钥不得进入文件、数据库、Trace、日志或报告。
