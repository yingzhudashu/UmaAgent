# UmaAgent 文档索引

- [后端设计与状态约束](backend-design.zh-CN.md)
- [Android 页面与交互设计](android-design.zh-CN.md)
- [前端设计规格](frontend-design.zh-CN.md) · [逐页图文版](frontend-design/index.html)
- [部署、备份与恢复](deployment.md)
- [架构与质量约束](architecture-quality.md)
- [代码审查](code-review.md)
- [发布验收与当前结果](release-acceptance.md)
- [工程边界与固定性能预算](engineering-baseline.md)
- [MiniAgent 功能等价矩阵](miniagent-feature-matrix.md)

Core 1.3.0，Android 源码 1.4.3（versionCode 17；正式签名 APK 尚未发布），Protocol v16，业务 SQLite schema 27。Trace 与资源样本单独保存在 telemetry.db。服务只接受当前 schema；旧 schema 不受支持，备份必须保留在原版本的隔离恢复目录中。

仓库不跟踪 APK、截图、日志、覆盖率、测试结果或验收临时目录；这些过程性产物只保留在本机忽略目录或发布系统的证据存储中。当前 Trace 查询支持 Run/Trace、时间、状态、名称、服务和阶段筛选，权限过滤先于分页。

根目录 [README](../README.md) 提供开发与 API 概览；当前支持范围和目标环境适配要求以发布验收为准，设计图不代表设备测试通过。

