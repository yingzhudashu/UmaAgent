# UmaAgent 优化验收与正式发布

## 目标与授权

保留功能、效果和全部历史用户数据，优化性能、Trace、代码及中文文档。用户已授权充分测试后部署服务器、发布所需应用并提交推送；不加入migration、旧接口兼容层或供应商fallback。不得关闭其他模拟器；仅操作UmaAcceptance35/emulator-5564。本轮无真实渠道发送。

## 当前修复（2026-10-24 历史分页）

- 用户反馈：Web 历史回答碎片化、执行步骤外露；Android 无历史加载入口。
- 已定位：历史接口缺少 Response/Run 投影，Web 单独拼接消息；Android 没有历史分页 UI。
- 当前已补接口与两端统一投影、分支校验、分页游标和 Android 按钮/上滑加载。Web 390/1280 回归3项、数据库/Web单元49项、Android投影单元及编译已通过。
- Android专用API35模拟器HTTP三页分页1/1和原有滚动/输入布局6/6已通过；后端/Web418项通过1跳过，Web全套43/43与最终分页4/4通过。Claude max规划2e6ef1c5-bce6-4ec5-b436-c3d5f03024aa因API525失败，无方案正文；max复核bd23cdc9-67c5-4a4f-8e48-60999cd9223b运行中。
- 剩余：复核结果、Core/Web/Android 1.4.8(22) 发布、线上验证、四角色回滚验证并推送。补充证据沿用 artifacts/acceptance/usability-20261023/history-20261024，四角色不变。

## 已完成（2026-10-24）

- 原始基线d452fb2；合并远端5427d95及8109671，保留线上记忆恢复。部署源码dc081e4；Core /opt/uma-agent/releases/20261023230821-dc081e4；Web /srv/www/robotclaw/releases/20261023231807-dc081e4；Android1.4.7(21) release 21-cb1e3c9。
- 本地及Linux各63文件416通过1私有夹具跳过，覆盖率门槛通过；Web40/40，Faux6/6，Linux真实Provider一次成功且Trace6span。IPv6与跨平台问题修复；依赖公告高危已清零。
- 正式Android单元/Lint/签名通过，20→21覆盖升级保留数据，最低支持20。全流程36/38，Launcher系统ANR遮挡的两项清除故障弹窗后2/2补测通过；正文p95 132.1404ms、强停恢复通过。
- 最终固定性能原预算通过；保留13.23ms失败和停止专用模拟器后11.47ms复验记录。
- Core/Web/API/字体/公网APK均已验收，旧APK与旧release保留。全体历史对象和1374文件保留；备份在隔离目录恢复及本地加密往返校验通过，无生产恢复/迁移。
- Claude max规划533e3e34-bb93-4e8f-a51c-bb56ae22c2a2及复核ad405fe9-8dc2-46dc-a170-47b0cd9e5408均API525无正文。GPT独立复核，不冒充Claude通过。

## 交付证据与边界

主报告docs/release-acceptance.md；证据artifacts/acceptance/usability-20261023/release-20261024。沿用四角色和原BASELINE.tar，原始SHA256 973dd7ba0736fcc4617ff8e2358d81dc0feef576354ea96b980bc9a5968b9134。

Docker、实体Android/TalkBack、4小时及真机100ms未验；模拟器长时复用问题仍保留。无未批准后台任务或离线续跑承诺。最终文档提交与生产构建源码区分记录。

## 清理限制

自动审批拒绝删除两个已验证的本地明文备份副本；已将备份目录和文件ACL限制为当前账户，未入Git。加密备份已完成，生产发布与恢复验证不受影响；该清理动作未完成。
