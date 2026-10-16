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
