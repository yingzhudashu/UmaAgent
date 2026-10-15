# UmaAgent 当前候选验收

## 2026-10-15 本轮最终验收

本轮修改修复 WebSocket 升级后 HTTP Span 未结束、连接关闭终态缺失，以及外部 W3C 父 Span 被统计为本地孤儿的问题。连接 Span 在正常 close、服务关闭、异常 close/error 和应用清理时幂等结束，订阅和认证超时器随连接清理；Preflight Provider 失败/取消会结束阶段 Span。遥测树根按本地祖先计算并识别远端根，历史 Span 不回写。资源统计改为 SQLite 汇总，维持既有 CPU 时长加权、nearest-rank p95 和窗口峰值语义。

本轮验收结果：`npm run check`、`npm run test:coverage`（59 文件、356 项；语句 82.15%、分支 74.28%、函数 76.78%、行 84.92%）、完整 workspace `npm run build`、`npm run build:web:embed`、`npm run check:android`、`npm run test:eval:faux`（6/6）、`npm run test:web:e2e`（38/38）、`npm run test:perf` 和前端设计规格 `python docs/frontend-design/validate.py` 均通过。最终代码独占性能：API P95 6.05 ms、事件分页 P95 1.33 ms、RSS 峰值 111,988,736 B、双库 WAL 峰值 2,249,584 B、CPU 核心等效平均/峰值 5.5274%/5.5274%、事件循环 P95 29.8012 ms；全部低于既有预算。与 Gradle/Eval 并行时曾出现一次 CPU 峰值超预算，停止并发后独占重跑通过，未更改负载、功能或预算。

`npm run test:soak:faux` 终版已完成四小时门禁并通过：`artifacts/acceptance/soak-1792037622280/result.json`，运行 14,400,396 ms，2,620 条消息，事件游标 31,476，基线 RSS 111,529,984 B，RSS 峰值 156,110,848 B，双库 WAL 峰值 2,542,104 B；游标连续、调度无重复，所有资源值低于既有预算。前两次未完成重跑不作为验收证据。它们留下的 ignored 样本目录、临时状态目录和 `soak-background.*.log` 仍未清除；当前执行环境拒绝递归删除，本轮没有尝试绕过。通过报告保留在仓库 ignored 的验收证据目录中。真实 Provider smoke 维持两次 `provider_error: terminated`、0 token 的既有阻塞结论，本轮未重复请求。支持范围外的 Docker/Linux、Android 实体设备、读屏和正式签名 APK 发布仍未验收。

### 前端审美与交互复核

Claude Opus 5.5 以请求 effort `max` 对 Web 前端进行了只读审美和交互复核，实际返回模型为 `claude-opus-5-5`，结论为**未发现确证的视觉缺陷或交互异常，不建议修改 UI**。复核读取设计令牌、响应式布局、Trace 面板、会话输入、消息卡片、队列、抽屉和操作菜单实现，并结合 Web E2E 38/38 与前端规格 31 页、82 项动作、149 张图、0 问题结果。结论仅覆盖代码和现有自动化证据；屏幕阅读器、实体移动设备、跨浏览器逐像素和色盲专项仍未执行，不能写成已验收。

## 前序过程记录：2026-10-15 Trace 生命周期与汇总修复

修复 WebSocket 握手 HTTP Span 在升级后仍保持 active 的问题；连接 Span 对正常关闭、服务关闭和异常 close code 分别记录终态，close/error 路径幂等结束 Span，服务关闭时先结束连接并清理订阅和认证定时器，再排空遥测 Worker。Preflight Provider 失败或取消时显式结束阶段 Span。新增的单测覆盖关闭状态映射、服务关闭实测和 Provider 失败，历史 Span 不回写、不删除。

外部 W3C `traceparent` 父 Span 是远端根，不计作本地孤儿。新入口记录 `trace.parent_remote`；查询分页树根沿本地祖先链识别远端根；旧 `server.http` 入口按既有入口语义计算，不执行历史数据更新。真实缺失的非入口本地父 Span 仍计入孤儿统计。

资源窗口汇总由 SQLite 执行，保持时长加权 CPU、nearest-rank event-loop p95、RSS/WAL/CPU 最大值定义，避免大规模采样被完整映射成 Node 对象和复制排序数组。没有放宽 WAL 或性能预算。此阶段先完成 Telemetry、HTTP telemetry、Server、Core runtime/model-calls 定向测试和 `npm run check`；随后完整覆盖率、构建、E2E、固定性能和 soak 的最终结果见上方“本轮最终验收”。

过程产物清理检查发现 ignored `artifacts` 下旧日志、截图、部署交付包和历史 acceptance 证据混存。随后已删除根目录 71 个旧过程文件、`artifacts/android-optimization/`、`artifacts/refactor/` 和 `artifacts/acceptance/runtime-unpack-final106/`；保留 `artifacts/acceptance/` 其余历史验收证据、`artifacts/delivery/`、Android production 目录、生产发布证据和 `users/`。真实 Provider 未重试，继续保留既有 `provider_error: terminated` 阻塞结论；生产服务和用户数据未写入。

## 前序候选：2026-10-15 Trace、前端与全链路复核

本轮在不改变 Protocol v16、业务 schema 27 和历史用户数据的前提下，补充 Trace 按 `service`/`kind` 的服务端过滤，并验证过滤先于分页；非法状态、名称、服务和阶段查询会直接返回 400。遥测仍使用独立 telemetry.db、有限批量 Worker、脱敏和重启 `IncompleteSpan` 终结逻辑。已从 Git 删除历史 APK、截图和过程性 `artifacts` 文件；当前架构门禁禁止重新跟踪该类产物。真实用户目录未纳入 Git，也未被本轮测试写入。

### 本轮实际验收记录

| 项目 | 实测结果 |
| --- | --- |
| 静态检查 | `npm run check` 通过；架构检查扫描 224 个源码文件，文档契约覆盖 14 个 Markdown 文件；Biome 与 TypeScript 通过 |
| 单元测试与覆盖率 | `npm run test:coverage`：59 个文件、350 项通过；语句 81.96%、分支 73.90%、函数 76.49%、行 84.73% |
| 完整构建 | 本轮 `npm run build` 通过，包含 Web 生产包和各 Worker；`npm run build:web:embed` 通过，嵌入版 CSS 118.62 KiB、入口 JS 543.32 KiB |
| Android 编译、Faux、Web E2E | 本轮 `npm run check:android` 通过；Faux 评测 6/6；完整 Web E2E 38/38，含 Trace 筛选、Enter/Space disclosure、结果播报、清除筛选和 320–2560px 窄屏布局回归 |
| 前端设计 | 本轮 `render.py` 生成 31 页、82 项交互和 149 张图；`validate.py` 31 页、82 项动作、149 张图、0 问题。校验限于结构、链接、图稿及语义检查，不表示目标设备或逐像素验收 |
| 固定性能 | 本轮单独运行 `npm run test:perf`：API P95 5.52 ms、事件分页 P95 1.94 ms、RSS 峰值 111,357,952 B、双库 WAL 峰值 2,253,704 B、CPU 核心等效平均/峰值 3.1129%/3.1129%、事件循环 P95 30.36 ms；均未越过预算 |
| Faux soak | 通过；`artifacts/acceptance/soak-1791991525766/result.json`：运行 14,404,242 ms（约 4 小时）、2626 条消息、游标 31,548、RSS 峰值 153,202,688 B、双库 WAL 峰值 2,529,744 B；基线 RSS 112,005,120 B，增长约 36.8%，游标连续且没有重复调度 |
| Trace 服务端筛选 | Server 路由在筛选前验证 Run 所属权，并校验必须有过滤条件、状态、长度及分页边界；Server/Telemetry 覆盖组合筛选、筛选后分页、无过滤/非法状态拒绝、账号/Run 子树隔离 |
| 用户数据盘点 | `users/` 含 574 个空目录、未发现文件；项目根 `state/`、`backups/` 不存在；未读取或修改用户数据。忽略目录 `artifacts/acceptance/` 仍含历史证据与过程文件，未删除其中内容 |
| 真实模型 | 本机已使用隔离配置显式运行 smoke；模型列表诊断 HTTP 200，但两次隔离流式请求均以 `provider_error: terminated` 失败且 0 token。按故障规则停止重复请求；真实模型主链路、评测、性能及 soak 未验收 |

Web 的 Trace 面板当前按 Run 查询，提供 service、kind、status、name 和最近时间窗筛选，文本输入防抖后请求；阶段按服务端分页展示，带层级缩进、语义状态色、空结果、错误重试和复制反馈，并以 live region 播报结果。新增交互已由 Faux Web E2E 在桌面和 320–2560px 视口验证，前端规格与生成的设计索引已同步。读屏器专项、真实设备视觉验收仍未完成。

验收对象：Core 1.3.0、Android 源码 1.4.3（versionCode 17；正式签名 APK 尚未发布）、Protocol v16、HTTP `/api/v16`、业务 SQLite schema 27。本文只记录当前候选的可复核结果；历史日志、截图和隔离数据库仍保存在 `artifacts/acceptance/`，不替代当前结果。

## 当前结论

**前序候选当时结论：本地和 Faux 验收通过；真实模型与 Android APK 发布仍有阻塞。** 该段记录的四小时 Faux soak、性能及 Web E2E 均属于前序候选，不能用作本轮最终源码的验收证据。本轮终版 soak 未达到四小时；当前未验收项见上方“2026-10-15 本轮最终验收”。其余内容记录当时的 Windows Native Core、Web/PWA、数据隔离、Trace 和 Android 签名状态。

真实模型脚本只使用隔离配置、临时 state、workspace、账号和令牌；失败后脚本清理临时目录，未写入历史用户数据。当前可复核的真实 Embedding 隔离 smoke 仍为两条输入、1024 维、315ms；它不能替代聊天模型验收。未启动闲鱼 Adapter，也未发送闲鱼消息。

## 服务器部署结果

2026-10-11 已使用提交 `3144b718f6d4` 完成生产 Native promote。release `20261011074257-3144b718f6d4` 通过依赖链接、Protocol v16/schema 27、包导入和保护用户指纹校验；脚本先创建在线备份，再原子切换 `/opt/uma-agent/current`。部署后 Core、Browser Worker 和 Xianyu Adapter 均为 active，`/api/v16/health/live` 与 `/api/v16/health/ready` 均返回 200，版本 1.3.0、Protocol 16。备份文件保留在服务器受保护目录，未进入仓库。

2026-10-11 已将生产配置的 `default`、`reasoning`、`fast` 和 `vision` 角色统一切换为 `openai/gpt-6.1-sol`，并重启 Core 后通过 `/api/v16/health/ready`。停服前已创建在线数据库备份 `state-default-model-20261011111225.db`；随后在事务中将现有 6 个 session 更新为 `openai/gpt-6.1-sol`。更新后 schema 为 27，`integrity_check=ok`、外键检查为空，session 不匹配数为 0；users、sessions、messages、runs、attachments 行数保持为 6/6/1209/110/55，110 条历史 Run 的 `model_snapshot_json` 哈希保持不变。该变更只影响现有 session 的后续消息和新 Run，不改写历史运行快照、消息、附件或账号数据。

同日针对网关不接受 GPT-6.1 Sol 的 reasoning effort `none`/`minimal` 发布 hotfix release `20261011120205-d6c3aae`。运行时将这两个等级声明为不支持，关闭思考时省略 reasoning 字段，`minimal` 由 Pi 收敛到最低可用 `low`，其余支持等级按用户选择发送。Native promote 创建备份 `state-20261011120919.db`，受保护用户指纹校验与 ready 检查通过；Core、Browser Worker、Xianyu Adapter 均 active。部署后只做了 readiness 和数据完整性核验，未额外发送真实模型 smoke 请求。最终数据库仍为 schema 27、`integrity_check=ok`、外键检查为空，7 个 session 全部指向 `openai/gpt-6.1-sol`。

同一构建曾在 staging 尝试启动；因 staging 历史数据库仍是旧 schema，新版本按契约拒绝启动，脚本自动恢复原 staging release。该回滚未影响生产，也未执行任何运行时迁移；staging 后续应先恢复匹配当前 schema 27 的隔离备份再复测。

历史记录（2026-10-11，当时发布版本）：修复了回复下方“审查/改进”操作：普通助手消息此前没有持久化指向对应用户消息的父链，质量 Run 因而找不到待审查问题并失败；新回复和澄清回复现在记录父消息，既有缺少父链的历史记录从活动分支最近的前序用户消息解析，无需数据迁移。Web 点击后立即显示提交/排队/执行状态，按 Run 终态显示错误；改进正文从质量历史读取，避免因结果消息不属于活动分支而空白。提交 `33415c4` 部署为 Native release `20261011135637-33415c4`，创建在线备份 `state-20261011140416.db`；Native promote、依赖和包导入检查、受保护用户指纹校验均通过，Core、Browser Worker、Xianyu Adapter 均 active，live/ready 均返回 200，schema 仍为 27。验收命令 `npm run check`、`npm run test:coverage`、`npm run build`、`npm run test:web:e2e` 均通过；Vitest 62 个文件/356 项，覆盖率语句 81.91%、分支 73.27%、函数 77.03%、行 84.67%，Web E2E 37/37。该版本功能已于 2026-10-12 从当前候选完整移除；本段只记录当时的发布事实。

## 2026-10-12 助手回复审查/改进功能移除验收

当前候选已从 Web、Android、CLI、Client SDK、Server API、Core Runtime 和 Protocol 中删除助手回复的审查/改进入口及执行链，并移除 UM-09 设计页、对应交互图和过期测试。系统管理员质量诊断、评测、记忆事实审核及 Skill 审查仍是独立能力，不在本次删除范围内。schema 维持 27，不做迁移；旧质量 Run 类型及质量记录表只保留为历史数据，不再提供新建入口。

本次验证通过：`npm run check`、`npm run test:coverage`（59 文件/346 项）、`npm run build`、`npm run build:web:embed`、`npm run check:android`、`npm run test:eval:faux`（6/6）、`npm run test:perf`、`npm run test:web:e2e`（37/37）及 `python docs/frontend-design/validate.py`（31 页/82 动作/149 图/0 问题）。当前 20 请求性能结果为 API p95 5.84ms、事件分页 p95 1.58ms、RSS 112,246,784B、双库 WAL 2,224,864B、单核等效 CPU 平均/峰值 4.3437%、事件循环 p95 30.10ms，均低于现有门槛。Web E2E 断言助手回复不再出现审查、改进按钮；Server 测试断言旧 API 路径返回 404；Core 数据库测试确认历史 `review` Run 记录仍可读取。

## 2026-10-12 生产部署与 Android 发布状态

Server release `20261012011000-d83395b` 已 promote 到 `/opt/uma-agent/current`。`deploy/promote-native-release.sh` 创建在线备份 `/srv/backups/uma-agent/state-20261011171654.db`，并通过 release 依赖/schema 检查、保护用户指纹前后对比和数据库完整性门禁。部署后 Core、Browser Worker、Xianyu Adapter 均为 active；`/api/v16/health/live` 与 `/api/v16/health/ready` 均返回 200，Protocol v16、schema 27。

2026-10-12 最终复核确认 `/opt/uma-agent/current` 仍指向 `20261012011000-d83395b`；`uma-agent.service`、`uma-browser-worker.service`、`uma-xianyu-adapter.service` 均为 active，loopback live/ready 均返回 HTTP 200，响应版本为 Core 1.3.0、Protocol 16。无额外代码变更需要再次部署；本轮文档修订不改变已部署二进制。

Android 源码移除回复审查/改进入口并通过 `npm run check:android`。本次另执行 `:app:assembleRelease`，构建成功但只生成 `app-release-unsigned.apk`；Gradle `signingReport` 的 release 配置为 `Config: null`，`apksigner` 无法验证 unsigned 产物。当前机器没有配置正式签名环境变量，服务器发布目录也未发现正式 keystore；依据[Android APK 发布规则](deployment.md#61-发布前置条件)，不能用 Debug 签名或新证书替代正式签名。

生产 `/srv/www/robotclaw/app/latest.json` 仍指向 1.4.1（versionCode 15，release `15-3be11fc`）；`releases.json` 的最高历史版本为 1.4.3（versionCode 16，release `16-cf44345`）。当前源码已更新为 1.4.3（versionCode 17），但正式签名 keystore 尚未配置，无法生成可覆盖已安装版本的发布 APK；取得原正式 keystore 后仍须比较签名指纹、验证清单和 APK 哈希，再由获授权的发布流程原子发布。已安装客户端更新前仍会显示旧按钮；Server 当前代码已移除相应路由，自动化测试确认该 API 返回 404。实体 Android 设备尚未连接，正式 APK 发布前还须完成真实覆盖安装、登录、进程重启、历史读取和消息发送验收。当前 Android 发布结论为**阻塞**，未将 unsigned APK 上传或切换到线上。

## 当前契约

- 版本事实源为根目录 `RELEASE`、根 `package.json` 和 Android `app/build.gradle.kts`。
- 业务数据库只接受 `PRAGMA user_version=27`；版本不匹配直接拒绝启动，不提供运行时兼容层或迁移工具。历史用户数据、草稿、附件、账号、渠道 Cookie 和正式备份必须保留在匹配版本的隔离恢复环境。
- Trace 使用 W3C `traceparent` 贯穿 HTTP、队列、Run、模型、工具、MCP、Worker 和渠道。外部 `traceparent` 只作关联，不是授权凭据。
- Trace 查询先完成账号和 Run 子树过滤，再分页；服务端返回 `depth`、`rootSpanId`、稳定 `nextOffset`。属性、事件和错误文本脱敏，不保存 prompt、模型正文、完整 URL、Cookie、Token 或原始工具参数。

## 已通过门禁

| 门禁 | 结果 | 证据或命令 |
| --- | --- | --- |
| 架构检查 | 通过（受控债务） | `npm run check:architecture` 通过；六个文件登记在尺寸基线，其中五个当前超过 900 行，CLI `main.ts` 为 894 行；超基线或未登记的大文件会失败 |
| 文档契约检查 | 通过 | `npm run check:docs-contracts`；14 个 Markdown 文件、版本/schema/命令/本地链接一致 |
| Biome 与 TypeScript | 通过 | `npm run check` |
| 单元测试与覆盖率 | 通过 | 当前候选 `npm run test:coverage`；59 个文件、350 项，语句 81.96%、分支 73.90%、函数 76.49%、行 84.73% |
| 完整构建 | 通过 | 当前候选 `npm run build`；所有 workspace 编译、Web 生产包及 Workers 构建通过 |
| 嵌入 Web 构建 | 通过 | 当前候选 `npm run build:web:embed`；CSS 118.62 KiB，入口 JS 543.32 KiB |
| Faux 评测 | 通过 | 当前候选 `npm run test:eval:faux`；6/6 |
| Faux 四小时 soak | 通过 | 当前样本 `artifacts/acceptance/soak-1791991525766/result.json`：约 4 小时、2626 条消息、游标 31548、RSS 峰值 153,202,688B、双库 WAL 峰值 2,529,744B；历史样本 `artifacts/acceptance/soak-1791685462712/result.json` 亦通过 |
| Web 全量 E2E | 通过 | 当前候选 `npm run test:web:e2e`；38/38，含 Trace 筛选、窄屏无溢出、助手回复菜单不再展示审查/改进的回归检查 |
| Android JVM/instrumentation 编译 | 通过 | 当前候选 `npm run check:android`；Gradle Debug 单测与 instrumentation Kotlin 编译通过 |
| 前端设计产物 | 通过 | 当前候选重新生成并校验；31 页面、82 动作、149 图、0 问题 |

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

证据目录为 `artifacts/acceptance/android-matrix-20261011-124744/`；API 36 模拟器、host GPU、Android 1.4.3 debug 包。六组功能与布局检查全部通过、截图无效项为 0，正文显示 p95 均低于 100ms，未出现超过 700ms 的冻结帧。

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
5. `database.ts`、`runtime.ts`、`App.tsx`、Server `app.ts` 和 Client `index.ts` 超过 900 行；CLI `main.ts` 当前 894 行。六个文件都登记在尺寸基线中，后续职责拆分不作为本候选发布硬阻塞。

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

