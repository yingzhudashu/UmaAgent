# UmaAgent 发布验收

本文记录当前工作树的验收标准、最近一次验证结果与未完成项，不保留历史发布过程或临时备份路径。自动门禁已通过；真实 Provider 验证和长时内存稳定性仍未完成，因此不标记为全部验收通过。

## 版本与存储

- UmaAgent `1.3.0`，Protocol `v15`，HTTP API `/api/v15`。
- 业务库使用 SQLite schema `24`。旧 schema 直接拒绝启动；发布前停止服务、备份并清理旧 `state.db`，由新版本初始化空库。
- Trace 和资源样本统一写入 `telemetry.db`；`state.db` 不包含 `trace_spans` 或 `resource_snapshots`。

## 自动门禁

```text
npm run check
npm test
npm run test:coverage
npm run build
npm run build:web:embed
npm run test:web:e2e
npm run test:perf
npm run test:soak:faux
```

Android：

```text
cd android
./gradlew.bat :app:testDebugUnitTest :app:assembleDebug :app:assembleDebugAndroidTest --no-daemon
./gradlew.bat :app:connectedDebugAndroidTest --no-daemon
```

## 功能验收

- Web、Android、CLI 使用 PAT 登录后可读取会话、快照、历史、附件和事件流。
- 管理员可进入咸鱼工作台；普通账号不能访问咸鱼接口。
- “切换普通 UmaAgent 账号”只清理当前客户端管理员令牌、Socket、轮询和缓存，不调用 Adapter stop/logout，不删除咸鱼 Cookie；Adapter 和自动回复继续后台运行。
- 普通账号 logout 清理本机 PAT、缓存和连接。
- Android 顶栏避开系统通知栏，底部导航避开手势区，深浅色主题和窄屏布局可用。
- 管理员按 `runId`/`traceId` 查询完整跨服务链路；普通用户必须指定所属 Run，只读取其 Span 子树。重复 traceId 不扩大权限；错误、属性、工具参数字段与 URL 完成脱敏。

## 本地验证结果（2026-09-08）

- `npm run check`、完整构建、`npm run build:web:embed`、Faux Eval（6/6）和 Web 7 项 E2E 已通过。覆盖率统计现在包含 Telemetry，不再遗漏该包；最终测试数量及比例见下表。
- Android Debug/APK、JVM 测试通过；模拟器的窄屏 411dp、宽屏 720dp、横屏 914dp 各执行 2 项设备测试，覆盖深浅主题、系统栏 Insets、导航和本地账号清理，并核对截图。
- 设备主题测试使用 Material 3 标准色板；Android 12+ 动态色代码已实现，但不同厂商真机的动态颜色、通知和生命周期仍需单独验收。
- Compose 和 CI YAML 已解析检查；本机没有 Docker 运行环境，不能据此宣称镜像构建、容器联网或 Linux systemd 验收通过。

性能使用 20 条 Faux 请求、1 个 Session、240 条连续事件，Windows / Node 24.15.0 / 16 逻辑核；下列数值来自同一轮 34.25 秒测试，不拼接不同轮次的最优结果。

| 指标 | 实测 | 门槛 | 结果 |
| --- | ---: | ---: | --- |
| 消息受理 API p95 | 12.69 ms | 12.8 ms | 通过 |
| 事件分页 p95 | 5.58 ms | 5.9 ms | 通过 |
| Core 采样峰值 RSS | 110.89 MiB | 180 MiB | 通过 |
| 两库 WAL 合计峰值 | 2.86 MiB | 3.2 MiB | 通过 |
| CPU 加权平均（单核等效） | 4.0941% | 5.5653% | 通过 |
| CPU 采样峰值（单核等效） | 4.3721% | 5.568% | 通过 |
| 事件循环区间均值的 p95 | 26.63 ms | 31.74 ms | 通过 |

性能预算恢复 CPU 参考基线，并为事件循环保留 20% 的 Windows 调度波动；采样定义与参考值见 [工程基线](engineering-baseline.md)。这轮 `npm run test:perf` 返回通过。

短时 soak 已通过。正常模式 10 分钟负载曾达到 190.1MiB，超过 180MiB 绝对门槛，仍未通过；强制 GC 诊断 3 分钟从 107.6MiB 增长到 114.4MiB，说明主要是 V8 驻留堆而非业务对象不可回收。不能用强制 GC 结果替代生产模式，因此长时内存稳定性仍是发布阻断项。

## 真实 Provider 验收

当前未获得隔离 Provider/咸鱼账号凭据，真实 smoke/perf/soak 均未执行。只有显式设置 `UMA_REAL_API=1` 和完整 `UMA_REAL_*` 配置才运行 Provider 脚本。

`scripts/real-test.mjs` 支持普通用户登录、对话、工具调用、评测和重复负载；资源/诊断查询使用临时库内的独立管理员 PAT，权限错误直接失败。临时 state/workspace/telemetry 与部署数据隔离。脚本不启动 Xianyu Adapter、不扫码，也不覆盖咸鱼控制/草稿流程。

完整发布仍需要补齐下列真实验收清单：

- smoke：登录、对话、工具调用、咸鱼状态/控制、草稿发送。
- perf：API/事件 p95、RSS、CPU、事件循环延迟、WAL、Trace 写入失败计数。
- soak：持续运行、重连、消息流、Adapter 后台运行和数据库稳定性。

明文凭据只从受控环境注入，不写入仓库、数据库、Trace、日志或报告；缺少凭据时必须明确记录为未执行。

Android connected test 本轮未执行：模拟器 `emulator-5554` 离线，没有在线设备。JVM 测试、Debug APK 构建和此前三种屏幕配置的设备测试已通过；恢复在线设备后需重新执行 `:app:connectedDebugAndroidTest`。
