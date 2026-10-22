# UmaAgent 可用性整改与验收

## 2026-10-22 Android 偶发闪退追加核查（候选修改，尚未发布）

- 用户追加要求将 Android 偶发闪退一并核查修复；沿用前序授权：充分验证后可进行服务端部署、发布必要 APK 并推送远端。
- 当前模拟器 crash-dropbox 中可读 native SIGSEGV 都属于第三方输入法（豆包输入法）进程，不能归因到 UmaAgent 或用户真机。UmaAgent 1.4.5 debug 另有一次启动期 ANR，系统摘要为“failed to complete startup”，RSS 约 218 MiB，并伴随内存、CPU、IO 压力；ANR trace 因系统权限不可读，实际用户闪退根因仍未证实。
- 已确认风险：启动期同步读取最多 16 MiB 离线缓存与快照解析可能造成主线程阻塞；WebView renderer 退出时没有降级路径；WebSocket open 回调同步读取 Android Keystore PAT。已分别改为 IO/Default dispatcher、捕获 renderer exit 后 Compose 纯文本降级、异步读取 WebSocket PAT。新回归使用真实 API 36 `WebViewRenderProcess.terminate()`，通过；启动缓存约 11 MiB 回归通过。
- 本轮实际验证：Android 相关 instrumentation 11/11；`npm run check:android`；`npm run check`；`npm test -- --run --reporter=dot` 60 文件/392 项；`npm run build`，均通过。之前的 UI 显示/历史滚动与 Browser Worker Chromium 安装候选同处当前脏工作树，尚未做最终候选构建、正式签名 APK、线上部署及公网验收。
- Claude 已完成一次只读 plan；本轮 review 请求结束时没有返回实际审查正文或结论，因此复核阶段未完成，后续由 GPT 对照源码和实测证据独立检查，不将工具响应记作 Claude 通过。
- 尚未完成：正式 Android 构建与签名连续性核验；按官方入口部署 Core/Browser Worker 及发布 APK；生产健康/浏览器检查与 APK 公网下载/签名验收；UmaAgent 与 MyServer 改动提交、远端推送。只在这些实际步骤完成后更新状态，不能将模拟器结果写成真机/长期生产验证。

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

## 2026-10-22 会话提问/正文显示与 Android 历史滚动修复（本地，未部署）

- 根因（代码路径核实）：快照只取最近 100 条消息，长执行的触发提问可能被裁掉而回复仍可见；空白最终助手消息可能被“执行假设”拼接后误作成功，且 Web/Android 可能优先显示过时助手消息而非已保存回复；Android 跟尾状态会因滚动状态/内容重排重新启用，异步高度校正将历史阅读者拉回底部。
- 修复：快照为可见回复补入其触发用户消息，但历史游标仍使用真实页边界；运行时拒绝空白最终回答、假设附加不再把空白当正文，Web/Android 以持久化回复为优先、实时助手消息作回退；Android 用户手势退出跟尾，异步尺寸校正只在仍位于底部时执行。
- 验证（当前工作树）：Vitest 59 个文件、389 项通过；`npm run check` 与 `npm run build` 通过；Android 单元测试和测试编译通过，API 36 模拟器上的历史阅读及延迟排版滚动回归通过；定向 Web Playwright 1/1 通过。完整 `ConversationLayoutTest` 有 4/5 通过，唯一未通过为既有键盘/IME 等待测试超时，非本轮滚动用例。
- 最终差异检查：换行格式保持原文件风格；`git -c core.whitespace=cr-at-eol diff --check` 通过，去除行尾换行差异后为预期的 11 个文件改动。
- Claude 只读复核未完成：已有 review 操作返回通用欢迎提示，无针对差异的审查结论；不标为 Claude 通过。GPT 根据源码与测试证据完成检查。
- 边界：未部署、未重启服务、未发布 Web/Android 产物、未提交或推送代码；改动仍在本地工作树。未进行线上回放或真实用户环境验收，因此生产效果待后续受控观察。
## 2026-10-22 发布跟进（服务端已授权、验证阶段）

- 用户已明确授权：充分测试后部署服务端，并发布必要应用产物。
- 当前正式生产前只读核查：Native release 仍为 `20261021142428-9506b92`，三项 systemd 服务 active，schema 27、Protocol 16，主机运行时 Node v22.23.2；本次核查期间在线活动 Run 从 1 降至 0，未因部署中断执行中的会话。Promote 所需受保护 PAT 为 root:root 0600，sudo 非交互可用，磁盘空间充足；未读取 PAT。
- 发布验证：Vitest 59 文件/389 项；覆盖率同样 59/389（Statements 82.48%、Branches 74.19%、Functions 77.46%、Lines 85.20%）；`npm run check`、全项目 `npm run build`、`npm run build:web:embed`、`npm run check:android` 通过；Android API 36 `ConversationLayoutTest` 5/5；Web 历史滚动 Playwright 1/1；Faux 评测 6/6；标准 20 条性能基线通过（API P95 6.04ms、事件 P95 1.65ms、RSS 峰值 112037888 bytes、WAL 峰值 2253704 bytes）。真实 Provider 请求未执行，避免重放与本 UI 修复无关的付费请求。
- 线上 Android 为 1.4.4/versionCode 18。复核后确认正式签名 properties、keystore、HTTPS origin 已本地配置；远端 APK 哈希与本地最新清单一致，现有发布证书 SHA-256 已读取用于签名连续性比对。Android versionCode/name 已 bump 为 19/1.4.5，正式构建、模拟器测试和签名对照待完成。
- Claude plan 工具请求完成但只返回无实际方案的通用状态提示；本阶段不记为 Claude 计划通过，GPT 按部署文档继续。

### 本轮追加验证（2026-10-22）

- 本地 `npm run check` 通过；Vitest 59 文件/389 项通过；覆盖率 82.48% statements、74.19% branches、77.46% functions、85.20% lines。
- `npm run check` 首次因版本合同文档仍引用 1.4.4 失败；已将当前状态元数据更新为 1.4.5 候选，并保留历史发布证据原样；随后检查通过。
- 线上正式 APK 下载后哈希与 `latest.json` 声明一致；其 signer SHA-256 已核验。待新正式 APK 与线上 signer 对照。
- 生产只读数据库活动 Run 现为 0；Native 依赖 `package-lock.json` 与本机版本完全同哈希。
- Android 1.4.5 正式 build/instrumentation、Core/Web 正式发布、APK 发布以及公网验收尚未完成。


## 2026-10-22 服务端/Web/Android 发布完成

- 源码变更提交并推送至 UmaAgent `master`：`086cc28c7121d7f2913d5d6d18e96a99d1eec5de`。发布 lock 已核对相同 commit 和嵌入资源 SHA。
- Core `20261022084152-086cc28` 与 RobotClaw embed `20261022084215-086cc28` 由官方发布入口部署；发布前备份 `/srv/backups/uma-agent/state-20261022084159.db`。
- Android 1.4.5/versionCode 19 已以与线上旧包相同的正式证书签名并发布，release `19-086cc28`；SHA-256 `ae3e8e3246dcecba14f928fafda0585e181f430d02c0752a429000186eedd182`，13,000,169 bytes。公网下载 hash/size、manifest、签名验证通过，API36模拟器安装和冷启动通过。
- 发布后服务 active、live/ready 200、数据库 integrity ok/schema27/FK 0/active Run 0；Web 公网 browser verify 390px/1280px通过。Android 全量 connected 测试一次运行失败9项（超时/性能和非目标路径）；相关 ConversationLayoutTest 在API36 5/5通过，未宣称全量仪器测试通过。
- 未执行真实 Provider 请求、实体设备与 TalkBack验收；继续观察真实流量效果。未做数据库迁移。

- 发布入口首轮因误传不存在的 `D:\AIhub\MyServer\ops\projects\robotclaw` 参数而在 `Resolve-Path` 本地校验失败（exit 1；未 SSH、未写生产）；改用实际仓库 `D:\AIhub\MyServer\projects\robotclaw` 后官方入口成功。
- UmaAgent 功能代码 commit `086cc28` 已推送远端。最终验收文档 commit（当前 `70bc08e`）推送遇 HTTPS 网络错误（reset / GitHub 443 connection timeout），故仍为本地 ahead 1；MyServer release-lock commit `69f4126` 也仅本地，push 遇网络 reset。生产发布已完成；网络恢复后才可同步这两项文档/运维记录。

## 2026-10-23 Android 闪退修复发布续行

- 发布前已核实模拟器证据：设备可读 native SIGSEGV 属于第三方豆包输入法；UmaAgent 1.4.5 曾有启动期 ANR，但系统 trace 不可读。用户真机闪退栈仍未获取，因此确切根因未确证；本次仅针对可重现/审查出的启动期主线程阻塞、Keystore 同步读取和 WebView renderer 退出风险做防护。
- 1.4.6/versionCode 20 APK 通过正式产物清单校验：SHA-256 `cc339eb6dffdcaaa36db30a517ad1ec1bddc7fce98121ab4fbf1c1549d8faf15`、13,000,169 bytes；正式签名证书 SHA-256 `86d57c047055e3923c753a0a7abc10e493894b94072798c3865e275e1ffc506d`。APK 尚未发布。
- 服务器备份完成：`/srv/backups/uma-agent/uma-agent-20261022154128.tar.gz`；候选 Native release `/opt/uma-agent/releases/20261022155213-99a0b09`。官方安装过程发现 Playwright CDN 大文件下载非常慢；按 Range 续传后验证大小 193,282,658 bytes、MD5 `d0396d5ed8a9977fc1d359c279734fc7`、ZIP 测试通过，Chromium 1234 已装到服务账号私有缓存。
- 首次 Promote 被启动门禁拦截并回滚：Chrome 目录权限未授予 Core 组；修订安装脚本让缓存以 `umaagent` 组可读/执行，并增加 Core 账号权限检查。第二次候选验证又发现 systemd 的 Core `ExecStartPre` 非 root 运行，不能嵌套 `runuser`；因此验证脚本现按运行身份分别检查 Core 可执行性并由 root 执行 Browser Worker 身份无头启动检查。
- 修正后的候选在服务器已通过 bash 语法、root 候选验证、模拟 systemd `umaagent` 身份预检；无头 Chromium 实际启动关闭成功。两次 Promote 均已自动回滚到 `/opt/uma-agent/releases/20261022084152-086cc28`，Core、Browser Worker、Xianyu Adapter 均 active，未改变数据库 schema 或业务数据。
- 尚未完成：最终修正提交/推送、锁文件更新、重跑受保护发布流程、生产 Core/Web 公网验收、Android 1.4.6 发布与公网下载签名/哈希验收。完成后追加实际 release ID、备份和验收数据。无真实真机 crash 日志，不能声称确切崩溃根因已证实或长期问题根治。

### 2026-10-23 发布完成

- 最终修正已提交本地 UmaAgent `bd6daa7c62a1b91ef887a44937b591f2634d3c69`：Playwright 缓存改为 Core/Browser Worker 共享组可读执行；验证脚本按 root、Core 服务账号和 Browser Worker 账号分别执行，不再嵌套非 root `runuser`。本地 `git diff --check`、远端候选 `bash -n`、root/Core 双身份验证及真实 Chromium 无头启动均通过。
- GitHub 推送：UmaAgent 与 MyServer 均曾因 GitHub 443 网络超时未完成；当前 UmaAgent 本地 master 含 `bd6daa7`，MyServer 本地 main 含 `331095b`，两者远端同步状态需网络恢复后补推。未跟踪的 `MyServer/task-artifacts/` 未提交。
- 受保护生产发布成功：备份 `/srv/backups/uma-agent/uma-agent-20261022174551.tar.gz`；Core release `20261022175440-bd6daa7`，Promote 后 `/opt/uma-agent/current` 已指向该版本；RobotClaw embed `20261022175510-bd6daa7` 已切换。首次两次候选切换因权限/验证脚本门禁自动回滚，未损坏数据，最终修正版才完成切换。
- 发布后验收：Core/Browser Worker/Xianyu Adapter active；Core live/ready 与 Browser Worker `/health` 通过；以 `umaagent-browser` 真实启动 Chromium 1234 成功；数据库只读 `integrity=ok`、schema 27、活动 Run 0；Web 公网 390/1280 挂载与公式字体检查通过。
- Android 1.4.6/versionCode 20 已发布，release `20-99a0b09`；公网清单、APK 下载哈希和大小均匹配：SHA-256 `cc339eb6dffdcaaa36db30a517ad1ec1bddc7fce98121ab4fbf1c1549d8faf15`、13,000,169 bytes；本地候选与公网 APK 签名证书 SHA-256 均为 `86d57c047055e3923c753a0a7abc10e493894b94072798c3865e275e1ffc506d`。
- 本轮最终本地/线上测试：`npm run check`、Vitest 60 文件/392 项、全工作区 `npm run build`、`npm run build:web:embed`、Web E2E 38/38、Android 相关 instrumentation 11/11 与 renderer terminate 专项 1/1；未执行真实 Provider 请求、实体 Android 真机和 TalkBack，用户真机闪退确切根因仍待真实崩溃栈。
