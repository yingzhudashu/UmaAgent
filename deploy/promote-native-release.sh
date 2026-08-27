#!/usr/bin/env bash
set -euo pipefail

release_dir=${1:?usage: promote-native-release.sh RELEASE_DIR SHARED_NODE_MODULES}
shared_dir=${2:?usage: promote-native-release.sh RELEASE_DIR SHARED_NODE_MODULES}
state_dir=/var/lib/uma-agent/state
secret_file=/etc/uma-agent/protected-user-pat
current_link=/opt/uma-agent/current
unit=/etc/systemd/system/uma-agent.service
browser_unit=/etc/systemd/system/uma-browser-worker.service
guard_dir=/var/lib/uma-agent/release-guards
backup_dir=/srv/backups/uma-agent
node_bin=/opt/node-v22.23.2-linux-x64/bin/node
stamp=$(date -u +%Y%m%d%H%M%S)

[[ $(id -u) = 0 ]] || { echo "promotion must run as root" >&2; exit 1; }
[[ -x "$node_bin" ]] || { echo "required Node runtime is missing: $node_bin" >&2; exit 1; }
[[ -f "$secret_file" ]] || { echo "protected PAT file is missing" >&2; exit 1; }
[[ $(stat -c '%u:%a' "$secret_file") = 0:600 ]] || { echo "protected PAT file must be root:root 0600" >&2; exit 1; }
release_real=$(readlink -f -- "$release_dir")
case "$release_real" in /opt/uma-agent/releases/*) ;; *) echo "invalid release path" >&2; exit 1 ;; esac

bash "$release_real/deploy/verify-native-release.sh" "$release_real" "$shared_dir"
install -d -o root -g root -m 0700 "$guard_dir" "$backup_dir"
before="$guard_dir/$stamp-before.json"
after="$guard_dir/$stamp-after.json"
backup_db="$backup_dir/state-$stamp.db"
"$node_bin" "$release_real/deploy/backup-native-online.mjs" "$state_dir" "$backup_db"
chmod 0600 "$backup_db"
"$node_bin" "$release_real/deploy/protected-user-fingerprint.mjs" "$state_dir" "$secret_file" >"$before"
chmod 0600 "$before"

previous=$(readlink -f -- "$current_link")
unit_backup=$(mktemp /run/uma-agent.service.XXXXXX)
cp -- "$unit" "$unit_backup"
browser_unit_backup=$(mktemp /run/uma-browser-worker.service.XXXXXX)
cp -- "$browser_unit" "$browser_unit_backup"
services=(uma-agent.service uma-browser-worker.service)
for service in "${services[@]}"; do
  systemctl cat "$service" >/dev/null
done
if systemctl cat uma-xianyu-adapter.service >/dev/null 2>&1; then services+=(uma-xianyu-adapter.service); fi
rollback() {
  ln -sfn -- "$previous" "${current_link}.rollback"
  mv -Tf -- "${current_link}.rollback" "$current_link"
  install -o root -g root -m 0644 "$unit_backup" "$unit"
  install -o root -g root -m 0644 "$browser_unit_backup" "$browser_unit"
  systemctl daemon-reload
  systemctl restart "${services[@]}" || true
  rm -f -- "$unit_backup" "$browser_unit_backup"
}
trap rollback ERR

install -o root -g root -m 0644 "$release_real/deploy/uma-agent.service" "$unit"
install -o root -g root -m 0644 "$release_real/deploy/uma-browser-worker.service" "$browser_unit"
install -d -o umaagent -g umaagent -m 0770 /var/lib/uma-agent/telemetry
systemctl daemon-reload
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
if [[ "$ready" != 1 ]]; then
  echo "UmaAgent readiness timed out" >&2
  false
fi
curl --fail --silent --show-error http://127.0.0.1:3210/api/v14/health/live >/dev/null
curl --fail --silent --show-error http://127.0.0.1:3210/api/v14/health/ready >/dev/null
"$node_bin" "$release_real/deploy/verify-protected-auth.mjs" "$secret_file" >/dev/null
"$node_bin" "$release_real/deploy/protected-user-fingerprint.mjs" "$state_dir" "$secret_file" >"$after"
chmod 0600 "$after"
"$node_bin" "$release_real/deploy/compare-protected-user.mjs" "$before" "$after" >/dev/null
trap - ERR
rm -f -- "$unit_backup" "$browser_unit_backup"
printf 'Promoted UmaAgent release: %s\n' "$release_real"
printf 'Protected state backup: %s\n' "$backup_db"
