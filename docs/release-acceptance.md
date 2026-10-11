# UmaAgent 当前候选验收

验收对象：Core 1.3.0、Android 1.4.2（versionCode 16）、Protocol v16、HTTP `/api/v16`、业务 SQLite schema 27。本文只记录当前候选的可复核结果；历史日志、截图和隔离数据库仍保存在 `artifacts/acceptance/`，不替代当前结果。

## 当前结论

**通过（当前支持范围）。** Windows Native Core、Web/PWA、Android 模拟器六配置、真实 Provider 主链路、真实 Embedding 隔离 smoke、数据隔离、Trace 和性能门禁均已通过。架构门禁已通过，六个登记的大文件作为受控维护债务持续监测。Docker、Linux、实体真机、真实渠道、大规模知识库索引吞吐和无障碍专项属于目标环境适配证据，列为非阻塞缺口；启用对应部署或发布面前必须补做。

当前候选真实 Provider smoke、3 项评测、20 请求性能和短 soak 已通过，使用隔离配置、脚本创建的临时 state、workspace、账号和令牌。20 请求性能 p50/p95/p99 为 6.31/18.50/18.81ms，RSS 峰值 121,352,192B，WAL 峰值 2,270,184B；短 soak 6 次请求全部完成，耗时 263.21s，RSS 峰值 117,612,544B，WAL 峰值 2,245,464B。真实 Embedding 隔离 smoke 已通过：`node --env-file=.env scripts/real-embedding-smoke.mjs`（`UMA_REAL_API=1`，两条输入、1024 维、315ms）。未启动闲鱼 Adapter，也未发送闲鱼消息。

## 服务器部署结果

2026-10-11 已使用提交 `3144b718f6d4` 完成生产 Native promote。release `20261011074257-3144b718f6d4` 通过依赖链接、Protocol v16/schema 27、包导入和保护用户指纹校验；脚本先创建在线备份，再原子切换 `/opt/uma-agent/current`。部署后 Core、Browser Worker 和 Xianyu Adapter 均为 active，`/api/v16/health/live` 与 `/api/v16/health/ready` 均返回 200，版本 1.3.0、Protocol 16。备份文件保留在服务器受保护目录，未进入仓库。

2026-10-11 已将生产配置的 `default`、`reasoning`、`fast` 和 `vision` 角色统一切换为 `openai/gpt-6.1-sol`，并重启 Core 后通过 `/api/v16/health/ready`。停服前已创建在线数据库备份 `state-default-model-20261011111225.db`；随后在事务中将现有 6 个 session 更新为 `openai/gpt-6.1-sol`。更新后 schema 为 27，`integrity_check=ok`、外键检查为空，session 不匹配数为 0；users、sessions、messages、runs、attachments 行数保持为 6/6/1209/110/55，110 条历史 Run 的 `model_snapshot_json` 哈希保持不变。该变更只影响现有 session 的后续消息和新 Run，不改写历史运行快照、消息、附件或账号数据。

同日针对网关不接受 GPT-6.1 Sol 的 reasoning effort `none`/`minimal` 发布 hotfix release `20261011120205-d6c3aae`。运行时将这两个等级声明为不支持，关闭思考时省略 reasoning 字段，`minimal` 由 Pi 收敛到最低可用 `low`，其余支持等级按用户选择发送。Native promote 创建备份 `state-20261011120919.db`，受保护用户指纹校验与 ready 检查通过；Core、Browser Worker、Xianyu Adapter 均 active。部署后只做了 readiness 和数据完整性核验，未额外发送真实模型 smoke 请求。最终数据库仍为 schema 27、`integrity_check=ok`、外键检查为空，7 个 session 全部指向 `openai/gpt-6.1-sol`。

同一构建曾在 staging 尝试启动；因 staging 历史数据库仍是旧 schema，新版本按契约拒绝启动，脚本自动恢复原 staging release。该回滚未影响生产，也未执行任何运行时迁移；staging 后续应先恢复匹配当前 schema 27 的隔离备份再复测。

2026-10-11 修复了回复下方“审查/改进”操作：普通助手消息此前没有持久化指向对应用户消息的父链，质量 Run 因而找不到待审查问题并失败；新回复和澄清回复现在记录父消息，既有缺少父链的历史记录从活动分支最近的前序用户消息解析，无需数据迁移。Web 点击后立即显示提交/排队/执行状态，按 Run 终态显示错误；改进正文从质量历史读取，避免因结果消息不属于活动分支而空白。提交 `33415c4` 部署为 Native release `20261011135637-33415c4`，创建在线备份 `state-20261011140416.db`；Native promote、依赖和包导入检查、受保护用户指纹校验均通过，Core、Browser Worker、Xianyu Adapter 均 active，live/ready 均返回 200，schema 仍为 27。验收命令 `npm run check`、`npm run test:coverage`、`npm run build`、`npm run test:web:e2e` 均通过；Vitest 62 个文件/356 项，覆盖率语句 81.91%、分支 73.27%、函数 77.03%、行 84.67%，Web E2E 37/37。

## 当前契约

- 版本事实源为根目录 `RELEASE`、根 `package.json` 和 Android `app/build.gradle.kts`。
- 业务数据库只接受 `PRAGMA user_version=27`；版本不匹配直接拒绝启动，不提供运行时兼容层或迁移工具。历史用户数据、草稿、附件、账号、渠道 Cookie 和正式备份必须保留在匹配版本的隔离恢复环境。
- Trace 使用 W3C `traceparent` 贯穿 HTTP、队列、Run、模型、工具、MCP、Worker 和渠道。外部 `traceparent` 只作关联，不是授权凭据。
- Trace 查询先完成账号和 Run 子树过滤，再分页；服务端返回 `depth`、`rootSpanId`、稳定 `nextOffset`。属性、事件和错误文本脱敏，不保存 prompt、模型正文、完整 URL、Cookie、Token 或原始工具参数。

## 已通过门禁

| 门禁 | 结果 | 证据或命令 |
| --- | --- | --- |
| 架构检查 | 通过（受控债务） | `npm run check:architecture` 通过；六个登记文件超过 900 行但均受尺寸基线约束，新增或超基线文件会失败 |
| 文档契约检查 | 通过 | `npm run check:docs-contracts`；14 个 Markdown 文件、版本/schema/命令/本地链接一致 |
| Biome 与 TypeScript | 通过 | `npm run check` |
| 单元测试与覆盖率 | 通过 | `npm run test:coverage`；62 个文件、356 项，语句 81.91%、分支 73.27%、函数 77.03%、行 84.67% |
| 完整构建 | 通过 | `npm run build` |
| 嵌入 Web 构建 | 通过 | `npm run build:web:embed`；CSS 114.33 KiB，入口 JS 540.84 KiB |
| Faux 评测 | 通过 | `npm run test:eval:faux`；6/6 |
| Faux 四小时 soak | 通过 | `artifacts/acceptance/soak-1791685462712/result.json`；约 4 小时、2615 条消息、游标 31416、RSS 峰值 158,969,856B、双库 WAL 峰值 2,661,584B |
| Web 全量 E2E | 通过 | `npm run test:web:e2e`；37/37，包含审查/改进进度与结果回归 |
| Android JVM/instrumentation 编译 | 通过 | `npm run check:android`；Gradle Debug 单测与 instrumentation Kotlin 编译 |
| 前端设计产物 | 通过 | `python docs/frontend-design/render.py`、`python docs/frontend-design/validate.py`；32 页面、85 动作、154 图、0 问题 |

## Windows 固定性能

环境为 Windows、Node v24.15.0、16 个逻辑核、正常 GC、完整 Trace、SQLite WAL/FULL synchronous、单 Session、20 请求。三轮均使用原预算，没有降低负载或关闭 Trace。

| 轮次 | API p95 | 事件分页 p95 | RSS 峰值 | 双库 WAL 峰值 | CPU 单核等效平均/峰值 | 事件循环 p95 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 6.34 ms | 1.64 ms | 112,402,432 B | 2,216,624 B | 4.1063% / 4.1063% | 30.3331 ms |
| 2 | 5.77 ms | 1.60 ms | 112,631,808 B | 2,228,984 B | 3.6255% / 3.6255% | 30.1375 ms |
| 3 | 5.54 ms | 2.05 ms | 112,119,808 B | 2,212,504 B | 4.2561% / 4.2561% | 29.9643 ms |
| 门槛 | ≤ 12.8 ms | ≤ 5.9 ms | ≤ 188,743,680 B | ≤ 3,355,443 B | ≤ 5.5653% / 5.568% | ≤ 31.74 ms |

三轮固定性能均满足门槛。启动样本中的短时 CPU 采样不计入稳态结果；脚本只使用采样持续时间不少于 1 秒的资源样本。

## Trace 与问题闭环

当前实现已覆盖 HTTP 父链、排队等待、Run、模型、工具、审批、重试、取消、Worker、重启终态和遥测写入失败诊断。持久化查询使用递归祖先计算真实深度，分页不会因祖先跨页而改变缩进；未终结 Span 在服务重启时标记为 `IncompleteSpan`。TelemetryStore 使用有界批量 Worker、独立 telemetry.db、WAL 自动 checkpoint 和失败计数。相关回归包括脱敏、跨服务父链、分页树、循环/孤儿链、重启终态、权限隔离和写入故障。

## Android 六配置矩阵

证据目录为 `artifacts/acceptance/android-matrix-20261011-124744/`；API 36 模拟器、host GPU、Android 1.4.2 debug 包。六组功能与布局检查全部通过、截图无效项为 0，正文显示 p95 均低于 100ms，未出现超过 700ms 的冻结帧。

| 配置 | 正文显示 p95 | 最大帧 | 结果 |
| --- | ---: | ---: | --- |
| phone | 84.47 ms | 35.86 ms | 通过 |
| phone200 | 86.12 ms | 35.62 ms | 通过 |
| narrow | 85.38 ms | 36.25 ms | 通过 |
| tablet600 | 86.30 ms | 35.04 ms | 通过 |
| dual840 | 94.29 ms | 35.56 ms | 通过 |
| landscape200 | 82.80 ms | 35.58 ms | 通过 |

六组最大帧均低于 700 ms。当前只连接模拟器，未连接实体 Android 设备；实体真机专项不影响当前模拟器支持范围，但在发布签名 APK 到实体设备前必须补做。未放宽 100 ms 门槛。

## 非阻塞验证缺口

| 项目 | 当前状态 | 何时必须补验 |
| --- | --- | --- |
| Docker Compose | 本机无 Docker CLI，Native 已通过 | 选择容器部署时 |
| Linux Native/性能 | 当前 Windows 支持范围之外 | 部署到 Linux 时 |
| Android 实体真机 | 当前仅有 API 36 模拟器 | 发布签名 APK 到实体设备前 |
| 大规模 Embedding 索引 | 小批量真实供应商 smoke 已通过 | 启用大规模知识库前 |
| 外接键盘/读屏 | 未完成专项矩阵 | 宣布无障碍目标支持前 |
| 真实闲鱼渠道 | 未连接真实账号，禁止真实消息 | 真实渠道上线前使用隔离账号 |

1. 实体 Android 真机尚未连接；模拟器矩阵已覆盖当前 UI 和正文性能。签名 APK 交付实体设备前执行更新、登录、进程重启、历史读取和消息发送。
2. Docker CLI 当前不可用；Native 部署链路已通过，Compose 仅在选择容器部署时执行展开、镜像构建和健康检查。
3. 真实 Embedding 两条输入隔离 smoke 已通过；大规模知识库索引吞吐和长时供应商限流样本未执行。启用大规模知识库前执行独立容量测试。
4. Linux 完整性能矩阵、外接键盘/读屏专项尚未执行；它们是 Linux 或无障碍目标发布前的适配检查。真实闲鱼消息仍禁止发送，渠道仅可用隔离账号和模拟数据验收。
5. `database.ts`、`runtime.ts`、`App.tsx`、Server `app.ts`、Client `index.ts` 和 CLI `main.ts` 仍超过 900 行，作为已登记的受控维护债务保留；尺寸基线防止继续增长，后续拆分不作为本候选发布硬阻塞。

## 唯一验收入口

```text
npm run check
npm run test:coverage
npm run build
npm run build:web:embed
npm run check:android
npm run test:eval:faux
npm run test:web:e2e
npm run test:perf
npm run test:soak:faux
```

真实 Provider 仅在显式设置 `UMA_REAL_API=1`、独立配置、state、workspace、账号和令牌后运行：

```text
npm run test:real:smoke
npm run test:real:eval
npm run test:real:perf
npm run test:real:soak
npm run test:real:embedding
```

设备矩阵入口为 `python scripts/android-device-matrix.py`。容器目标另执行 `docker compose -f docker-compose.yml -f deploy/docker-compose.production.yml config --quiet`。设计规格见[前端设计](frontend-design.zh-CN.md)，后端、部署、工程基线和代码审查中的版本与接口由 `npm run check:docs-contracts` 持续校验。
