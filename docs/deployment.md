# UmaAgent 服务器部署与验收


## 1. 部署前确认

推荐起点：Linux x86_64、2 核 CPU、4 GiB 内存和 20 GiB 可用磁盘；启用 Chromium Browser Worker 时建议 4 核、8 GiB。需要 Docker Engine 24+、Compose v2、Git，以及可访问模型 Provider 的出站 HTTPS。Node 原生部署要求 Node.js 22.19.0 或更新的 22.x。


部署前运行：

```bash
git status --short
cp .env.example .env
cp deploy/uma.config.production.example.json deploy/uma.config.production.json
mkdir -p workspace backups
chmod 600 .env
```

编辑 `.env`，至少设置三个互不相同的高熵值：

```bash
openssl rand -hex 32 # BROWSER_WORKER_TOKEN
```

同时设置模型密钥。不要把 `.env`、生产配置、数据库、日志或备份提交到 Git；这些路径已由 `.gitignore` 和 `.dockerignore` 排除。

## 2. 生产配置

编辑 `deploy/uma.config.production.json`：

- 将 `server.webOrigins` 改为 Web 实际使用的精确 Origin，例如 `https://agent.example.com`。不接受通配符、路径或结尾 `/`。
- 核对 Provider `baseUrl`、模型 ID、API 类型、上下文窗口、输出上限和 capabilities。示例值不是对任意 Provider 的兼容承诺。
- 若启用语义知识检索，设置 `EMBEDDING_API_KEY`，并在配置中保持 `embedding.enabled=true`；默认使用 SiliconFlow `BAAI/bge-m3`。未配置 Embedding 时仅使用显式配置的关键词检索，不会隐式切换运行模式。
- 密钥只通过 `apiKeyEnv` 和 `authTokenEnv` 引用环境变量，不能写进 JSON。
- 多用户 Web/移动端认证使用用户个人令牌；个人令牌只保存哈希，Web Cookie 绑定用户。原生 App 的 PKCE redirect 必须通过 `UMA_OAUTH_REDIRECTS` 显式配置为 `clientId|redirectUri`，禁止通配符。
- `workspaceRoots` 保持为容器内路径 `/data/workspace`。远程客户端路径不是服务器工作区路径。
- 只在对应服务确实启动时加入 MCP；readiness 会要求配置中的所有 MCP 已连接。

配置是严格 JSON，未知字段会使 Core 拒绝启动。非回环 HTTP MCP 必须设置 `authTokenEnv`。

## 3. 启动 Core

先验证 Compose 展开结果。此命令会检查缺失的必填环境变量，但不会显示 `.env` 之外未引用的密钥：

```bash
docker compose \
  -f docker-compose.yml \
  -f deploy/docker-compose.production.yml \
  config --quiet
```

启动默认的 Core 和 Browser Worker：

```bash
docker compose \
  -f docker-compose.yml \
  -f deploy/docker-compose.production.yml \
  up -d --build

docker compose \
  -f docker-compose.yml \
  -f deploy/docker-compose.production.yml \
  ps
```

默认卷和挂载：

| 内容 | 容器路径 | 默认存储 |
| --- | --- | --- |
| Core SQLite、WAL、上传、技能 | `/data/state` | `umaagent_uma-state` 命名卷 |
| 服务器工作区 | `/data/workspace` | `./workspace` bind mount |

卷名前缀由 `COMPOSE_PROJECT_NAME` 决定。不要让第二个 Core 挂载同一 `uma-state` 卷；SQLite WAL 是单进程、单副本设计。

### Native Node/systemd 部署

生产发布使用专用系统用户和 Native systemd；state、workspace、配置和环境文件必须放在不同目录。Docker Compose 仅用于本地/CI 隔离验证：

本仓库为 RobotClaw 服务器提供可直接安装的原生模板：

- `deploy/uma.config.native.example.json`
- `deploy/uma-agent.service`
- `deploy/backup-native.sh`
- `deploy/verify-native-backup.sh`
- `deploy/link-native-dependencies.sh`
- `deploy/verify-native-release.sh`

模板固定 Core 为 `127.0.0.1:3210`，只允许 `robotclaw.site` 两个 HTTPS Origin，且首期不注册任何 MCP。部署前必须核对固定 Node 路径和 Provider 合同。

```bash
sudo useradd --system --home /var/lib/uma-agent --shell /usr/sbin/nologin umaagent
sudo install -d -o umaagent -g umaagent /var/lib/uma-agent/state /srv/uma-workspace
sudo install -d -o umaagent -g umaagent -m 0770 /var/lib/uma-agent/telemetry
sudo install -d -m 0750 /etc/uma-agent
sudo cp deploy/uma.config.production.json /etc/uma-agent/uma.config.json
sudo cp deploy/uma.env.native.example /etc/uma-agent/uma.env
sudo chmod 0600 /etc/uma-agent/uma.env

npm ci --ignore-scripts
npm run build
```

For an immutable release layout, do not symlink the whole release `node_modules`
directory to an older release. That makes `@uma-agent/*` resolve to stale Core
code. Link third-party dependencies from a shared directory, then link each
`@uma-agent/*` package to the matching `packages/` or `apps/` directory in the
same release with `deploy/link-native-dependencies.sh`.

Install `deploy/verify-native-release.sh` as
`/usr/local/libexec/uma-agent-verify-release` and keep shared third-party
dependencies at `/opt/uma-agent/dependencies/node_modules`. The systemd unit
runs this verifier before Node starts. It rejects releases whose `@uma-agent/*`
packages resolve outside the active release, so stale Core code cannot silently
start.

把配置中的 `stateDir` 改为 `/var/lib/uma-agent/state`、`workspaceRoots` 改为 `/srv/uma-workspace`，并按服务器的真实路径调整 `skillsDirs`。若原生启动 Browser Worker，把 MCP URL 改为 `http://127.0.0.1:3230/mcp`；若暂不部署则从 `mcpServers` 删除该项，否则 readiness 会保持 503。创建 `/etc/systemd/system/uma-agent.service`：

```ini
[Unit]
Description=UmaAgent Core Server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=umaagent
Group=umaagent
WorkingDirectory=/opt/uma-agent/current
Environment=NODE_ENV=production
EnvironmentFile=/etc/uma-agent/uma.env
ExecStart=/opt/node-v22.23.2-linux-x64/bin/node /opt/uma-agent/current/apps/server/dist/main.js --config=/etc/uma-agent/uma.config.json
Restart=on-failure
RestartSec=5
TimeoutStopSec=30
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/uma-agent/state /var/lib/uma-agent/telemetry /srv/uma-workspace

[Install]
WantedBy=multi-user.target
```

确认 `node` 和仓库实际位于示例路径后再启用：

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now uma-agent
sudo systemctl status uma-agent
journalctl -u uma-agent -n 200 --no-pager
```


## 4. 健康检查与首轮验收

Liveness 只表示进程事件循环可响应；readiness 还检查数据库、工作区、模型目录和 MCP：

```bash
curl --fail http://127.0.0.1:3210/api/v15/health/live
curl --fail http://127.0.0.1:3210/api/v15/health/ready
curl --fail \
  -H "Authorization: Bearer ${UMA_TOKEN}" \
  http://127.0.0.1:3210/api/v15/sessions
```

再从另一台设备验证 SDK/CLI，而不是只在服务器本机测试：

```bash
export UMA_SERVER_URL=https://agent.example.com
export UMA_TOKEN='当前用户个人访问令牌'
npm run cli -- doctor
npm run cli -- chat
```

`ready` 成功并不代表模型推理一定成功；必须发送一条实际消息，确认模型流式输出、工具审批和终态事件都可用。随后在 Web 中创建一个 Session，重启 Core，确认 Session 和历史仍存在：

```bash
docker compose -f docker-compose.yml -f deploy/docker-compose.production.yml restart uma
```

验证状态目录锁时保持主 Core 运行，再执行下面的临时实例；它应以非零状态退出，并报告状态目录已被占用：

```bash
docker compose \
  -f docker-compose.yml \
  -f deploy/docker-compose.production.yml \
  run --rm --no-deps uma
```

## 5. TLS 与反向代理

Core 生产容器仍绑定宿主机 `127.0.0.1:3210`，由同机 Caddy/Nginx 终止 TLS。不要直接把 Core 改成宿主机公网端口。样例位于：

- `deploy/Caddyfile.example`
- `deploy/nginx.conf.example`

Caddy 和 Nginx 样例都支持 WebSocket。证书域名必须和 `server.webOrigins` 一致。若 Web 独立部署到另一个域名，则将 Web 的 Origin 加入列表，并在构建 Web 时设置 `VITE_UMA_CORE_URL`。跨站 Web Cookie 只应运行在 HTTPS 下。

## 6. Android APK 发布

Android APK 与 Core Server 是两个独立发布面。Core 的 systemd 发布不会更新 APK；APK 由 Nginx 从 `/srv/www/robotclaw/app` 提供：

- `/srv/www/robotclaw/app/current`：当前线上 APK 发布目录的原子切换链接。
- `/srv/www/robotclaw/app/releases/<versionCode>-<commit>/`：不可变 APK 与 `latest.json` 目录。
- `/srv/www/robotclaw/app/releases.json`：历史发布清单。
- `/app/latest.json` 与 `/app/releases/<releaseId>/UmaAgent-<versionName>.apk`：公网地址。

### 6.1 发布前置条件

1. `versionCode` 必须大于当前线上清单，不能复用旧版本号；`versionName` 应同步递增。
2. 正式构建必须复用线上 APK 的签名证书。签名 keystore、store password、key alias 和 key password 只能从受控密钥存储注入，不得提交 Git、写入日志或放入 APK 发布目录。Gradle 支持以下属性或等价环境变量：`umaStoreFile` / `UMA_ANDROID_KEYSTORE`、`umaStorePassword` / `UMA_ANDROID_KEYSTORE_PASSWORD`、`umaKeyAlias` / `UMA_ANDROID_KEY_ALIAS`、`umaKeyPassword` / `UMA_ANDROID_KEY_PASSWORD`。
3. 若原正式 keystore 不可用，停止发布。使用 Debug 签名或新生成的签名会阻止已安装用户覆盖升级。

### 6.2 构建与校验

在仓库 `android/` 目录执行，正式 keystore 参数通过未跟踪的 `gradle.properties` 或环境变量注入：

```powershell
.\gradlew.bat :app:testDebugUnitTest :app:assembleRelease --no-daemon
$signer = "$env:LOCALAPPDATA\Android\Sdk\build-tools\35.0.0\apksigner.bat"
& $signer verify --verbose --print-certs .\app\build\outputs\apk\release\app-release.apk
Get-FileHash .\app\build\outputs\apk\release\app-release.apk -Algorithm SHA256
```

发布前必须将新 APK 的证书指纹与当前线上 APK 的证书指纹进行比较；指纹不一致时不得继续。随后生成 `latest.json`，其中 `apk.url` 必须严格匹配 `/app/releases/<releaseId>/UmaAgent-<versionName>.apk`，并填写实际 `sha256`、`sizeBytes`、ISO-8601 `publishedAt` 和发布说明。客户端会拒绝包名、版本、路径、大小、哈希或发布时间不合法的清单。

### 6.3 上传与原子切换

先将 APK 和清单上传到新的不可变目录，再由有权限的发布操作员执行原子切换。禁止直接覆盖 `current` 中的 APK 或在线编辑当前 `latest.json`：

```bash
release_id=<versionCode>-<commit>
release_dir=/srv/www/robotclaw/app/releases/$release_id
install -d -o root -g root -m 0755 "$release_dir"
install -o root -g root -m 0644 UmaAgent-<versionName>.apk "$release_dir/UmaAgent-<versionName>.apk"
install -o root -g root -m 0644 latest.json "$release_dir/latest.json"
ln -sfn "$release_dir" /srv/www/robotclaw/app/current.next
mv -Tf /srv/www/robotclaw/app/current.next /srv/www/robotclaw/app/current
```

`releases.json` 也必须先写入同目录临时文件、校验 JSON 后再通过同文件系统 `mv` 替换。切换后验证：

```bash
curl --fail https://robotclaw.site/app/latest.json
curl --fail --output /tmp/UmaAgent.apk https://robotclaw.site/app/releases/<releaseId>/UmaAgent-<versionName>.apk
sha256sum /tmp/UmaAgent.apk
```

确认公网清单中的版本、大小和 SHA-256 与构建产物一致，再在真实 Android 设备上执行更新、登录、进程重启和重新登录验证。发布失败时只切回 `current` 旧链接，不删除旧版本目录。

## 7. 可选服务

### Xianyu Adapter

闲鱼 Adapter 只监听回环地址，Core 通过内部控制令牌代理访问。配置 `UMA_XIANYU_CONTROL_TOKEN` 和 `/etc/uma-agent/config.user.json` 后启动。用户侧只使用 Core 管理员 PAT；不再配置咸鱼管理员密码或 Grant。`xianyu.cookie` 首次可以为空，Adapter 会以 `pending_login` 状态启动，不会伪造或复用旧 Cookie：

```json
{
  "version": 1,
  "core": { "serverUrl": "http://127.0.0.1:3210", "token": "<core-token>" },
  "xianyu": {
    "cookie": "",
    "host": "127.0.0.1",
    "port": 3250,
    "stateDir": "/var/lib/uma-agent/channels/xianyu"
  }
}
```

管理员使用 Core PAT 登录后自动进入咸鱼工作台，在总控会话生成二维码并扫码；登录状态由 Core 代理到 Adapter，客户端不直连 `3250`。扫码成功后 Cookie 原子写入 `stateDir/cookie`，权限为 `0600`，Adapter 自动恢复闲鱼连接。登录过期会停止 Adapter，状态变为 `expired`，并在设置以下三项时通过知识库飞书应用发送告警：`UMA_XIANYU_FEISHU_APP_ID`、`UMA_XIANYU_FEISHU_APP_SECRET`、`UMA_XIANYU_FEISHU_CHAT_ID`。这些值只能写入 `/etc/uma-agent/uma.env`，文件权限保持 `root:root 0600`；未配置时服务仍可运行，但必须在验收记录中标明告警未启用。

启用前先执行候选验证和备份，再启动：

```bash
sudo systemctl enable --now uma-xianyu-adapter.service
curl --fail \
  -H "Authorization: Bearer ${UMA_XIANYU_CONTROL_TOKEN}" \
  http://127.0.0.1:3250/health
```

验收至少覆盖二维码生成、轮询、扫码成功后的 Cookie 权限、Core-proxied 状态和过期停用。登录失败或二维码过期只能重新生成二维码；不得把不可用 Cookie、失败 release 或历史 APK 加入公网下载清单。发布失败时按原子 release 指针回滚，保留 Core、Browser Worker 和 Adapter 的服务状态证据。

Adapter 的 `/start`、`/stop`、`/pause`、`/resume`、`/conversations`、`/history`、`/item`、`/chat` 和 `/publish` 只接受内部控制令牌；客户端不得直连 Adapter。


Browser Worker 容器根文件系统只读、capabilities 全部移除；它不挂载 Core state/workspace。不要自动执行第三方 `npm install`。

## 8. 防火墙与安全检查

- 入站只允许 SSH 管理端口及 80/443；3210、3230、3250 不对公网开放。
- `.env` 权限设为 `0600`；日志、工单和截图中不得出现 Authorization、Cookie、API Key 或 Secret。
- Browser Worker 必须保留 Bearer Token；它阻止私网、保留地址和非 HTTP(S) 导航，但仍应部署在受限网络。
- Xianyu Adapter 不挂载 `/data/state` 或 `/data/workspace`。
- 定期检查 `docker compose logs`、磁盘、`state.db-wal` 大小和容器重启次数。
- 配置中的 Provider URL 和 MCP URL 必须是受信地址；不要在 URL 中放用户名、密码或 Token。

## 9. 停机备份与恢复

SQLite 使用 WAL。可靠备份必须先停止写入；不要只复制正在运行的 `state.db`。

```bash
mkdir -p backups

docker run --rm \
  -v umaagent_uma-state:/source:ro \
  -v "$PWD/backups:/backup" \
  alpine sh -c 'cd /source && tar czf /backup/uma-state.tgz .'

docker run --rm \
  -v umaagent_uma-telemetry:/source:ro \
  -v "$PWD/backups:/backup" \
  alpine sh -c 'cd /source && tar czf /backup/uma-telemetry.tgz .'
```


恢复前必须确认目标卷名，停止所有相关容器，并使用生成备份时的相同 UmaAgent 版本。清空目标卷会破坏现有数据，先再次核对：

```bash
docker volume inspect umaagent_uma-state
docker run --rm \
  -v umaagent_uma-state:/target \
  -v "$PWD/backups:/backup:ro" \
  alpine sh -c 'find /target -mindepth 1 -maxdepth 1 -exec rm -rf -- {} + && tar xzf /backup/uma-state.tgz -C /target'
```



数据库当前使用 schema 23；仅允许通过内置的 v22 到 v23 事务迁移升级，其他版本均直接拒绝启动。升级前必须备份并完成完整性与保护用户指纹检查；失败时只切换 release 指针，不覆盖数据库。

## 10. Trace、资源报告与真实 API 验证

Core 的业务数据使用 schema 23 `state.db`；schema 22 首次启动时由 Core 在事务中创建咸鱼渠道会话、设置和投递幂等表，保留已有用户、令牌、会话与消息。Trace 写入 `UMA_TELEMETRY_DIR` 下的独立 `telemetry.db`。生产把该目录挂载给 Core、Server 与 Browser Worker，但不向 Worker 暴露业务 state 或 workspace。Client、Server HTTP、Run、queue、preflight、model、tool、MCP HTTP 和 Browser 阶段通过 W3C `traceparent` 形成跨服务 Span 树；查询入口为 `GET /api/v15/traces?runId=:runId`，支持 `offset`/`limit` 分页。普通用户只能读取自己拥有的 Run，管理员可读取任意 Run。Trace 不保存 prompt、模型正文、完整 URL 查询、Cookie、Token 或原始工具参数。资源快照和诊断报告分别通过 `/api/v15/reports/resources` 与 `/api/v15/reports/diagnostics` 读取，均只允许管理员。候选校验和 Promote 与 systemd 服务一样固定使用 `/opt/node-v22.23.2-linux-x64/bin/node`；系统包管理器提供的 Node 不属于该运行时边界。

真实测试只接受明确的 UmaAgent 环境变量，并在临时目录生成隔离配置、state、workspace、用户和令牌。它不读取 MiniAgent 配置，也不得使用生产保护 PAT。缺少授权或密钥时命令直接失败，不切换 Faux：

```powershell
$env:UMA_REAL_API = "1"
$env:UMA_REAL_PROVIDER = "受控 Provider 名称"
$env:UMA_REAL_MODEL = "受控模型 ID"
$env:UMA_REAL_BASE_URL = "https://受控网关/v1"
$env:UMA_REAL_API_KEY_ENV = "OPENAI_API_KEY"
$env:OPENAI_API_KEY = "从受控密钥管理注入"
npm run test:real:smoke
npm run test:real:eval
$env:UMA_REAL_MESSAGES = "20"
npm run test:real:perf
$env:UMA_REAL_SOAK_MINUTES = "5"
npm run test:real:soak
```

输出只包含 p50/p95/p99、CPU/内存/WAL/event-loop 聚合值、token 数量、错误分类和脱敏 Trace ID，不包含 prompt、完整响应、凭据或隐藏思维链。真实测试结束后会删除临时状态目录。

### 原生发布保护门禁

生产 Promote 必须预先创建 `/etc/uma-agent/protected-user-pat`，所有者为 root、权限为 `0600`。PAT 只由保护脚本在进程内读取，不得作为命令行参数、日志或 Trace 属性传递。使用 release 内的门禁脚本执行切换：

```bash
sudo /opt/uma-agent/releases/<release>/deploy/promote-native-release.sh \
  /opt/uma-agent/releases/<release> /opt/uma-agent/dependencies/node_modules
```

脚本先验证 candidate、执行 SQLite online backup、完整性检查和保护用户对象快照，再原子切换 `current`、检查 live/ready 与只读认证，最后确认保护用户与 token 元数据不变、已有对象未减少且数据库完整。新版本启动时允许为 crash recovery 写入新的运行/响应活动记录；任一步失败只恢复上一 release 指针并重启服务，不覆盖或回滚 `state.db`。

## 11. 故障排查

```bash
docker compose -f docker-compose.yml -f deploy/docker-compose.production.yml ps
docker compose -f docker-compose.yml -f deploy/docker-compose.production.yml logs --tail=200 uma
docker compose -f docker-compose.yml -f deploy/docker-compose.production.yml logs --tail=200 browser-worker
docker inspect --format '{{json .State.Health}}' umaagent-uma-1
```

常见原因：

| 现象 | 检查项 |
| --- | --- |
| Compose 展开失败 | `.env` 中必填变量为空 |
| Core 启动即退出 | 配置未知字段、密钥环境变量缺失、schema 不匹配或状态锁被占用 |
| readiness 503 | workspace 不可访问、模型目录为空或某个已配置 MCP 未连接 |
| Web 403 Origin | `server.webOrigins` 未包含浏览器地址的精确 Origin |
| Web 可打开但无法登录 | Token 错误、跨站 Cookie 未使用 HTTPS、反向代理未传递 Host/协议 |
| 咸鱼工作台返回 403 | 当前 Core 账号角色是 `user`；退出后使用 `admin` 管理员 PAT 登录 |
| 使用服务器保护 PAT 访问接口返回通用 400 | 检查 `/etc/uma-agent/protected-user-pat` 是否为单行 LF 结尾；不要让 `CR` 进入 `Authorization` 请求头。文件必须保持 `root:root 0600` |
| 咸鱼工作台显示 Adapter 不可用 | 检查 `uma-xianyu-adapter.service`、回环地址和 `UMA_XIANYU_CONTROL_TOKEN`，客户端不应直连 3250 |
| 咸鱼总控把状态问题当成文件工作区问题 | 确认当前 release 包含咸鱼渠道工具和 channel preflight 路由；总控应调用 `xianyu_status`，不应通过 `list` 搜索工作区 |
| 咸鱼登录过期 | 在总控会话重新生成二维码扫码；同时检查飞书告警配置和 Adapter 日志 |
| Android 登录显示 `Body cannot be empty when content-type is set to 'application/json'` | 客户端无参数 JSON 请求发送了 0 字节 body；升级到包含 `{}` 请求体修复的 APK，并确认线上清单已指向新版本 |
| CLI 401 | `UMA_TOKEN` 无效、已撤销或已过期 |
| 模型运行失败 | Provider URL、模型 ID、API 类型、Key 或模型 capabilities 不匹配 |
| Core readiness 等待 MCP | profile 未启动、Token 不一致、网络名/URL 错误或循环依赖配置未按本文启动 |

## 12. 部署验收清单

- [ ] `.env`、生产配置和备份未被 Git 跟踪，也未进入 Docker build context。
- [ ] `docker compose config --quiet`、镜像构建和全部容器健康检查通过。
- [ ] liveness、readiness、Bearer API、Web 登录和远程 CLI doctor 通过。
- [ ] 真实模型对话、流式输出、审批、取消和恢复通过。
- [ ] 创建数据后重启 Core，Snapshot、历史和 cursor 连续。
- [ ] 第二个 Core 无法获取同一状态目录锁。
- [ ] 防火墙仅公开 80/443，Worker/MCP 端口不可从公网访问。
- [ ] 完成一次停机备份，并在隔离卷中演练恢复。
- [ ] 确认当前应用版本、Protocol v15 和 schema 23，确认 v22 到 v23 迁移完整性，保留可回滚 release 与同版本备份。
- [ ] Android APK 使用线上同一正式签名证书，`latest.json` 的版本、路径、大小和 SHA-256 与 APK 一致。
- [ ] Android 真机完成更新、PAT 登录、进程重启、会话读取和消息发送；Debug APK 未被发布到生产。
