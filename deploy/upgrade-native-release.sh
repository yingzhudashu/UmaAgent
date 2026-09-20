#!/usr/bin/env bash
set -euo pipefail

# 仅供 schema 24→26 的一次性停服发布使用。普通同 schema 发布仍走 promote。
# 不在运行时检测后隐式迁移，也不自动恢复数据库覆盖新版本可能产生的数据。
release=${1:?usage: upgrade-native-release.sh RELEASE_DIR SHARED_NODE_MODULES}
dependencies=${2:?usage: upgrade-native-release.sh RELEASE_DIR SHARED_NODE_MODULES}
node=/opt/node-v22.23.2-linux-x64/bin/node
state=/var/lib/uma-agent/state
secret=/etc/uma-agent/protected-user-pat
stamp=$(date -u +%Y%m%d%H%M%S)
guard=/var/lib/uma-agent/release-guards/upgrade-$stamp
[[ $(id -u) = 0 ]] || { echo 'Run as root' >&2; exit 1; }
release=$(readlink -f -- "$release")
case "$release" in /opt/uma-agent/releases/*) ;; *) exit 1 ;; esac
bash "$release/deploy/verify-native-release.sh" "$release" "$dependencies"
test -f "$release/scripts/upgrade-state.mjs"
schema() {
  "$node" --input-type=module - "$state/state.db" <<'NODE'
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync(process.argv[2], { readOnly: true });
console.log(db.prepare('PRAGMA user_version').get().user_version);
db.close();
NODE
}
[[ $(schema) = 24 ]] || { echo 'Only schema 24 can enter this offline upgrade' >&2; exit 1; }
install -d -o root -g root -m 0700 "$guard"
"$node" "$release/deploy/protected-user-fingerprint.mjs" "$state" "$secret" >"$guard/before.json"
chmod 0600 "$guard/before.json"
services=(uma-agent.service uma-browser-worker.service)
if systemctl cat uma-xianyu-adapter.service >/dev/null 2>&1; then services+=(uma-xianyu-adapter.service); fi
restart=()
for service in "${services[@]}"; do
  if systemctl is-active --quiet "$service"; then restart+=("$service"); fi
done
recover() {
  status=$?
  trap - EXIT
  if [[ "$status" != 0 ]]; then
    if [[ $(schema) = 24 ]]; then
      if [[ ${#restart[@]} -gt 0 ]]; then systemctl start "${restart[@]}"; fi
    else
      systemctl stop "${services[@]}" || true
      echo 'Schema 26 is retained. Services stopped; inspect the backup and repair before restarting.' >&2
    fi
  fi
  exit "$status"
}
trap recover EXIT
systemctl stop "${services[@]}"
runuser -u umaagent -- "$node" "$release/scripts/upgrade-state.mjs" "$state/state.db"
runuser -u umaagent -- "$node" "$release/scripts/migrate-edit-branches.mjs" "$state/state.db"
bash "$release/deploy/promote-native-release.sh" "$release" "$dependencies"
"$node" "$release/deploy/protected-user-fingerprint.mjs" "$state" "$secret" >"$guard/after.json"
chmod 0600 "$guard/after.json"
"$node" "$release/deploy/compare-protected-user.mjs" "$guard/before.json" "$guard/after.json" >/dev/null
trap - EXIT
echo 'Offline schema 24 to 25 promotion verified'
