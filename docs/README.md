# UmaAgent 文档索引

- [服务器部署、验收、备份与恢复](deployment.md)
- Android APK 发布、签名校验与移动端登录故障排查见 [服务器部署、验收、备份与恢复](deployment.md#6-android-apk-发布)。
- [架构、质量与性能基线](architecture-quality.md)
- [代码审查](code-review.md)
- [发布验收与当前结果](release-acceptance.md)
- [工程边界与性能预算](engineering-baseline.md)
- [MiniAgent 功能等价矩阵](miniagent-feature-matrix.md)
- Trace 与资源样本独立持久化在 `telemetry.db`，业务状态使用 SQLite schema 24；真实 API 验证命令和密钥边界见 [部署文档](deployment.md)。

根目录 [README](../README.md) 用于项目概览与本地开发；生产部署以 `deployment.md` 为准。代码中的当前版本、Protocol 和 schema 是最终事实源，版本不匹配时必须先更新文档；schema 24 是当前格式，旧数据库直接拒绝启动，发布前清理旧 state.db。
