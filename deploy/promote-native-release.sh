#!/usr/bin/env bash
set -euo pipefail

release_dir=${1:?usage: promote-native-release.sh RELEASE_DIR SHARED_NODE_MODULES}
shared_dir=${2:?usage: promote-native-release.sh RELEASE_DIR SHARED_NODE_MODULES}
state_dir=/var/lib/uma-agent/state
secret_file=/etc/uma-agent/protected-user-pat
current_link=/opt/uma-agent/current
guard_dir=/var/lib/uma-agent/release-guards
backup_dir=/srv/backups/uma-agent
stamp=$(date -u +%Y%m%d%H%M%S)

[[ $(id -u) = 0 ]] || { echo "promotion must run as root" >&2; exit 1; }
[[ -f "$secret_file" ]] || { echo "protected PAT file is missing" >&2; exit 1; }
[[ $(stat -c '%u:%a' "$secret_file") = 0:600 ]] || { echo "protected PAT file must be root:root 0600" >&2; exit 1; }
release_real=$(readlink -f -- "$release_dir")
case "$release_real" in /opt/uma-agent/releases/*) ;; *) echo "invalid release path" >&2; exit 1 ;; esac

"$release_real/deploy/verify-native-release.sh" "$release_real" "$shared_dir"
install -d -o root -g root -m 0700 "$guard_dir" "$backup_dir"
before="$guard_dir/$stamp-before.json"
after="$guard_dir/$stamp-after.json"
backup_db="$backup_dir/state-$stamp.db"
node "$release_real/deploy/backup-native-online.mjs" "$state_dir" "$backup_db"
chmod 0600 "$backup_db"
node "$release_real/deploy/protected-user-fingerprint.mjs" "$state_dir" "$secret_file" >"$before"
chmod 0600 "$before"

previous=$(readlink -f -- "$current_link")
services=(uma-agent.service uma-browser-worker.service uma-feishu-mcp.service uma-feishu-adapter.service)
for service in "${services[@]}"; do
  systemctl cat "$service" >/dev/null
done
if systemctl cat uma-xianyu-adapter.service >/dev/null 2>&1; then services+=(uma-xianyu-adapter.service); fi
rollback() {
  ln -sfn -- "$previous" "${current_link}.rollback"
  mv -Tf -- "${current_link}.rollback" "$current_link"
  systemctl restart "${services[@]}" || true
}
trap rollback ERR

systemctl stop "${services[@]}"
ln -sfn -- "$release_real" "${current_link}.next"
mv -Tf -- "${current_link}.next" "$current_link"
systemctl start "${services[@]}"
ready=0
for _ in {1..30}; do
  if curl --fail --silent --show-error http://127.0.0.1:3210/api/v14/health/ready >/dev/null; then
    ready=1
    break
  fi
  sleep 1
done
[[ "$ready" = 1 ]] || { echo "UmaAgent readiness timed out" >&2; exit 1; }
curl --fail --silent --show-error http://127.0.0.1:3210/api/v14/health/live >/dev/null
curl --fail --silent --show-error http://127.0.0.1:3210/api/v14/health/ready >/dev/null
node "$release_real/deploy/verify-protected-auth.mjs" "$secret_file" >/dev/null
node "$release_real/deploy/protected-user-fingerprint.mjs" "$state_dir" "$secret_file" >"$after"
chmod 0600 "$after"
node "$release_real/deploy/compare-protected-user.mjs" "$before" "$after" >/dev/null
trap - ERR
printf 'Promoted UmaAgent release: %s\n' "$release_real"
printf 'Protected state backup: %s\n' "$backup_db"
