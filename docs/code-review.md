# UmaAgent 代码审查

当前契约为 Protocol v16、HTTP `/api/v16`、业务 schema 27。自动检查只验证其覆盖的规则，不代表全部代码已经逐行证明正确。当前验收结论统一见 [发布验收](release-acceptance.md)。

## 审查范围

|区域|检查重点|验证入口|
|---|---|---|
|Core 与数据库|事务、分支可见性、分页、取消、审批策略、未知副作用恢复|Core 与迁移测试|
|Server、Protocol、Client|严格 schema、v16 路由、所有权、offset、重连|Server/Protocol/Client 测试|
|Telemetry|Worker 生命周期、有界队列、批量事务、flush、脱敏与隔离|Telemetry 与 Trace 测试|
|Web|导航、菜单、设置、输入法、草稿、正文安全与响应式|Web 单测与 Playwright|
|Android|Compose 层级、Insets、离线正文、草稿、字号与设备行为|JVM、instrumentation、截图与采样|
|文档与部署|版本、命令、默认值、能力声明、备份和离线迁移|源码核对与设计检查|

## 实现不变量

- 账号策略更新与审计同事务；默认免审批不绕过权限和工作区边界。
- schema 24→25 工具先取得服务锁、校验原库、备份并校验备份，再在事务中转换，失败回滚。
- 历史先筛选再加载正文；步骤与附件批量查询；SQL 缓存有界且按连接隔离。
- 临时增量不推进永久游标；持久终态覆盖临时内容。重连校准快照。
- Android 上传结果回到发起会话草稿，旧账号回执不能污染新账号。创建任务或调度失败保留输入。
- WebView 无凭据与文件访问能力；正文经过 DOMPurify，KaTeX 禁止可信命令。附件 URI 只转换链接目标，代码字面值保持原样。
- 遥测事务失败整体回滚后隔离重试；故障累计计数，不改变业务结果。
- Trace 查询在分页前执行用户过滤，复用 traceId 不能扩大权限。

## 验证入口

执行 npm run audit:source、npm run check、npm run test:coverage、npm run build、npm run build:web:embed、npm run test:web:e2e、npm run test:eval:faux、npm run test:perf 和 npm run test:soak:faux。设备测试独立执行，不能以 JVM 或编译替代。真实模型测试使用隔离 state、workspace、用户和令牌，显式启用 UMA_REAL_API=1；不启动咸鱼 Adapter 或发送真实消息。未执行项必须明确标注。
