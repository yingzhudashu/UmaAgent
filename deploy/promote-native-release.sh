#!/usr/bin/env bash
set -euo pipefail

release_dir=${1:?usage: promote-native-release.sh RELEASE_DIR SHARED_NODE_MODULES}
shared_dir=${2:?usage: promote-native-release.sh RELEASE_DIR SHARED_NODE_MODULES}
state_dir=/var/lib/uma-agent/state
secret_file=/etc/uma-agent/protected-user-pat
current_link=/opt/uma-agent/current
unit=/etc/systemd/system/uma-agent.service
browser_unit=/etc/systemd/system/uma-browser-worker.service
xianyu_unit=/etc/systemd/system/uma-xianyu-adapter.service
guard_dir=/var/lib/uma-agent/release-guards
backup_dir=/srv/backups/uma-agent
node_bin=/opt/node-v22.23.2-linux-x64/bin/node
stamp=$(date -u +%Y%m%d%H%M%S)

[[ $(id -u) = 0 ]] || { echo "promotion must run as root" >&2; exit 1; }
[[ -x "$node_bin" ]] || { echo "required Node runtime is missing: $node_bin" >&2; exit 1; }
[[ -f "$secret_file" ]] || { echo "protected PAT file is missing" >&2; exit 1; }
[[ $(stat -c '%u:%a' "$secret_file") = 0:600 ]] || { echo "protected PAT file must be root:root 0600" >&2; exit 1; }
[[ -f /etc/uma-agent/uma.env ]] || { echo "UmaAgent environment file is missing" >&2; exit 1; }
[[ -f /etc/uma-agent/config.user.json ]] || { echo "Xianyu user config is missing" >&2; exit 1; }
[[ -f "$unit" ]] || { echo "Core systemd unit is missing: $unit" >&2; exit 1; }
[[ -f "$browser_unit" ]] || { echo "Browser Worker systemd unit is missing: $browser_unit" >&2; exit 1; }
grep -q '^UMA_XIANYU_ADMIN_PASSWORD_HASH=scrypt\$' /etc/uma-agent/uma.env || {
  echo "Xianyu administrator password hash is missing or invalid" >&2
  exit 1
}
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

previous=""
if [[ -e "$current_link" || -L "$current_link" ]]; then previous=$(readlink -f -- "$current_link"); fi
unit_backup=$(mktemp /run/uma-agent.service.XXXXXX)
cp -- "$unit" "$unit_backup"
browser_unit_backup=$(mktemp /run/uma-browser-worker.service.XXXXXX)
cp -- "$browser_unit" "$browser_unit_backup"
xianyu_unit_backup=$(mktemp /run/uma-xianyu-adapter.service.XXXXXX)
xianyu_unit_exists=0
if [[ -f "$xianyu_unit" ]]; then
  cp -- "$xianyu_unit" "$xianyu_unit_backup"
  xianyu_unit_exists=1
else
  rm -f -- "$xianyu_unit_backup"
fi
services=(uma-agent.service uma-browser-worker.service uma-xianyu-adapter.service)
for service in "${services[@]}"; do
  if [[ "$service" != "uma-xianyu-adapter.service" ]]; then systemctl cat "$service" >/dev/null; fi
done
rollback() {
  if [[ -n "$previous" ]]; then
    ln -sfn -- "$previous" "${current_link}.rollback"
    mv -Tf -- "${current_link}.rollback" "$current_link"
  else
    rm -f -- "$current_link"
  fi
  install -o root -g root -m 0644 "$unit_backup" "$unit"
  install -o root -g root -m 0644 "$browser_unit_backup" "$browser_unit"
  if [[ "$xianyu_unit_exists" = 1 ]]; then
    install -o root -g root -m 0644 "$xianyu_unit_backup" "$xianyu_unit"
  else
    rm -f -- "$xianyu_unit"
  fi
  systemctl daemon-reload
  systemctl restart "${services[@]}" || true
  rm -f -- "$unit_backup" "$browser_unit_backup" "$xianyu_unit_backup"
}
trap rollback ERR

install -o root -g root -m 0644 "$release_real/deploy/uma-agent.service" "$unit"
install -o root -g root -m 0644 "$release_real/deploy/uma-browser-worker.service" "$browser_unit"
install -o root -g root -m 0644 "$release_real/deploy/uma-xianyu-adapter.service" "$xianyu_unit"
install -d -o umaagent -g umaagent -m 0770 /var/lib/uma-agent/telemetry
install -d -o umaagent-xianyu -g umaagent-xianyu -m 0770 /var/lib/uma-agent/channels/xianyu
systemctl daemon-reload
systemctl enable uma-agent.service uma-browser-worker.service uma-xianyu-adapter.service >/dev/null
systemctl stop uma-agent.service uma-browser-worker.service
systemctl stop uma-xianyu-adapter.service 2>/dev/null || true
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
set -a
. /etc/uma-agent/uma.env
set +a
[[ -n "${UMA_XIANYU_CONTROL_TOKEN:-}" ]] || { echo "UMA_XIANYU_CONTROL_TOKEN is missing" >&2; false; }
grep -q '"host"[[:space:]]*:[[:space:]]*"127\.0\.0\.1"' /etc/uma-agent/config.user.json || {
  echo "Xianyu adapter must bind to 127.0.0.1 in native deployment" >&2
  false
}
curl --fail --silent --show-error -H "Authorization: Bearer $UMA_XIANYU_CONTROL_TOKEN" http://127.0.0.1:3250/health >/dev/null
unset UMA_XIANYU_CONTROL_TOKEN
"$node_bin" "$release_real/deploy/verify-protected-auth.mjs" "$secret_file" >/dev/null
"$node_bin" "$release_real/deploy/protected-user-fingerprint.mjs" "$state_dir" "$secret_file" >"$after"
chmod 0600 "$after"
"$node_bin" "$release_real/deploy/compare-protected-user.mjs" "$before" "$after" >/dev/null
trap - ERR
rm -f -- "$unit_backup" "$browser_unit_backup" "$xianyu_unit_backup"
printf 'Promoted UmaAgent release: %s\n' "$release_real"
printf 'Protected state backup: %s\n' "$backup_db"
