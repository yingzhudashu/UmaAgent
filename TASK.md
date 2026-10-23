# UmaAgent 可用性审查与优化

## 目标与授权边界

保留功能、效果与历史用户数据，优化前后端性能、Trace、质量与文档，完成可靠验收。允许经证据评估后放宽验收范围；不增加migration、旧接口兼容层或供应商fallback。用户于2026-10-24明确授权：充分测试后部署服务器、发布所需应用，并提交推送所有本项目修改。允许必要服务重启和可恢复发布；不发送真实渠道消息，不使用历史用户会话测试。Claude只读规划/复核已授权。不得关闭其他模拟器；只操作任务AVD UmaAcceptance35 / emulator-5564。

## 当前已确认结果（2026-10-24）

- 原始HEAD d452fb23117205687e1d5d313abf6c8995ee2bb0，工作区未提交。此前Trace脱敏、事务内存上界、Web投影/分页、共享正文、文档Worker、Faux隔离、依赖审计与文档整改保留。
- 复用未受影响的62文件404项、Web40/40、Faux6/6、固定性能原预算和10分钟Core稳定性证据；未冒充本轮重新全跑。
- 原APK双栏37/37、离线恢复及40可见样本通过，正文p95 131.796778ms；结合前轮其他五组，六配置曾完整通过。最新管理页改动没有把旧APK全量结果冒充当前APK重跑。
- 长循环复现后台回执线程3057更新状态、数据已更新但旧加载条未消失。UmaManagement.kt的perform和初始LaunchedEffect显式Main.immediate，网络仍用IO，取消和账号边界保持。调试阶段日志不写正文/凭据。
- 最终双栏和手机两倍字号各160次切换通过，日期、用量、加载结束及回执主线程均核对；每组161次诊断HTTP200，退出无额外请求。性能与PSS原始窗口见quality-final-summary.json。未强制GC，不能外推四小时。
- Profile草稿、资源失败表单和两倍字号CoreFlow各1/1通过。原10秒等待、250ms正文p95、700ms冻结帧、500ms构造及40正文样本不变。新增失败即刻取证，清单下限38。
- 模拟器长时复用仍失败：关闭Vulkan没有解决qemu增长；请求swangle实际仍报告SwiftShader GLES。接受按配置冷启动的本地门禁，长时复用仍未通过，不归因为应用泄漏。
- 本地限定验收通过；完整发布验收缺真实Provider、实体Android/TalkBack、Linux/Docker、四小时稳定性与真机100ms证据。没有生产写入、发布或后台续跑承诺。

## 证据、复核与后续边界

- 结论：docs/release-acceptance.md；架构/文档审查：docs/code-review.md；Android合同：docs/android-design.zh-CN.md。
- 新增主索引：artifacts/acceptance/usability-20261023/continuation/quality-final-summary.json；原始失败和资源对照仍在同目录，已扩展optimization-evidence-index.json。
- 本轮Claude max规划两次和最终复核一次均返回API525，未取得可读正文或可核验的返回模型；本地限定范围由GPT独立复核，Claude阶段未完成。方案、实施和证据整理均为GPT。
- 四角色仍为artifacts/acceptance/usability-20261023/MODIFIED_FILE.tar、DIFF_FILE.patch、VERIFICATION.txt、ROLLBACK.sh。BASELINE.tar原始SHA256 973dd7ba0736fcc4617ff8e2358d81dc0feef576354ea96b980bc9a5968b9134不变；finalize.mjs重新验证源码补丁、独立副本回滚、行为及正文回执。
- 本轮继续发布验收：真实Provider使用隔离测试上下文，设备/平台未覆盖项必须如实记录。不得把本地通过写成已上线，也不重复已通过且未受影响的检查。

## 发布进行中（2026-10-24）

- 新增明确授权：充分测试后生产部署、发布Android、提交与推送。
- 当前服务器schema27/protocol16，3服务active、活跃Run为0；已取回1.4.6(20)正式APK，签名SHA256为86d57c047055e3923c753a0a7abc10e493894b94072798c3865e275e1ffc506d。
- Android候选1.4.7(21)，最低支持保留20；无迁移、无历史数据清理。
- 本轮覆盖率、构建、Web40/40、Faux6/6及固定性能预算通过。新公告发现body-parser和zod高危，已升级锁定依赖，官方审计0漏洞，正在复验。
- 本轮Claude max规划operation 533e3e34-bb93-4e8f-a51c-bb56ae22c2a2返回API525，无正文；GPT继续。
- GitHub HTTPS两次连接重置，正在检查可用既有连接；不更换远端、不关闭TLS校验。
