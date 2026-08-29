# 性能与 Trace 验证报告

日期：2026-08-29。所有真实 API 测试使用临时 state、workspace、数据库、用户和令牌；报告不包含密钥、Prompt、完整响应或原始工具参数。

## 变更

- TelemetryStore 复用 Span、事件、Run link 和资源写入的 prepared statement。
- 无事件 Span 完成时不再开启独立事务；带事件 Span 保持单事务写入。
- Span 更新增加 `status='active'` 条件，`finish()` 对重复调用幂等。
- 诊断摘要增加 active Span、错误率、按服务统计、按 Span kind 的 p50/p95/p99、Trace 写入失败和 OTLP 导出失败计数。
- Trace 查询增加 status/service 复合索引。
- 真实测试脚本修正模型 API 类型和默认思考级别配置。

## Faux 验收

- `npm run check`：通过。
- `npm test`：48 个测试文件、258 项测试通过。
- `npm run test:coverage`：通过，Core 分支覆盖率 73.16%。
- `npm run build`：通过；Web 保留既有约 500KB bundle 警告，未在缺乏 profiler 证据时拆分功能。
- `npm run test:perf`：20 requests；API p95 42.54ms，事件 p95 12.19ms，峰值 RSS 174.1MiB，WAL 4.13MiB。
- `npm run test:soak:faux`：短时 38 messages；RSS 增长约 1.4%，WAL 1.96MiB。

## 真实 Provider 验收

目标为 `openai`、`gpt-5.6-sol`、`https://www.fastaitoken.com`，密钥仅由 `OPENAI_API_KEY` 注入。

- smoke：通过，Run completed，7 spans，RSS 约 115.8MiB。
- eval：3/3 通过。
- perf：2/2 Run completed，RSS 峰值约 119.4MiB，WAL 3.93MiB。
- soak：受控短时 1 Run completed，RSS 峰值约 117.1MiB，WAL 2.79MiB。

## Web E2E

Chromium 4 个用例全部通过。为遵守测试服务器同一 IP 的每日注册限流，第 4 个用例复用首个测试账户；生产注册限流策略未放宽或修改。

## 结论

Trace 具备 HTTP、Run、队列、模型、工具、审批、MCP 和 Browser Worker 链路，跨服务使用 W3C `traceparent`；终态 Run 的 active Span 在运行测试中为 0。当前性能指标满足既定预算，未发现需要删除用户可见功能的性能问题。

## 复核记录

本次修改后的复核结果：`npm run check`、`npm test`（48 文件/258 项）、`npm run build`、Faux Eval（6/6）、短时 Faux soak（41 条消息）、Web Playwright（4/4）和 Android 离线 `test lint assembleDebug` 均通过。最新 Faux 性能为 API p95 22.64ms、事件 p95 8.26ms、RSS 峰值 167,219,200 bytes、WAL 峰值 4,161,232 bytes。当前执行环境未注入 `OPENAI_API_KEY`，真实 API 测试按安全策略跳过，未将 Faux 结果冒充真实结果。

二次复核再次通过 `npm run check`、`npm test`（48 文件/258 项）和 `npm run test:perf`；本次性能为 API p95 26.04ms、事件 p95 24.59ms、RSS 峰值 173,944,832 bytes、WAL 峰值 4,132,392 bytes，仍满足既定预算。
