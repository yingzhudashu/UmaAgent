# UmaAgent 可用性整改与验收

## 目标

修复 Trace 生命周期、父链识别和资源摘要性能；审查历史问题并补针对测试，校正文档和过程文件，执行当前支持范围内的全链路验收。保留历史用户数据，不迁移、不部署、不写真实渠道。

## 本轮已完成证据

- 外部 `traceparent` 父级从本地孤儿告警中排除；分页树根沿本地祖先识别外部根。旧 `server.http` 记录按入口语义处理，不回写历史遥测。
- WebSocket 握手 Span 在协议升级后结束；连接 Span 对正常/服务关闭/异常关闭有不同终态，close/error 幂等清理订阅和定时器。Preflight Provider 错误和取消会结束阶段 Span。
- 资源汇总通过 SQLite 计算，不再将整段资源样本读入 Node 堆；CPU 加权、p95 与峰值定义保持不变。
- 定向 Telemetry、Server、HTTP telemetry、Core runtime/model-calls 测试通过；`npm run check` 通过。

## 前序候选基线证据

- `npm run check`、`npm run test:coverage`（59 文件/350 项）、`npm run build`、`npm run build:web:embed`、`npm run check:android`、`npm run test:eval:faux`（6/6）、`npm run test:web:e2e`（38/38）、`npm run test:perf`、前端规格校验通过。
- 最近性能样本：API P95 5.52ms、事件分页 P95 1.94ms、RSS 111,357,952B、双库 WAL 2,253,704B、CPU 平均/峰值 3.1129%、事件循环 P95 30.36ms。
- `npm run check:docs-contracts`、`git diff --check` 通过。Claude Opus 5.5（请求模型 `claude-opus-5-5`、effort `max`）最终增量复核通过。
- Server Trace 权限、过滤、边界校验及分页测试已复核；版本文档统一为 Android 1.4.3 / versionCode 17。已从 Git 跟踪中移除旧 APK、截图和过程性产物；`artifacts/acceptance/` 历史证据保留。
- 本地 `users/` 仅有 574 个空目录；项目根无 `state/` 和 `backups/`。没有读取或写入真实用户数据。
- Claude Opus 5.5（请求 effort `max`，实际返回模型 `claude-opus-5-5`）只读审美复核确认设计令牌、响应式、Trace 面板、焦点与状态反馈无确证视觉缺陷，建议不改 UI；读屏、实体设备、跨浏览器逐像素等专项仍属环境外缺口。
- 终版 Faux soak 已完成并通过：`artifacts/acceptance/soak-1792037622280/result.json`，运行 14,400,396ms、2,620 条消息、游标 31,476、RSS 峰值 156,110,848B、双库 WAL 峰值 2,542,104B；资源预算、游标连续性和调度重复检查均通过。前两次被执行会话终止的未完成重跑不计入验收证据。

## 前序运行与阻塞记录

- 前序版本 Faux 四小时 soak 曾通过：`artifacts/acceptance/soak-1791991525766/result.json`，运行 14,404,242ms、2626 条消息、游标 31,548、RSS 峰值 153,202,688B（基线 112,005,120B）、双库 WAL 峰值 2,529,744B；该报告不替代本轮终版长时验收。
- 隔离真实 Provider smoke 两次返回 `provider_error: terminated`、0 token；模型列表诊断 HTTP 200。没有继续重放请求；真实模型 eval/perf/soak 未运行。须修复 Provider 连接后再验收。
- Android 正式 keystore 未配置，不能发布可覆盖安装的签名 APK；源码 1.4.3/versionCode 17 已编译。实体设备、Docker/Linux、真实渠道和专项读屏验收未验证；没有部署或发送真实消息授权。

## 后续验收

本轮 coverage（59 文件、356 项）、完整构建、Embed 构建、Android JVM/instrumentation 编译、Faux eval（6/6）、Web E2E（38/38）、独占固定性能、前端设计规格和终版四小时 Faux soak 均通过，结果见 `docs/release-acceptance.md`。终版 soak 运行 14,400,396ms，2,620 条消息、游标 31,476、RSS 峰值 156,110,848B、双库 WAL 峰值 2,542,104B；资源预算、游标连续性和调度重复检查均通过。历史 Android 优化/refactor 截图与 acceptance 解包源码已清理。本轮未完成的重复 soak 目录、临时数据库和 `soak-background.*.log` 仍在 ignored 路径；执行环境拒绝对这些路径递归删除，未尝试绕过限制。通过报告 `artifacts/acceptance/soak-1792037622280/result.json` 必须保留。真实 Provider、Docker/Linux、实体 Android、读屏及签名 APK 发布不在本轮通过范围；生产服务、数据库和真实渠道未写入。
