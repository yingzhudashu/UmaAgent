# MiniAgent 功能等价矩阵

这份矩阵是 UmaAgent 与 `D:\AIhub\miniagent-python` 对照的单一审查入口。只有标记为
`missing` 或 `partial` 的能力才允许进入后续迭代；不因为 MiniAgent 存在一个模块就增加新的抽象。

| 能力 | UmaAgent 状态 | 证据/门禁 | 后续动作 |
| --- | --- | --- | --- |
| queue/preemptive 消息队列 | implemented | Runtime queue、preemptive 和取消测试 | soak 中持续验证 |
| direct/clarify/plan | implemented | Faux Eval 与 Runtime 测试 | 保持回归样本 |
| ReAct 工具循环 | implemented | Tool loop guard、Action Ledger 测试 | 增加长循环性能样本 |
| review/improve/correct | implemented | Server/API/Runtime 测试 | 补 CLI/Web 端到端用例 |
| 记忆事实、候选、supersede | implemented | Memory API、FTS、审计测试 | 增加跨会话召回样本 |
| rollup 与历史回溯 | implemented | Context、history search/read 测试 | 增加长历史性能样本 |
| FTS5 知识库 | implemented | Knowledge ingest/search/reindex 测试 | 以 Recall@8 结果决定是否扩展 |
| schedule/background task | implemented | Scheduler 重启、occurrence、API 测试 | soak 验证无重叠和无重复 |
| SKILL.md 生命周期 | implemented | staging、审查、enable/disable、refresh 测试 | 补压缩包和凭据扫描样本 |
| MCP stdio/HTTP | implemented | MCP 状态、审批、超时测试 | 保持 Core/Worker 隔离 |
| Feishu 消息与卡片 | partial | Fake Gateway、去重、cursor、回调测试 | 完成长连接重连和 CI 门禁 |
| Feishu 文档/Bitable/Drive | partial | Markdown、分页、Drive/Bitable 单测 | 补高层业务场景与可选沙箱测试 |
| `/test` 与评测趋势 | partial | Eval Runner Faux、报告持久化测试 | 补 CLI/Web 历史趋势和失败样本 |
| trace/diagnostics/stats | partial | operations/diagnostics API | 补性能快照、队列等待和恢复指标 |
| dream 维护 | implemented | 确定性 rollup/裁剪，不调用模型 | 不引入模型梦境生成 |
| 自动修改代码/自我优化 | excluded | Optimization Proposal 只有读写决策 | 禁止 apply/Git API |
| 新第三方渠道 | excluded | 当前仅 Feishu Adapter | 不实现 Slack、钉钉等渠道 |

## 使用规则

- 每个 `partial` 项必须先添加可复现测试，再决定实现方式。
- 评测只保存公开样本标识、结果、耗时和错误摘要，不保存隐藏思维链或凭据。
- 任何新增公共接口都必须同步更新 Protocol、Client、CLI/Web、Fake 样本和门禁；不写兼容层。
