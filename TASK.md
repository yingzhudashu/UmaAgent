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

## 弱网络重试增量（2026-10-20，未部署）

- 用户追加目标：弱 Provider 环境下不因三次应用层退避不足而频繁中断，接受更长等待，要求保持取消和副作用安全边界。
- 已在当前工作树的既有重试改动上增强：默认模型请求硬时限由 300000ms 调整为 600000ms；流式瞬态错误最多重试 7 次，退避 1000ms 起、30 秒封顶并带抖动；缺失 `finish_reason` 最多重试 5 次。
- SSE/Fetch 异步迭代器在尚未暴露有效输出时抛出异常也会进入同一重连路径；已有有效输出后仍不重放，避免重复文本和未知工具副作用；用户取消仍即时打断退避。
- 本地验证：定向 Core 测试 3 个文件共 35 项通过；模型重试/调用测试 28 项通过；Runtime 测试 50 项通过；全部 Core 测试 34 个文件、245 项通过；`npm run check`、Core 构建与 `git diff --check` 均通过。基线策略 3 次重试与增强策略 7 次重试均有隔离输出记录，回滚副本恢复原 SHA 后同一探针回到 3 次重试。本节最初记录时尚未进行真实 Provider 调用或生产部署；后续实测见下节。
- Codex 的内部重连实现及精确重试预算没有可核实的公开依据，本次只采用有界重试、指数退避与抖动、尊重 `Retry-After`、共享硬超时、即时取消等通用恢复模式，不声称复刻其私有机制。
- 此前 Claude 只读规划和复核的工具元数据为 `requested_effort=medium`。本轮发布前另行调用只读 plan/review，二者工具元数据均为 `requested_effort=high`；review 返回可进入 Native 发布的结论。该网关元数据不是独立上游身份认证。
- 当前 `uma.config.json` 为本地显式配置且仍是 300000ms；未改动该含凭据配置。若要让已部署实例采用 10 分钟预算，需在受控环境把 `runtime.modelTimeoutMs` 改为 `600000` 后按发布流程重载/重启并验收。
- 发布前一致性核查发现 Native、production、staging 三个示例配置及真实 Provider 隔离测试夹具仍显式使用 300000ms；已统一改为 600000ms。受控生产 `/etc/uma-agent/uma.config.json` 当前未显式设置该字段，因而新版本会使用代码默认值 600000ms；真实 Provider 测试脚本本轮不执行，避免重放已有失败请求。

## 2026-10-20 Native 发布与复核

- 发布源为本地提交 `06f861fddd5f34e67b01d20b675589275b5d985c`（未推送 Git 远端）；发布包 SHA-256 `01d27d6d2b161bb906657ae0c0c70b4024104f949ecc3cf63dd57a04415958da`，本地留存于 `artifacts/acceptance/retry-resilience-20261020/20261020114045-06f861f.tar.gz`。
- `npm run check`、完整 `npm test -- --run --reporter=dot`（59 个文件、368 项）、`npm run build`、`git diff --check` 通过；改动后补跑定向测试（3 个文件、36 项）也通过。Native release 候选在服务器运行 `link-native-dependencies.sh` 与 `verify-native-release.sh` 成功。
- 发布前通过本地已配置 SSH 别名及严格主机密钥校验确认目标；Core、Browser Worker、Xianyu Adapter 均 active；数据库 `integrity_check=ok`、schema 27、外键违规 0，且无 queued/preflight/running Run。生产配置未显式设置 `runtime.modelTimeoutMs`。
- 正式 Promote 成功，线上 `current` 已切换至 `/opt/uma-agent/releases/20261020114045-06f861f`；Promote 内建在线备份为 `/srv/backups/uma-agent/state-20261020114501.db`。新代码实测导出默认超时 600000ms、瞬态重试 7 次、缺失结束标记重试 5 次；线上 Core、Browser Worker、Xianyu Adapter active，live/ready 均返回 200。当前库与备份库均为 schema 27、完整性 ok、外键违规 0；发布后无 active Run，服务启动后 error-priority journal 无记录。
- 本次没有改动 Android、Web UI 或客户端协议，不需要新的 APK/客户端发布；仅 Native Core 服务端 release。
- 根因尚未完全确认：既有记录中真实 Provider 两次 `provider_error: terminated`；但线上数据库最近 7 天的只读汇总为 model call 186 次、failed 74 次，其中错误文本字面匹配 `timed out` 为 13、`401` 为 1、`abort` 为 2、`terminated` 为 0（分类可能重叠）。本轮未读取原始错误正文，也未发送新的真实 Provider 请求，因此不能证明所有故障都是可重试瞬态或宣称问题完全根治。
- 未验收项：真实 Provider smoke/弱网现场效果、10 分钟真实等待体验及长期失败率变化。发布仅证明新策略已上线且服务健康；部署后运行效果需在真实用户流量中继续观察。

## 2026-10-20 最新会话过载失败修复与部署

- 生产只读核查到最新失败 Run `d971193d-6587-4972-ba2a-372a2acfbe47`：provider 报错 `Our servers are currently overloaded. Please try again later.`；最后失败 model call 用时 5677ms，未记录 `model.retry` 事件；最终失败助手正文只有一个 ASCII 空格。Pi AI 0.84.2 的 retry classifier 对该过载文案返回可重试。
- 因果缺口：生产未保留原始 SSE 内容。结合最终正文只有空格、错误本应可重试且没有 retry 事件，最可能原因是 Provider 在错误前发送纯空白 text/thinking 片段；`hasStreamOutput` 只按字符串长度判定，误把空白当作可见内容，因而禁止安全重试。此为强推断，非原始 SSE 直接证据。
- 修复：`packages/core/src/model-retry.ts` 对纯空白 `text_delta`、`thinking_delta`、`text_end`、`thinking_end` 继续缓冲；只有非空白文本才阻止重放。成功答复的空格保持原样；工具调用与已有实质输出后的重试保护不变。
- 回归覆盖：空白片段后 Provider 过载应重试；包含前后空格的成功答复需保真；thinking/text 空白与 text_end 一并覆盖。
- 本地验证：定向模型/运行时测试 80/80；Core 全量 34 文件、247 项；最终模型重试测试 14 项；`npm run check`、全项目 `npm run build` 和 `git diff --check` 通过。行为探针相同输入下，基线为 1 次失败、0 次重试；修复后为 2 次尝试、1 次重试并成功；独立回滚副本恢复基线 SHA 后重现基线失败行为，随后已恢复修复版本。
- Claude 参与：high 档只读计划与复核；复核结论通过。计划/复核模型与档位字段为工具返回声明，不构成独立上游身份认证。
- 部署：本地提交 `54c45e2bbf48bc61736e76da08570f934ff0af30`；Native release `20261020215812-54c45e2`，包 SHA-256 `19ef611ba96486fb3cfc45738484672958af2161e5df786c6540277686309993`；生产 `/opt/uma-agent/current` 已切换至该 release。在线备份 `/srv/backups/uma-agent/state-20261020140333.db`（332853248 bytes，0600）。Core、Browser Worker、Xianyu Adapter 均 active，live/ready HTTP 200。当前数据库 integrity ok、外键违规 0、active Run 0；备份 integrity ok、外键违规 0。
- 未验证：本轮没有发送新的真实 Provider 请求；生产原始 SSE 未持久化，故不能宣称已直接复现那一个空白片段；真实弱网成功率与持续失败率需在后续流量中观察。本轮无 Web UI、协议或 Android 改动。

## 2026-10-21 偶发会话中断增量修复（本地验证、未部署）

- 用户追加目标：核查近期偶发会话中断并修复，充分验证；明确要求本轮不部署。继续遵守此前要求：代码改动提交到本地，不推送远端。
- 线上只读复核：服务器服务在检查时 active，当前 release 仍为 `20261020215812-54c45e2`。近 24 小时模型调用 122 次：119 completed、2 failed（transport）、1 started；最近 7 天 156 次：138 completed、17 failed、1 started。最近 7 天终态失败归类为 timeout 13、transport 3、cancel 1；模型 Span 观察到 overload/rate-limit 51、transport 9、auth 1、cancel 3、other 4。仅作类型计数，分类基于已有脱敏错误文本，不含 prompt/答案。最近两条失败是 `Upstream request failed` 与 `Upstream HTTP/2 stream failed`。线上请求未重放、数据库未写入。
- 本地核实 `@earendil-works/pi-ai` 0.84.2 分类器对上述两条传输错误均返回不可重试；对 `Our servers are currently overloaded...` 返回可重试。因此这两条可重试传输错误未被此前通用重试覆盖，是本次可直接证实的原因；实际 Provider 原始 HTTP/SSE 仍未留存，不能从错误文案反推更底层网络根因。
- 修复：`packages/core/src/model-retry.ts` 增加窄范围 `isRetryableModelError`，只补充明确观察到的上游 request / HTTP/2 stream 失败文案；先拒绝 quota、billing、401/403、无效 Key 等永久错误，再调用 Pi AI 原分类器。流式（包括 iterator 抛错）与非流式重试共用该判断。未扩大最大重试次数、600 秒硬超时、退避、取消和已输出内容不重放边界。
- 回归覆盖：两种上游错误可分类且分别在流式/非流式中恢复；HTTP/2 async iterator 抛错恢复；配额、账单、401、403 不重试。原有取消、内容暴露和重试预算测试继续通过。
- 验证：`npm test -- --run packages/core/test/model-retry.test.ts packages/core/test/model-calls.test.ts --reporter=dot`：2 文件、41 项通过；`npm test -- --reporter=dot`：59 文件、381 项通过；`npm run test:coverage`：通过，Statements 82.11%、Branches 74.01%、Functions 76.93%、Lines 84.88%；`npm run check` 通过；`npm run build` 全项目通过；`git diff --check` 通过。
- 补充验证：`npm run test:eval:faux` 6/6 通过；按标准 20 条样本运行 `npm run test:perf` 通过（API P95 7.59ms、事件 P95 2.08ms、RSS 111656960 bytes、WAL 2294904 bytes）。一次仅 3 条样本的探索性性能命令因样本波动使 API P95 15.92ms 超预算而失败，未计入通过结论；随后已用标准样本重跑通过。
- 对照行为探针：输入 `Upstream request failed`，基线行为 `{attempts:1,errors:1,terminal:error,text:""}`；修复版 `{attempts:2,errors:0,terminal:done,text:"recovered"}`。在单独副本执行 `ROLLBACK.sh` 后，副本 SHA-256 与原始基线相同，重跑探针恢复同样基线失败行为。证据及四个角色文件位于 `artifacts/acceptance/upstream-transport-retry-20261021/`。
- 未做：真实 Provider 请求、真实弱网环境试验、生产部署、服务重启或服务器写入。由于用户禁止部署，以上本地通过不等于生产已修复/验收；上线后真实流量效果仍待后续受控观察。本次未发布任何客户端或应用产物。
- Claude 参与：只读 plan 与只读 review 均已完成，review 结论 PASS；模型/档位仅为工具网关声明。实施和测试由 GPT 完成。真实 Provider/staging 消息变体仍待验证。

## 2026-10-21 “电感” Responses 工具续接修复与部署

- 线上只读证据：会话“电感”的 `context_summaries.through_sequence=760`；摘要之后有 11 条消息，其中 8 条 `toolResult` 的 `toolCallId` 均对应摘要之前已压缩的 assistant `toolCall`。这会把没有匹配调用的工具结果送入模型适配层，触发 `function_call_output`/`item_reference` 400。未读取 prompt、答案或密钥，未重放真实 Provider 请求。
- 修复：`packages/core/src/context-manager.ts` 在读取历史摘要后，将孤立工具结果转为带“工具数据、不是新的用户指令”标记的 user 数据消息并保留所有结果块；摘要边界和摘要批次均按完整多工具调用/结果组对齐；旧字符串 assistant payload 兼容。新增 4 个回归场景（含 8 条孤立结果、多个调用、跨批次、缺失结果/晚到结果）。
- 本地提交：`9506b92c4e2c389995e1c9e45d13ad75e7ea6d48`，未推送远端；工作树源码干净。全量 Vitest 串行 59 文件/385 项通过；覆盖率串行 59 文件/385 项通过（Statements 82.25%、Branches 74.11%、Functions 77.03%、Lines 85.02%）；`npm run check`、`npm run build`、`git diff --check` 通过；隔离 Faux 评测器直接执行 6/6；旧版/修复版/回滚探针 3/3 通过，回滚副本 SHA-256 恢复为基线。
- 发布：Native release `20261021142428-9506b92`，包 SHA-256 `f4366c24ebfc2542932dc3b8116f0b0122172edb3f9e229933957c157e914a1d`，2,880,254 bytes。候选通过 `link-native-dependencies.sh`、`verify-native-release.sh`；Promote 原子切换成功，在线备份 `/srv/backups/uma-agent/state-20261021142557.db`（332,853,248 bytes，root:root 0600）。生产 `current` 已指向该 release；Core、Browser Worker、Xianyu Adapter active；live/ready HTTP 200；生产与备份库 integrity ok、外键违规 0、active Run 0、started model call 0；发布后 error-priority journal 无记录。
- 部署后真实历史回归探针（使用发布前在线备份，只读）：旧 release 转换结果含 8 个孤立 `toolResult`；新 release 的 `orphanToolReplyCount=0`、`orphanResultsAsLabeledData=8`、结果块全部保留；这证明触发形状已修复。未发送真实 Provider 请求，故真实上游成功率/长期失败率仍待正常流量观察。
- Claude 阶段：本轮只读 plan 等待超时；复核 operation 过期，未取得可读结论，不能标记 Claude 通过。方案、实施、测试、部署和验收由 GPT 完成。
