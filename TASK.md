# UmaAgent 可用性整改与验收

## 目标与边界

修复 Trace 生命周期、外部父链和遥测聚合；审查代码、前端、文档与过程文件；完成 Core/Web 生产发布、Android 正式包发布及当前支持范围验收。历史用户数据必须保留；本轮不执行数据库迁移，不发送真实渠道消息，不重放已失败的真实 Provider 请求。

## 已完成证据

- Core/Web 已从干净提交 `818cd0d96bcfc24c39f5fca5d57ade7c1b09014b` 发布：Core `20261016000741-818cd0d`，Web `20261016000804-818cd0d`。
- 正式发布前备份、受保护账号指纹、原子切换和 readiness 门禁通过；发布期间按流程重启 Core，未修改 Nginx，未发送真实业务消息。
- 线上只读复核通过：live/ready 200，Core/Browser Worker/Xianyu Adapter/RobotClaw/Nginx active，退役入口返回 404，公网 `/umaagent/` 在 390/1280px 挂载和公式字体检查通过。
- 生产 state.db 只读复核：schema 27、integrity_check=ok、外键违规 0；摘要计数 users 6、sessions 6、messages 1289、runs 127、attachments 54。没有迁移或修改历史用户数据。
- Android 1.4.4/versionCode 18 已发布，release `18-818cd0d`；APK 13,000,165 bytes，SHA-256 `9ed5d4b1273af2f5d7d8523ca7ba119a5fa97bbe5cbc643f61b8f5562832f711`，正式签名与线上旧包一致；公网下载复核、API 36 模拟器安装、首次启动和强制停止后的冷启动通过。
- Trace 生命周期、外部父级识别和 SQLite 资源聚合修复已通过覆盖率、构建、Web E2E、固定性能和四小时 Faux soak 验收；前端设计资料校验 31 页、82 项交互、149 图、0 问题。
- Web/Android 前端细节优化已落地：回复层级、主题内行代码、回复卡片层次和 Android Surface 阴影同步；定向 Web E2E 16/16、Android 内容构建和规格校验通过。
- 忽略目录中的本轮过程文件已清理；历史验收证据、发布证据和用户目录保留，未有过程文件被 Git 跟踪。

## 未验收项与边界

- 真实 Provider smoke 曾两次以 `provider_error: terminated`、0 token 失败；遵守不重放同类请求的约束，真实模型对话仍未验收。
- Docker/Linux、实体 Android 真机、读屏及真实闲鱼账号消息链路未执行，不能标为通过。
- Android 840dp 双栏和横屏 200% 字体在连续 2GB API 36 AVD 矩阵中的增量 p95 分别为 116.99ms、102.13ms，超过 100ms 门槛；默认手机功能和性能通过，需资源充足设备复测后再关闭该边界。
- 空的 ignored 目录 `artifacts/acceptance/soak-1792073458235/` 仍因执行环境限制未删除；其中三个临时文件已删除，未绕过限制。

## 复核状态

Claude Opus 5.5 以请求 effort `max` 完成只读发布复核并通过；复核以最终源码、发布证据、线上只读结果和明确未验收边界为依据，未要求修改代码。模型字段仅记录工具返回值，不能独立证明上游身份。

## 必需后续

真实 Provider、Docker/Linux、实体 Android、读屏和真实闲鱼链路需要具备对应受控环境后另行验收；生产代码发布、重启和数据操作须另行授权。

## 弱网络重试增量（2026-10-20，未部署）

- 用户追加目标：弱 Provider 环境下不因三次应用层退避不足而频繁中断，接受更长等待，要求保持取消和副作用安全边界。
- 已在当前工作树的既有重试改动上增强：默认模型请求硬时限由 300000ms 调整为 600000ms；流式瞬态错误最多重试 7 次，退避 1000ms 起、30 秒封顶并带抖动；缺失 `finish_reason` 最多重试 5 次。
- SSE/Fetch 异步迭代器在尚未暴露有效输出时抛出异常也会进入同一重连路径；已有有效输出后仍不重放，避免重复文本和未知工具副作用；用户取消仍即时打断退避。
- 本地验证：定向 Core 测试 3 个文件共 35 项通过；模型重试/调用测试 28 项通过；Runtime 测试 50 项通过；全部 Core 测试 34 个文件、245 项通过；`npm run check`、Core 构建与 `git diff --check` 均通过。基线策略 3 次重试与增强策略 7 次重试均有隔离输出记录，回滚副本恢复原 SHA 后同一探针回到 3 次重试。本节最初记录时尚未进行真实 Provider 调用或生产部署；后续实测见下节。
- Codex 的内部重连实现及精确重试预算没有可核实的公开依据，本次只采用有界重试、指数退避与抖动、尊重 `Retry-After`、共享硬超时、即时取消等通用恢复模式，不声称复刻其私有机制。
- 此前 Claude 只读规划和复核的工具元数据为 `requested_effort=medium`。本轮发布前另行调用只读 plan/review，二者工具元数据均为 `requested_effort=high`；review 返回可进入 Native 发布的结论。该网关元数据不是独立上游身份认证。
- 当前 `uma.config.json` 为本地显式配置且仍是 300000ms；未改动该含凭据配置。若要让已部署实例采用 10 分钟预算，需在受控环境把 `runtime.modelTimeoutMs` 改为 `600000` 后按发布流程重载/重启并验收。
- 发布前一致性核查发现 Native、production、staging 三个示例配置及真实 Provider 隔离测试夹具仍显式使用 300000ms；已统一改为 600000ms。受控生产 `/etc/uma-agent/uma.config.json` 当前未显式设置该字段，因而新版本会使用代码默认值 600000ms；真实 Provider 测试脚本本轮不执行，避免重放已有失败请求。

## 2026-10-20 Native 发布与复核

- 发布源为本地提交 `06f861fddd5f34e67b01d20b675589275b5d985c`（未推送 Git 远端）；发布包 SHA-256 `01d27d6d2b161bb906657ae0c0c70b4024104f949ecc3cf63dd57a04415958da`，本地留存于 `artifacts/acceptance/retry-resilience-20261020/20261020114045-06f861f.tar.gz`。
- `npm run check`、完整 `npm test -- --run --reporter=dot`（59 个文件、368 项）、`npm run build`、`git diff --check` 通过；改动后补跑定向测试（3 个文件、36 项）也通过。Native release 候选在服务器运行 `link-native-dependencies.sh` 与 `verify-native-release.sh` 成功。
- 发布前通过本地已配置 SSH 别名及严格主机密钥校验确认目标；Core、Browser Worker、Xianyu Adapter 均 active；数据库 `integrity_check=ok`、schema 27、外键违规 0，且无 queued/preflight/running Run。生产配置未显式设置 `runtime.modelTimeoutMs`。
- 正式 Promote 成功，线上 `current` 已切换至 `/opt/uma-agent/releases/20261020114045-06f861f`；Promote 内建在线备份为 `/srv/backups/uma-agent/state-20261020114501.db`。新代码实测导出默认超时 600000ms、瞬态重试 7 次、缺失结束标记重试 5 次；线上 Core、Browser Worker、Xianyu Adapter active，live/ready 均返回 200。当前库与备份库均为 schema 27、完整性 ok、外键违规 0；发布后无 active Run，服务启动后 error-priority journal 无记录。
- 本次没有改动 Android、Web UI 或客户端协议，不需要新的 APK/客户端发布；仅 Native Core 服务端 release。
- 根因尚未完全确认：既有记录中真实 Provider 两次 `provider_error: terminated`；但线上数据库最近 7 天的只读汇总为 model call 186 次、failed 74 次，其中错误文本字面匹配 `timed out` 为 13、`401` 为 1、`abort` 为 2、`terminated` 为 0（分类可能重叠）。本轮未读取原始错误正文，也未发送新的真实 Provider 请求，因此不能证明所有故障都是可重试瞬态或宣称问题完全根治。
- 未验收项：真实 Provider smoke/弱网现场效果、10 分钟真实等待体验及长期失败率变化。发布仅证明新策略已上线且服务健康；部署后运行效果需在真实用户流量中继续观察。
