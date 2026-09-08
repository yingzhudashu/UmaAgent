# UmaAgent 工程基线

当前版本为 UmaAgent 1.3.0、Protocol v15 和 SQLite schema 24。schema 24 是当前格式；旧版本数据库直接拒绝启动，发布前清理旧 state.db，不执行迁移。

## 已落地的边界

- `UmaRuntime` 仍是 Core 唯一公共门面，资源读写通过 `RuntimeResourceService` 收口。
- `UmaDatabase` 保留连接、schema 校验和事务入口；Session CRUD 与消息/附件只读投影分别由 `SessionRepository`、`MessageRepository` 承担。
- Snapshot、History 和消息列表使用批量消息/附件查询；事件分页直接读取 Session cursor，不重新构建 Snapshot。
- WebSocket 发送缓冲超过 4 MiB 时关闭连接并要求客户端按 Snapshot/cursor 恢复，避免无界内存增长。
- 架构检查阻止旧 API 残留、跨包深层导入、非入口裸 `console.*`，并阻止已记录的大文件继续增长。

## 性能预算

固定 Faux 基线位于 `scripts/perf-baseline.json`，默认运行 1 个 Session、20 条请求和连续事件分页，并逐 Run 检查 Trace。它不代表 100 个 Session 或百万事件的容量验证。`UMA_PERF_MESSAGES` 可用于另行压测；固定对比保持 20 条请求、同一 Node 版本和机器负载。

`npm run test:perf` 超标始终返回非零退出码，无需额外开关。性能预算为：

- 消息受理 API p95 ≤ 12.8 ms
- 事件分页 p95 ≤ 5.9 ms
- 测量期间 Core 峰值 RSS ≤ 180 MiB（包含冷启动后的首次请求；长时 Faux soak 另检查相对预热基线增长不得超过 60%）。该值为旧约 150MiB 生产基线再保留 20% 的长时运行余量，不代表理想目标。
- state.db 与 telemetry.db 的 WAL 合计 ≤ 3.2 MiB
- CPU 按可用逻辑核归一化；基准以单核等效百分比（归一化百分比 × 可用逻辑核数）比较，平均值 ≤ 5.5653%，采样峰值 ≤ 5.568%，恢复到参考基线。平均值按采样时长加权；峰值是采样区间 CPU 平均值的最大值，不代表瞬时峰值。
- 事件循环指标 ≤ 31.74 ms，为参考值 26.45 ms 额外保留 20% 的 Windows 调度波动；`monitorEventLoopDelay` 采样粒度固定 20 ms，包含系统定时器调度延迟，不等同于单次阻塞的 p95。只统计时长至少 1 秒的样本，报告同时保留启动样本。
- CPU 和事件循环参考环境为 Windows、Node 24.15.0、16 逻辑核，见基线文件 `resourceReference`；部署 Linux 的结果需要独立复测，当前达标情况见发布验收。
- soak 期间记录 RSS 峰值和相对预热基线增长；当前 Faux 长时内存稳定性结果见发布验收，未通过的项目不得标记为已验收。
- 分支覆盖率采用只升不降的实测 ratchet；目标为各一方包至少 80%，不得通过排除生产文件或降低既有基线通过 CI。
- Trace Span 必须有完整父子关系，Run 终态不得遗留未结束 Span；Trace 与资源样本只写入 telemetry.db
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

本地验收结果集中记录在 [发布验收](release-acceptance.md)，避免多份文档维护不一致的测试数量和性能数字。Faux 结果只证明隔离模型下的行为，真实 Provider smoke/perf/soak 单独验收。

Docker 和 4 小时 soak 由 CI/nightly 执行；本机没有 Docker 时只运行 Node/SQLite 级门禁。MiniAgent 差异审计见 `docs/miniagent-feature-matrix.md`，真实外部网关仅在显式授权时运行。
