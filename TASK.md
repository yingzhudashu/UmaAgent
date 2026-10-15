# UmaAgent 可用性整改与验收

## 目标与边界

修复 Trace 生命周期、外部父链和遥测聚合；审查代码、前端、文档与过程文件；完成 Core/Web 生产发布、Android 正式包发布及当前支持范围验收。历史用户数据必须保留，不执行数据库迁移、生产数据写入或真实渠道消息。

## 已完成证据

- Core/Web 已从提交 `c53d333c4bb6c86b4858793727f653c1c44aceec` 发布；生产 schema 27，备份、账号指纹和完整性门禁通过。
- Trace WebSocket 生命周期、远端父 Span 识别及 SQLite 资源汇总已修复；不回写历史 Span。
- coverage 59 文件、356 项；语句 82.13%、分支 74.24%、函数 76.78%、行 84.91%。全量构建、Embed、Android 检查、Faux 6/6、Web E2E 38/38、固定性能及前端规格检查通过。
- 四小时 Faux soak：14,403,552ms、2,629 条消息、游标 31,584、峰值 RSS 155,672,576B、双库 WAL 2,723,384B；预算、连续性和调度检查通过。
- Android 1.4.3/versionCode 17 已在线。公网与本地正式 APK 均为 13,000,133 bytes、SHA-256 `87202a47455f9a8c3641d807d3544bf556d737327966885d06f2a45f90dea2a1`；APK v2 签名有效。临时 Android 36 AVD 首次安装、启动和强制停止后的冷启动通过。
- 2026-10-16 公网只读复验通过：Core/Web release、资源哈希、服务健康、退役路径及 390/1280px 浏览器挂载和公式字体正常；未重启生产服务或写入数据。
- 一次性 Android 36 AVD 已删除；本轮 soak 目录 `artifacts/acceptance/soak-1792073458235/` 的 3 个忽略文件因执行环境拒绝删除仍留在本机，未尝试绕过限制。历史验收记录及必要数值保留于 `docs/release-acceptance.md`。

## 本轮前端细节优化（2026-10-16）

- Web 回复卡片增加轻量层次阴影；共享 Markdown 的行内代码统一使用主题底色与 2px/5px 内边距，代码块保留 1px 边界；Web 与 Android 继续共用正文渲染规则。
- Android 回复 Surface 增加 1dp `shadowElevation`，标题和标签采用明确字重；WebView 继续按既有桥接更新正文主题，保留深浅主题与字号变化行为。
- 前端设计规格、生成索引和 Android 设计文档已同步；Playwright 截图改为 `testInfo.attach`，没有新增 Git 跟踪的过程截图。
- 已通过：`npm run check`、`npm run check:android`、`npm run build:android:content`、`python docs/frontend-design/render.py`、`python docs/frontend-design/validate.py`（31 页面、82 交互、149 图、0 问题）、定向 Web E2E 16/16；Claude Opus 5.5（请求 `max`，返回模型 `claude-opus-5-5`）只读视觉复核结论通过，复核未编辑文件。
- 干净 Android 36 AVD 六配置矩阵中，手机配置的 15 项仪器测试全部通过（含 `MessageBodyTest` 与 `BodyPerformanceTest`），增量 p95 71.65ms、最大帧 19.03ms；840dp 双栏及横屏 200% 的增量 p95 越过 100ms 门槛，其余四组通过。连续运行时出现 2GB AVD 系统内存和 WebView renderer 资源波动，未降低门槛或修改功能，设备设置已恢复原值。

## 剩余未验项

- 真实 Provider smoke 曾两次以 `provider_error: terminated`、0 token 失败；本轮未重放请求，真实模型对话仍未验收。
- Docker/Linux、实体 Android 真机、读屏及真实闲鱼账号链路不在本轮验证范围，不能标为通过。
- Android 840dp 双栏与横屏 200% 字体的增量 p95 在连续 2GB AVD 矩阵中越过 100ms 门槛；默认手机单项与功能断言通过，需在资源充足设备复测后再关闭该性能边界。
- `artifacts/acceptance/soak-1792073458235/` 中的三个临时文件已删除，仅剩空 ignored 目录；执行环境阻止删除空目录，未绕过限制。

Claude Opus 5.5（请求 effort `max`，返回模型 `claude-opus-5-5`）已完成最终只读复核并通过，复核范围包括生产、Android、Trace、性能、前端与未验收范围。UmaAgent 与 MyServer 的提交均已在本地生成，但远端推送未完成：HTTPS 连接到 GitHub 被重置/超时，严格校验 SSH 主机密钥后返回公钥认证拒绝；需要恢复有效 GitHub 认证和网络后再推送。
- MyServer `main` 有 6 个提交待推送；UmaAgent 本地有 staging 停用变更与验收文档差异待检查、提交和按授权推送。
