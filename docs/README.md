# UmaAgent 文档索引

- [服务器部署、验收、备份与恢复](deployment.md)
- [架构、质量与性能基线](architecture-quality.md)
- [工程边界与性能预算](engineering-baseline.md)
- [MiniAgent 功能等价矩阵](miniagent-feature-matrix.md)
- Trace 与资源样本独立持久化在 `telemetry.db`，业务状态使用 SQLite schema 20；真实 API 验证命令和密钥边界见 [部署文档](deployment.md)。

根目录 [README](../README.md) 用于项目概览与本地开发；生产部署以 `deployment.md` 为准。代码中的当前版本、Protocol 和 schema 是最终事实源，版本不匹配时必须先更新文档；schema 20 是唯一支持格式，其他版本直接拒绝启动。
