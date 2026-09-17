# UmaAgent 服务器部署与验收

## 1. 部署前确认

推荐起点：Linux x86_64、2 核 CPU、4 GiB 内存和 20 GiB 可用磁盘；启用 Chromium Browser Worker 时建议 4 核、8 GiB。生产采用 Native systemd，需要 Git 和可访问模型 Provider 的出站 HTTPS；可选的容器隔离验证另需 Docker Engine 24+、Compose v2。Node 原生部署要求 Node.js >=22.19.0；当前本机验收为 Node 24.15.0，生产使用模板中固定的运行时。

容器隔离验证先运行以下命令；Native 直接使用第3节 Native 小节的 `/etc/uma-agent` 配置及环境文件：

```bash
git status --short
cp .env.example .env
cp deploy/uma.config.production.example.json deploy/uma.config.production.json
mkdir -p workspace backups
chmod 600 .env
```

编辑 `.env`，分别设置模型/图片 Provider 密钥与两个独立的内部控制令牌：

```bash
openssl rand -hex 32 # BROWSER_WORKER_TOKEN
openssl rand -hex 32 # UMA_XIANYU_CONTROL_TOKEN
```

同时设置模型密钥。不要把 `.env`、生产配置、数据库、日志或备份提交到 Git；这些路径已由 `.gitignore` 和 `.dockerignore` 排除。

## 2. 生产配置

容器编辑 `deploy/uma.config.production.json`；Native 编辑 `/etc/uma-agent/uma.config.json`。共同检查：

- 将 `server.webOrigins` 改为 Web 实际使用的精确 Origin，例如 `https://agent.example.com`。不接受通配符、路径或结尾 `/`。
- 核对 Provider `baseUrl`、模型 ID、API 类型、上下文窗口、输出上限和 capabilities。示例值不是对任意 Provider 的兼容承诺。
- 若启用语义知识检索，设置 `EMBEDDING_API_KEY`，并在配置中保持 `embedding.enabled=true`；默认使用 SiliconFlow `BAAI/bge-m3`。启用但缺少密钥时拒绝启动；仅在显式禁用时使用关键词检索。供应商失败或向量缺失使该次索引失败并显示错误，不把缺失向量的索引标记成功。
- 密钥只通过 `apiKeyEnv` 和 `authTokenEnv` 引用环境变量，不能写进 JSON。
- 多用户 Web/移动端认证使用用户个人令牌；个人令牌只保存哈希，Web Cookie 绑定用户。原生 App 的 PKCE redirect 必须通过 `UMA_OAUTH_REDIRECTS` 显式配置为 `clientId|redirectUri`，禁止通配符。
- `workspaceRoots` 必须使用部署环境的实际目录：容器为 `/data/workspace`，Native 模板为 `/srv/uma-workspace`。远程客户端路径不是服务器工作区路径。
- 只在对应服务确实启动时加入 MCP；readiness 会要求配置中的所有 MCP 已连接。

配置是严格 JSON，未知字段会使 Core 拒绝启动。非回环 HTTP MCP 必须设置 `authTokenEnv`。

Core 启动统一使用 `--max-semi-space-size=4`，限制年轻代半空间为4MiB，避免长会话的短寿命对象让 V8 自动扩大堆。该参数已同步 npm、systemd、Docker 和隔离验收脚本；不限制模型上下文、不改变 SQLite FULL 同步、不调用强制 GC。手工启动 Core 时也应保留此参数，不可仅在性能测试中启用。Linux/容器仍须独立实测。

## 3. 启动 Core

### 可选容器隔离部署

先验证 Compose 展开结果。此命令会检查缺失的必填环境变量，但不会显示 `.env` 之外未引用的密钥：

```bash
docker compose \
  -f docker-compose.yml \
  -f deploy/docker-compose.production.yml \
  config --quiet
```

启动 Compose 中的 Core、Browser Worker 和 Xianyu Adapter：

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
| 共享 Trace 与资源样本 | `/data/telemetry` | `umaagent_uma-telemetry` 命名卷 |
| 咸鱼 Cookie 与渠道状态 | `/data/xianyu` | `umaagent_xianyu-state` 命名卷 |
| 服务器工作区 | `/data/workspace` | `./workspace` bind mount |

卷名前缀由 `COMPOSE_PROJECT_NAME` 决定。不要让第二个 Core 挂载同一 `uma-state` 卷；Core 的业务状态通过进程锁限制为单实例；遥测库支持同机多个服务连接，不能放在不支持 SQLite 文件锁的网络盘。

### Native Node/systemd 部署

当前生产发布链路采用专用系统用户和 Native systemd；state、workspace、配置和环境文件必须放在不同目录。上文 Compose 命令用于可选的本地/CI 隔离验证；文件名 production 表示容器加固配置，不代表本轮已完成容器生产验收。

本仓库提供可直接安装的原生 systemd 模板；部署者应将示例中的域名、路径和用户替换为目标环境值：

- `deploy/uma.config.native.example.json`
- `deploy/uma-agent.service`
- `deploy/backup-native.sh`
- `deploy/verify-native-backup.sh`
- `deploy/link-native-dependencies.sh`
- `deploy/verify-native-release.sh`

模板默认 Core 只监听回环地址；`server.webOrigins`、Node 路径和 Provider 配置必须按目标环境明确设置，MCP 配置以模板实际内容为准。

```bash
sudo useradd --system --home /var/lib/uma-agent --shell /usr/sbin/nologin umaagent
sudo install -d -o umaagent -g umaagent /var/lib/uma-agent/state /srv/uma-workspace
sudo install -d -o umaagent -g umaagent -m 0770 /var/lib/uma-agent/telemetry
sudo install -d -m 0750 /etc/uma-agent
sudo cp deploy/uma.config.native.example.json /etc/uma-agent/uma.config.json
sudo cp deploy/uma.env.native.example /etc/uma-agent/uma.env
sudo chmod 0600 /etc/uma-agent/uma.env

npm ci --ignore-scripts
npm run build
```

不可将整个 release 的 node_modules 链接到旧 release。使用 `deploy/link-native-dependencies.sh` 链接共享的第三方依赖，并让每个 `@uma-agent/*` 指向当前 release 的对应包。`deploy/uma-agent.service` 在启动前调用当前 release 中的 `verify-native-release.sh`，检查包解析路径和数据库格式。

把配置中的 `stateDir` 改为 `/var/lib/uma-agent/state`、`workspaceRoots` 改为 `/srv/uma-workspace`，并按服务器的真实路径调整 `skillsDirs`。若原生启动 Browser Worker，把 MCP URL 改为 `http://127.0.0.1:3230/mcp`；若暂不部署则从 `mcpServers` 删除该项，否则 readiness 会保持 503。安装仓库中的完整 service 模板，不在文档中复制易过期的部分配置：

```bash
sudo cp deploy/uma-agent.service /etc/systemd/system/uma-agent.service
sudo systemctl daemon-reload
sudo systemctl enable --now uma-agent
sudo systemctl status uma-agent
journalctl -u uma-agent -n 200 --no-pager
```

## 4. 健康检查与首轮验收

Liveness 只表示进程事件循环可响应；readiness 还检查数据库、工作区、模型目录和 MCP：

```bash
curl --fail http://127.0.0.1:3210/api/v16/health/live
curl --fail http://127.0.0.1:3210/api/v16/health/ready
curl --fail \
  -H "Authorization: Bearer ${UMA_TOKEN}" \
  http://127.0.0.1:3210/api/v16/sessions
```

再从另一台设备验证 SDK/CLI，而不是只在服务器本机测试：

```bash
export UMA_SERVER_URL=https://agent.example.com
export UMA_TOKEN='当前用户个人访问令牌'
npm run cli -- doctor
npm run cli -- chat
```

`ready` 成功并不代表模型推理一定成功；必须发送一条实际消息，确认模型流式输出、工具审批和终态事件都可用。随后在 Web 中创建一个 Session，重启 Core，确认 Session 和历史仍存在。Native 使用 `sudo systemctl restart uma-agent`；下面两条 Compose 操作仅适用于容器隔离环境：

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

容器隔离部署的 Core 仍绑定宿主机 `127.0.0.1:3210`，由同机 Caddy/Nginx 终止 TLS。不要直接把 Core 改成宿主机公网端口。样例位于：

- `deploy/Caddyfile.example`
- `deploy/nginx.conf.example`

Caddy 和 Nginx 样例都支持 WebSocket。证书域名必须和 `server.webOrigins` 一致。若 Web 独立部署到另一个域名，则将 Web 的 Origin 加入列表，并在构建 Web 时设置 `VITE_UMA_CORE_URL`。跨站 Web Cookie 只应运行在 HTTPS 下。

## 6. Android APK 发布

Android APK 与 Core Server 是两个独立发布面。Core 的 systemd 发布不会更新 APK；APK 由反向代理从部署者指定的静态目录提供：

- `<apk-root>/current`：当前线上 APK 发布目录的原子切换链接。
- `<apk-root>/releases/<versionCode>-<commit>/`：不可变 APK 与 `latest.json` 目录。
- `<apk-root>/releases.json`：历史发布清单。
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
apk_root=/path/to/apk-root
release_id=<versionCode>-<commit>
release_dir="$apk_root/releases/$release_id"
install -d -o root -g root -m 0755 "$release_dir"
install -o root -g root -m 0644 UmaAgent-<versionName>.apk "$release_dir/UmaAgent-<versionName>.apk"
install -o root -g root -m 0644 latest.json "$release_dir/latest.json"
ln -sfn "$release_dir" "$apk_root/current.next"
mv -Tf "$apk_root/current.next" "$apk_root/current"
```

`releases.json` 也必须先写入同目录临时文件、校验 JSON 后再通过同文件系统 `mv` 替换。切换后验证：

```bash
curl --fail https://agent.example.com/app/latest.json
curl --fail --output /tmp/UmaAgent.apk https://agent.example.com/app/releases/<releaseId>/UmaAgent-<versionName>.apk
sha256sum /tmp/UmaAgent.apk
```

确认公网清单中的版本、大小和 SHA-256 与构建产物一致，再在真实 Android 设备上执行更新、登录、进程重启和重新登录验证。发布失败时只切回 `current` 旧链接，不删除旧版本目录。

## 7. 可选服务

### Xianyu Adapter

闲鱼 Adapter 原生服务只监听回环地址；Compose 中绑定容器网络且不发布宿主端口，Core 通过内部控制令牌代理访问。配置 `UMA_XIANYU_CONTROL_TOKEN` 和 `/etc/uma-agent/config.user.json` 后启动。用户侧只使用 Core 管理员 PAT；不再配置咸鱼管理员密码或 Grant。`xianyu.cookie` 首次可以为空，Adapter 会以 `pending_login` 状态启动，不会伪造或复用旧 Cookie：

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
- Native 定期检查 `journalctl -u uma-agent`、磁盘、两库 WAL 和服务重启次数；容器隔离环境检查 `docker compose logs` 和容器状态。
- 配置中的 Provider URL 和 MCP URL 必须是受信地址；不要在 URL 中放用户名、密码或 Token。

## 9. 停机备份与恢复

SQLite 使用 WAL。完整目录备份必须先停止所有业务和遥测写入；不要只复制正在运行的 `state.db`。Native 的 `deploy/backup-native.sh` 使用其固定路径打包 state、telemetry、workspace、配置及渠道状态；执行前检查目标服务和目录是否与部署一致。下文命令只适用于 Compose 卷。

```bash
mkdir -p backups
docker compose -f docker-compose.yml -f deploy/docker-compose.production.yml stop

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

数据库当前使用 schema 25，只接受当前格式。schema 24 升级必须先停止 Core，再执行 `node scripts/upgrade-state.mjs /绝对路径/state.db`。工具取得与 Core 相同的锁，检查原库及外键，生成带时间戳的 schema24 备份并检查备份，然后在事务中增加账号执行策略与审计表并更新版本；失败回滚，重跑已升级库会拒绝。升级后验证 user_version=25、integrity_check=ok 与 foreign_key_check 为空，再启动当前版本。保留必要备份；回退必须停止写入并恢复匹配版本的完整备份，禁止把 25 库交给旧服务。其他旧格式不提供转换，不能靠删除真实数据解决版本差异。不要删除 Adapter Cookie。

离线24→25升级保留现有账户、令牌、会话和运行记录；禁止用初始化空库代替升级。旧 release 无法读取新 schema；回到旧版本只能在隔离路径恢复匹配的完整备份，不能仅切换代码指针后继续读新数据库。当前 schema 内的常规发布继续使用下述对象保护门禁。

## 10. Trace、资源报告与真实 API 验证

Core 的业务数据使用 schema 25 `state.db`；Trace 与资源样本统一写入 `UMA_TELEMETRY_DIR` 下的 `telemetry.db`，state.db 不包含历史 Trace/资源表。生产把该目录授权给 Core、Server、Browser Worker、SMath Worker 与 Xianyu Adapter；各 Worker 不获得业务 state 的访问权。SMath Worker 和 Xianyu Adapter 缺少 UMA_TELEMETRY_DIR 时直接拒绝启动；共享目录需要服务用户的组写权限，不能只设置 systemd ReadWritePaths。Client、Server HTTP、WebSocket、Run、queue、preflight、model、tool、MCP、Browser、SMath 和 Xianyu Adapter 阶段通过 W3C `traceparent` 形成跨服务 Span 树；查询入口为 `GET /api/v16/traces?runId=:runId`，支持 `offset`/`limit` 分页。普通用户必须提供自己拥有的 runId，查询只展开该 Run 及其 Worker 子树；管理员可按 Run 或 traceId 查询包含入口 HTTP/Adapter 的完整链路。外部 traceparent 不是授权凭据，复用 traceId 不扩大查询权限。Trace 不保存 prompt、模型正文、完整 URL、Cookie、Token 或原始工具参数。资源每 30 秒及查询资源报告时采样；`cpuPercent = (cpuUserMicros + cpuSystemMicros) / (sampleDurationMs × 1000 × 可用逻辑核数) × 100`，WAL 为 state 与 telemetry 两库合计。资源快照和诊断报告分别通过 `/api/v16/reports/resources` 与 `/api/v16/reports/diagnostics` 读取，均只允许管理员。候选校验和 Promote 与 systemd 服务一样固定使用 `/opt/node-v22.23.2-linux-x64/bin/node`；系统包管理器提供的 Node 不属于该运行时边界。

真实测试只接受明确的 UmaAgent 环境变量，并在临时目录生成隔离配置、state、workspace、用户和令牌。它不读取 MiniAgent 配置，也不得使用生产保护 PAT。缺少授权或密钥时命令直接失败，不切换 Faux：

```powershell
$env:UMA_REAL_API = "1"
$env:UMA_REAL_PROVIDER = "受控 Provider 名称"
$env:UMA_REAL_MODEL = "受控模型 ID"
$env:UMA_REAL_BASE_URL = "https://受控网关/v1"
$env:UMA_REAL_API_KEY_ENV = "OPENAI_API_KEY"
$env:UMA_REAL_API_TYPE = "openai-completions" # 必须与 Provider 合同匹配
$env:OPENAI_API_KEY = "从受控密钥管理注入"
npm run test:real:smoke
npm run test:real:eval
$env:UMA_REAL_MESSAGES = "20"
npm run test:real:perf
$env:UMA_REAL_SOAK_MINUTES = "5"
npm run test:real:soak
```

输出包含时延分位数、资源样本、token 数量、错误分类和脱敏 Trace ID，不包含 prompt、完整响应、凭据或隐藏思维链。真实测试结束后会删除临时状态目录。

### 原生发布保护门禁

同一 schema 的生产 Promote 必须预先创建 `/etc/uma-agent/protected-user-pat`，所有者为 root、权限为 `0600`。PAT 只由保护脚本在进程内读取，不得作为命令行参数、日志或 Trace 属性传递。使用 release 内的门禁脚本执行切换：

```bash
sudo /opt/uma-agent/releases/<release>/deploy/promote-native-release.sh \
  /opt/uma-agent/releases/<release> /opt/uma-agent/dependencies/node_modules
```

脚本先验证 candidate、执行 SQLite online backup、完整性检查和保护用户对象快照，再原子切换 `current`、检查 live/ready 与只读认证，最后确认保护用户与 token 元数据不变、已有对象未减少且数据库完整。新版本启动时允许为 crash recovery 写入新的运行/响应活动记录；任一步失败只恢复上一 release 指针并重启服务，不覆盖或回滚 `state.db`。

## 11. 故障排查

Native 使用 `systemctl status uma-agent`、`journalctl -u uma-agent -n 200 --no-pager`；以下为容器隔离环境命令：

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
- [ ] Native service 和固定 Node 路径验证通过；选择容器时另验 `docker compose config --quiet`、镜像构建和全部容器健康检查。
- [ ] liveness、readiness、Bearer API、Web 登录和远程 CLI doctor 通过。
- [ ] 真实模型对话、流式输出、审批、取消和恢复通过。
- [ ] 创建数据后重启 Core，Snapshot、历史和 cursor 连续。
- [ ] 第二个 Core 无法获取同一状态目录锁。
- [ ] 防火墙仅公开 80/443，Worker/MCP 端口不可从公网访问。
- [ ] 完成一次停机备份，并在隔离目录或隔离卷中演练恢复。
- [ ] 确认当前应用版本、Protocol v16 和 schema 25；schema 24 已按离线工具备份/转换，数据库完整性检查通过，并保留可回滚 release。
- [ ] Android APK 使用线上同一正式签名证书，`latest.json` 的版本、路径、大小和 SHA-256 与 APK 一致。
- [ ] Android 真机完成更新、PAT 登录、进程重启、会话读取和消息发送；Debug APK 未被发布到生产。


## 私人部署信息与本次发布

仓库中的域名全部为通用示例；实际服务 Origin、模型网关、SSH 目标和签名材料保存在运维机器的用户目录，不提交 Git。Android 使用 Gradle 属性 `umaBaseUrl` / `umaStagingBaseUrl` 或环境变量 `UMA_ANDROID_BASE_URL` / `UMA_ANDROID_STAGING_BASE_URL` 注入 HTTPS Origin，更新清单为同 Origin 下的 `/app/latest.json`。`site.robotclaw.umaagent` 是稳定的应用标识，不是服务器地址；修改会破坏覆盖升级，因此保留。正式发布必须注入实际地址并使用既有证书。

schema 24→25 首次发布先完成停机备份、加密下载和解密哈希验证，再运行 `deploy/upgrade-native-release.sh RELEASE_DIR SHARED_NODE_MODULES`。该入口校验候选、记录保护账号对象指纹、停服、执行独立迁移及受保护发布。迁移失败且库仍为 24 时恢复原服务；库已为 25 后的任何发布失败都会停止服务并保留数据，禁止自动切回 schema 24 的旧 Core。数据库恢复是单独的维护操作，需要保留失败现场并核对恢复点，不能覆盖新写入。

反向代理必须同步使用 `/api/v16/`（含事件 WebSocket），删除旧版本路径。先验证候选和备份，再切换服务及代理，执行 `nginx -t` 后 reload；保留站点其他代理规则、证书和资产不变。Android 更新清单的最低支持版本为 14，与本次删除旧协议一致。

2026-09-17 用户明确授权部署私人服务器。发布仍受本报告列明的已知性能限制约束；完成发布不等于整体性能验收通过。本次已完成 Native 发布、schema25 升级、v16 代理、Web 嵌入和原证书签名 Android 发布；公网与保护对象核验通过，详见发布验收报告。敏感主机名、地址、保护账号和凭据不进入报告。

依赖在独立的版本目录准备，release 的 `node_modules` 链接固定指向该目录。安装时校验指定依赖，服务启动时校验当前 release 自己的依赖链接，避免更新全局共享指针影响旧版本回退。不得在已发布的 release 目录在线安装或修改依赖。

嵌入构建将 KaTeX 字体输出为随包发布的独立文件，宿主必须同时复制 `.js`、`.css`、`.woff2`、`.woff`、`.ttf` 文件，并保持相对路径。构建清单约束 CSS≤1MiB、入口 JS≤10MiB；不得放宽宿主的资源上限来掩盖打包问题。Android 离线正文资源不受嵌入构建配置影响。
