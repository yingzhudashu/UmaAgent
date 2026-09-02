# UmaAgent 工程基线

当前版本为 UmaAgent 1.3.0、Protocol v15 和 SQLite schema 22。schema 22 是唯一支持格式；更旧或更高版本直接拒绝启动，不执行隐式迁移。

## 已落地的边界

- `UmaRuntime` 仍是 Core 唯一公共门面，资源读写通过 `RuntimeResourceService` 收口。
- `UmaDatabase` 保留连接、schema 校验和事务入口；Session CRUD 与消息/附件只读投影分别由 `SessionRepository`、`MessageRepository` 承担。
- Snapshot、History 和消息列表使用批量消息/附件查询；事件分页直接读取 Session cursor，不重新构建 Snapshot。
- WebSocket 发送缓冲超过 4 MiB 时关闭连接并要求客户端按 Snapshot/cursor 恢复，避免无界内存增长。
- 架构检查阻止旧 API 残留、跨包深层导入、非入口裸 `console.*`，并阻止已记录的大文件继续增长。

## 性能预算

固定基线位于 `scripts/perf-baseline.json`，覆盖 100 个 Session、10 万条消息、100 万条事件、1 万知识片段和最多 5 个客户端的目标规模。短测可通过 `UMA_PERF_MESSAGES` 调整样本量；设置 `UMA_PERF_REQUIRE=1` 时预算超标会使进程失败。

- 非模型 API p95 < 150 ms
- 事件分页/交付 p95 < 500 ms
- 空闲 Core RSS < 256 MiB
- WAL < 256 MiB
- soak 期间 RSS 增长 < 10%
- 分支覆盖率采用只升不降的实测 ratchet；目标为各一方包至少 80%，不得通过排除生产文件或降低既有基线通过 CI。
- Trace Span 必须有完整父子关系，Run 终态不得遗留未结束 Span
- Trace 错误信息必须经过值级脱敏；诊断摘要不得按 kind 执行 N+1 查询

## 验证入口

```text
npm run check
npm test
npm run test:coverage
npm run test:eval:faux
npm run test:perf
npm run test:soak:faux
npm run test:web:e2e
```

2026-09-02 复核：51 个测试文件/273 项测试、构建、性能基线和短时 soak 通过；服务器隔离端口两次真实 API smoke 均通过。详细指标和 Trace 边界见 [架构与质量基线](architecture-quality.md)。

Docker 和 4 小时 soak 由 CI/nightly 执行；本机没有 Docker 时只运行 Node/SQLite 级门禁。MiniAgent 差异审计见 `docs/miniagent-feature-matrix.md`，真实外部网关仅在显式授权时运行。
