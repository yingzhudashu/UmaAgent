# UmaAgent 架构与质量约束

当前 Core 1.3.0，Android 1.4.1（15），Protocol v16，HTTP `/api/v16`，业务 schema 27。接口与数据库只支持当前版本；schema 26 通过显式离线工具升级，服务启动不执行迁移。

## 职责与事实源

Core 是会话、运行、权限、队列、模型和工具的业务事实源。Server 负责认证、所有权检查和协议映射；CLI、Web、Android 和渠道通过当前协议访问 Core。客户端提供展示、输入、离线阅读和重连，不替服务端作授权决定。

UmaDatabase 持有连接、schema 校验和事务。SessionRepository 处理会话，MessageRepository 处理分支可见历史，ResponseRepository 批量投影回复、步骤和附件，ExecutionPolicyRepository 处理账号策略。SQL 语句按连接缓存，最多 128 条。历史分页在 SQL 中筛选，附件批量读取，避免全历史正文解析和 N+1 查询。

UmaRuntime 编排业务状态；资源操作由 RuntimeResourceService 收口，调度、审批、预检与恢复使用已有模块。运行状态只能按协议转换；取消必须向模型、工具与 Worker 传播。结果不明的副作用需显式恢复决策，不能因免审批而自动重放。

## 执行权限与数据隔离

账号 autoApprove 默认开启。普通工具、Shell、计划、后台任务、调度和渠道运行读取会话所有者的策略。开启时处理既有待许可操作；关闭只影响后续审批点。策略更新与审计在同一事务提交，业务澄清继续等待用户输入。账号角色、工作区边界、SSRF 和文件访问限制始终独立执行。

令牌每个新请求检查有效性、撤销与账号权限；同一 HTTP 请求内复用鉴权结果。展示用的最近使用时间按一分钟合并写入，避免轮询反复产生同步提交。

Session、Run、Attachment、Memory、Task 和 Trace 查询必须按所有权隔离。外部 traceparent 仅作关联，不是权限凭据。普通用户 Trace 分页前限制在所属 Run 子树；管理员可查询完整链路。

## 同步与客户端

持久事件推进连续游标，临时文本增量携带 offset，只更新正文。客户端按 offset 去重重叠内容，缺失持久事件按游标补拉；首次进入及重连校准快照。Core 快照叠加活动生成前缀，终态消息为权威正文；不得以旧快照覆盖终态。WebSocket 缓冲上限为 4 MiB，超出主动断开，按快照与游标恢复。

Android 保留 Compose 页面、输入、列表和导航；正文使用本地 WebViewAssetLoader 加载共享 marked、DOMPurify、KaTeX。脚本只来自打包资源，正文先清洗，认证凭据不进入 WebView。外链、附件和图片操作由宿主处理。Web 正文模块按需加载，宽表格、代码和公式仅在块内滚动。页面规格与按钮去向见 [Android 设计](android-design.zh-CN.md) 和 [前端设计](frontend-design.zh-CN.md)。

Android 流式状态按 4ms 窗口合并发布（上限预算 50ms），终态立即发布；缓存合并写入并有界保留。草稿与快照分开存储，账号切换清理本地身份数据；上传回执只能回写发起账号与会话。历史阅读不强制滚动，靠近末尾才跟随。

## Trace 与资源生命周期

Trace 与资源写入 UMA_TELEMETRY_DIR/telemetry.db，业务数据写入 state.db。HTTP、排队、Run、模型、工具、审批和 Worker 通过 W3C traceparent 关联。Span 使用单调时钟计时，成功、失败、取消和关闭都有终结路径。只保存脱敏属性与耗时，不保存 prompt、模型正文、凭据或原始工具参数。

SQLite 遥测写入由独立 Worker 批量提交。每进程每路径共享 Writer，使用引用计数关闭；队列上限 8192，批量 128 条或等待 25ms，逻辑事务不可拆分丢弃。查询前 flush 保证已提交写入可见；写入失败累计计数，不改变业务结果。退出、启动失败与无响应都有明确终结，不允许永久等待 flush。

## 工程门禁

架构检查禁止跨包深层导入、旧接口引用和无结构日志，并保留大文件只减不增约束。代码注释重点说明状态不变量、事务、并发、取消和释放原因；不为行数而压缩代码或增加无业务职责的抽象。优先使用已有维护中依赖。

固定预算见 [工程基线](engineering-baseline.md)。真实 Provider、模拟器、真机、Windows/Linux 与 Docker 结果分开记录。自动扫描与编译不能替代代码审查或设备验收；当前结果和未完成项统一记录在 [发布验收](release-acceptance.md)。
