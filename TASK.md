# UmaAgent 候选审查与验收

## 目标

完成 Trace 功能和前端体验优化、文档一致性修订、仓库过程产物清理及风险相称的全链路验收；保留历史用户数据，不部署、不写真实渠道。

## 已完成证据

- `npm run check`、`npm run test:coverage`（59 文件/350 项）、`npm run build`、`npm run build:web:embed`、`npm run check:android`、`npm run test:eval:faux`（6/6）、`npm run test:web:e2e`（38/38）、`npm run test:perf`、前端规格校验通过。
- 最近性能样本：API P95 5.52ms、事件分页 P95 1.94ms、RSS 111,357,952B、双库 WAL 2,253,704B、CPU 平均/峰值 3.1129%、事件循环 P95 30.36ms。
- `npm run check:docs-contracts`、`git diff --check` 通过。Claude Opus 5.5（请求模型 `claude-opus-5-5`、effort `max`）最终增量复核通过。
- Server Trace 权限、过滤、边界校验及分页测试已复核；版本文档统一为 Android 1.4.3 / versionCode 17。已从 Git 跟踪中移除旧 APK、截图和过程性产物；`artifacts/acceptance/` 历史证据保留。
- 本地 `users/` 仅有 574 个空目录；项目根无 `state/` 和 `backups/`。没有读取或写入真实用户数据。

## 当前运行与阻塞

- Faux 四小时 soak 已通过：`artifacts/acceptance/soak-1791991525766/result.json`，运行 14,404,242ms、2626 条消息、游标 31,548、RSS 峰值 153,202,688B（基线 112,005,120B）、双库 WAL 峰值 2,529,744B；脚本退出码 0，成功路径清理临时 state。
- 隔离真实 Provider smoke 两次返回 `provider_error: terminated`、0 token；模型列表诊断 HTTP 200。没有继续重放请求；真实模型 eval/perf/soak 未运行。须修复 Provider 连接后再验收。
- Android 正式 keystore 未配置，不能发布可覆盖安装的签名 APK；源码 1.4.3/versionCode 17 已编译。实体设备、Docker/Linux、真实渠道和专项读屏验收未验证；没有部署或发送真实消息授权。

## 下一步

已核对 soak 报告并更新 `docs/release-acceptance.md`。最后运行文档契约和 diff 检查、复核工作区状态；真实 Provider 与正式签名 APK 仍需外部修复/签名材料，不能在当前权限和环境下验收或发布。
