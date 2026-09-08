# UmaAgent Android 1.2.0

## 当前工作区体验

- 咸鱼总控提供“切换普通账号”，只清理本机管理员会话，不停止后台 Adapter 或删除咸鱼 Cookie。
- Material 3 App Shell 使用系统 Insets，顶部内容不会遮挡通知栏，窄屏使用底部导航，宽屏使用 Navigation Rail。

## 当前版本：versionCode 7

- 管理员 PAT 登录后自动进入咸鱼工作台，普通账号继续进入 UmaAgent。
- 咸鱼总控和买家会话随服务端同步，支持扫码登录、自动回复开关和草稿发送。
- 自动回复关闭时回复只保存为草稿，管理员确认后才会发送给买家。
- Android 13+ 在管理员进入咸鱼工作台后请求新消息通知权限。
- 管理员使用 Core PAT，普通用户使用独立 PAT，客户端只保存当前令牌。

该版本必须使用现有生产签名 keystore 构建。Debug APK 仅用于本地验证，不能放入生产下载清单。

## 本地验收

JVM 测试覆盖 JSON 请求体、协议、更新与取消传播；ShellLayoutTest 使用设备真实 Insets 验证深浅色布局和账号清理。实际执行结果以 [发布验收](../docs/release-acceptance.md) 为准。
