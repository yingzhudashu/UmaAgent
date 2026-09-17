# UmaAgent 文档索引

- [后端设计与状态约束](backend-design.zh-CN.md)
- [Android 页面与交互设计](android-design.zh-CN.md)
- [前端设计规格](frontend-design.zh-CN.md) · [逐页图文版](frontend-design/index.html)
- [部署、备份、离线升级与恢复](deployment.md)
- [架构与质量约束](architecture-quality.md)
- [代码审查](code-review.md)
- [发布验收与当前结果](release-acceptance.md)
- [工程边界与固定性能预算](engineering-baseline.md)
- [MiniAgent 功能等价矩阵](miniagent-feature-matrix.md)

Core 1.3.0，Android 1.4.0（14），Protocol v16，业务 SQLite schema 25。Trace 与资源样本单独保存在 telemetry.db。schema 24 必须停机使用显式离线升级工具，禁止删除真实库规避升级。运行时无旧版本兼容层。

根目录 [README](../README.md) 提供开发与 API 概览；当前验收结论以发布验收为准，设计图不代表设备测试通过。
