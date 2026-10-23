# UmaAgent 项目入口

## 结构与事实源

TypeScript npm workspaces；Node >=22.19.0。Core 负责业务和授权，Server 负责认证与传输，Protocol 定义当前严格合同，Client 统一通信；Web/CLI/Android/渠道均通过接口访问 Core。共享正文模块为 packages/message-content。业务 schema 27、Protocol v16；不提供旧接口、兼容解析或迁移入口。

## 阅读顺序

README.md → docs/README.md → docs/backend-design.zh-CN.md 与 docs/frontend-design/spec.json。前端 Markdown/HTML/SVG 由 docs/frontend-design/render.py 生成，不独立编辑生成内容。Android 以 docs/android-design.zh-CN.md 为实现合同；分支与队列见 docs/conversation-execution-recovery-design.zh-CN.md。

## 验证与数据边界

npm run check、npm run test:coverage、npm run build、npm run test:web:e2e、npm run test:eval:faux、npm run test:perf 为主要入口；Android 编译及设备测试单独执行。性能预算固定在 scripts/perf-baseline.json，不降低功能、同步级别或负载来过门禁。

Faux state、workspace、skills 使用独立目录，发现已有 state.db 即拒绝启动。users、私人配置、凭据、业务数据库和发布备份不得用于测试或清理。Trace/资源写独立 telemetry.db，入口、模型、工具及 Worker 按 W3C traceparent 关联；写入和查询边界统一脱敏。

## 当前工作

单次任务、授权和未完成项只在 TASK.md；当前验收结论只在 docs/release-acceptance.md，长期工程约束见 docs/architecture-quality.md。生产写入、部署、重启和远端推送需有覆盖具体动作的授权。不要把历史发布记录当作本轮环境验证。
