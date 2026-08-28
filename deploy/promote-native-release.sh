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
maintenance_file="$state_dir/maintenance.json"
write_maintenance() {
  local enabled=$1
  local tmp
  tmp=$(mktemp "$state_dir/.maintenance.XXXXXX")
  if [[ "$enabled" = 1 ]]; then
    printf '{"maintenance":true,"message":"系统正在停服更新，请稍候。","startedAt":"%s","expectedVersion":"%s"}\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$stamp" >"$tmp"
  else
    printf '{"maintenance":false}\n' >"$tmp"
  fi
  chown umaagent:umaagent "$tmp"
  chmod 0640 "$tmp"
  mv -f -- "$tmp" "$maintenance_file"
}

[[ $(id -u) = 0 ]] || { echo "promotion must run as root" >&2; exit 1; }
[[ -x "$node_bin" ]] || { echo "required Node runtime is missing: $node_bin" >&2; exit 1; }
[[ -f "$secret_file" ]] || { echo "protected PAT file is missing" >&2; exit 1; }
[[ $(stat -c '%u:%a' "$secret_file") = 0:600 ]] || { echo "protected PAT file must be root:root 0600" >&2; exit 1; }
[[ -f /etc/uma-agent/uma.env ]] || { echo "UmaAgent environment file is missing" >&2; exit 1; }
[[ -f /etc/uma-agent/config.user.json ]] || { echo "Xianyu user config is missing" >&2; exit 1; }
[[ -f "$unit" ]] || { echo "Core systemd unit is missing: $unit" >&2; exit 1; }
[[ -f "$browser_unit" ]] || { echo "Browser Worker systemd unit is missing: $browser_unit" >&2; exit 1; }
release_real=$(readlink -f -- "$release_dir")
case "$release_real" in /opt/uma-agent/releases/*) ;; *) echo "invalid release path" >&2; exit 1 ;; esac

bash "$release_real/deploy/verify-native-release.sh" "$release_real" "$shared_dir"
xianyu_enabled=$("$node_bin" -e 'const fs=require("node:fs"); const value=JSON.parse(fs.readFileSync("/etc/uma-agent/config.user.json","utf8")); process.stdout.write(value.xianyu ? "1" : "0")')
if [[ "$xianyu_enabled" = 1 ]]; then
  grep -q '^UMA_XIANYU_ADMIN_PASSWORD_HASH=scrypt\$' /etc/uma-agent/uma.env || {
    echo "Xianyu administrator password hash is missing or invalid" >&2
    exit 1
  }
fi
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
services=(uma-agent.service uma-browser-worker.service)
if [[ "$xianyu_enabled" = 1 ]]; then services+=(uma-xianyu-adapter.service); fi
for service in "${services[@]}"; do
  systemctl cat "$service" >/dev/null
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
  write_maintenance 0 || true
  rm -f -- "$unit_backup" "$browser_unit_backup" "$xianyu_unit_backup"
}
trap rollback ERR

write_maintenance 1

install -o root -g root -m 0644 "$release_real/deploy/uma-agent.service" "$unit"
install -o root -g root -m 0644 "$release_real/deploy/uma-browser-worker.service" "$browser_unit"
install -d -o root -g root -m 0755 /var/www/uma-maintenance
install -o root -g root -m 0644 "$release_real/deploy/maintenance/index.html" /var/www/uma-maintenance/index.html
install -d -o umaagent -g umaagent -m 0770 /var/lib/uma-agent/telemetry
if [[ "$xianyu_enabled" = 1 ]]; then
  install -o root -g root -m 0644 "$release_real/deploy/uma-xianyu-adapter.service" "$xianyu_unit"
  install -d -o umaagent-xianyu -g umaagent-xianyu -m 0770 /var/lib/uma-agent/channels/xianyu
fi
systemctl daemon-reload
systemctl enable "${services[@]}" >/dev/null
systemctl stop uma-agent.service uma-browser-worker.service
if [[ "$xianyu_enabled" = 1 ]]; then systemctl stop uma-xianyu-adapter.service 2>/dev/null || true; fi
ln -sfn -- "$release_real" "${current_link}.next"
mv -Tf -- "${current_link}.next" "$current_link"
systemctl start "${services[@]}"
ready=0
for _ in {1..30}; do
  if curl --fail --silent --show-error http://127.0.0.1:3210/api/v15/health/ready >/dev/null; then
    ready=1
    break
  fi
  sleep 1
done
if [[ "$ready" != 1 ]]; then
  echo "UmaAgent readiness timed out" >&2
  false
fi
curl --fail --silent --show-error http://127.0.0.1:3210/api/v15/health/live >/dev/null
curl --fail --silent --show-error http://127.0.0.1:3210/api/v15/health/ready >/dev/null
if [[ "$xianyu_enabled" = 1 ]]; then
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
fi
"$node_bin" "$release_real/deploy/verify-protected-auth.mjs" "$secret_file" >/dev/null
"$node_bin" "$release_real/deploy/protected-user-fingerprint.mjs" "$state_dir" "$secret_file" >"$after"
chmod 0600 "$after"
"$node_bin" "$release_real/deploy/compare-protected-user.mjs" "$before" "$after" >/dev/null
write_maintenance 0
trap - ERR
rm -f -- "$unit_backup" "$browser_unit_backup" "$xianyu_unit_backup"
printf 'Promoted UmaAgent release: %s\n' "$release_real"
printf 'Protected state backup: %s\n' "$backup_db"
