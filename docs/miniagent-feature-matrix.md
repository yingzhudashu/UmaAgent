# MiniAgent 功能等价矩阵

这份矩阵是 UmaAgent 与参考 MiniAgent 实现的对照入口。状态以当前代码和门禁证据为准；不因为参考实现存在一个模块就增加新的抽象。

| 能力 | UmaAgent 状态 | 证据/门禁 | 后续动作 |
| --- | --- | --- | --- |
| queue/preemptive 消息队列 | implemented | Runtime queue、preemptive 和取消测试 | soak 中持续验证 |
| direct/clarify/plan | implemented | Faux Eval 与 Runtime 测试 | 保持回归样本 |
| ReAct 工具循环 | implemented | Tool loop guard、Action Ledger 测试 | 增加长循环性能样本 |
| review/improve/correct | implemented | Server/API/Runtime 测试 | 补 CLI/Web 端到端用例 |
| 记忆事实、候选、supersede | implemented | Memory API、FTS、审计测试 | 增加跨会话召回样本 |
| rollup 与历史回溯 | implemented | Context、history search/read 测试 | 增加长历史性能样本 |
| FTS5 知识库 | implemented | Knowledge ingest/search/reindex 测试 | 以 Recall@8 结果决定是否扩展 |
| Embedding 语义知识检索 | implemented | OpenAI-compatible provider、批量缓存、余弦检索与 FTS 回退 | 增加真实 provider smoke |
| schedule/background task | implemented | Scheduler 重启、occurrence、API 测试 | soak 验证无重叠和无重复 |
| SKILL.md 生命周期 | implemented | 内置 Web/StackExchange/Skill Creator/Vetter 基线、MiniAgent frontmatter 门控、staging、审查、enable/disable、refresh 测试；可执行代码包直接拒绝 | 持续补充静态 Skill 边界样本 |
| MCP stdio/HTTP | implemented | MCP 状态、审批、超时测试 | 保持 Core/Worker 隔离 |
| `/test` 与评测趋势 | implemented | Eval Runner Faux、趋势 API、CLI/Web 趋势展示和失败分类测试 | 持续用真实 Provider 验证 |
| trace/diagnostics/stats | implemented | SQLite Trace spans、Run 查询、资源快照、p50/p95/p99 diagnostics | 持续用真实 Provider 和 soak 验证 |
| dream 维护 | implemented | 确定性 rollup/裁剪，不调用模型 | 不引入模型梦境生成 |
| 自动修改代码/自我优化 | implemented | 提案接受、workspace 边界、持久备份、原子替换、固定验证命令、失败自动恢复和管理员 rollback 测试 | 持续以性能证据驱动提案 |
| Xianyu 闲鱼渠道 | implemented | Core schema 24 渠道会话/设置/投递幂等、按买家持久映射与去重、Web/CLI/Android 管理员 PAT 工作台、普通账号切换、总控与买家会话、自动回复开关与草稿发送、二维码登录、0600 Cookie 持久化、过期停用和飞书告警；Adapter 仅接受回环内部 Bearer 令牌 | 真实账号 E2E 需独立账号、真实 Cookie 或管理员扫码，另行执行咸鱼验收清单；`real-test.mjs` 不包含咸鱼流程。飞书告警需配置知识库 App 凭证与 chat ID |

## 使用规则

- 评测只保存公开样本标识、结果、耗时和错误摘要，不保存隐藏思维链或凭据。
- 任何新增公共接口都必须同步更新 Protocol、Client、CLI/Web、Fake 样本和门禁；不写兼容层。
