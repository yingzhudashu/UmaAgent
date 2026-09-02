#!/usr/bin/env bash
set -euo pipefail

release_dir=${1:?usage: install-staging-release.sh RELEASE_DIR SHARED_NODE_MODULES}
shared_dir=${2:?usage: install-staging-release.sh RELEASE_DIR SHARED_NODE_MODULES}
staging_root=/opt/uma-agent-staging
current_link="$staging_root/current"
env_dir=/etc/uma-agent-staging
core_unit=/etc/systemd/system/uma-agent-staging.service
browser_unit=/etc/systemd/system/uma-browser-worker-staging.service

[[ $(id -u) = 0 ]] || { echo "staging installation must run as root" >&2; exit 1; }
release_real=$(readlink -f -- "$release_dir")
case "$release_real" in "$staging_root"/releases/*) ;; *) echo "invalid staging release path" >&2; exit 1 ;; esac
install -d -o root -g umaagent -m 0750 "$env_dir"
[[ -f "$env_dir/uma.env" && -f "$env_dir/uma.config.json" && -f "$env_dir/browser.env" ]] || {
  echo "staging environment, config, or browser environment is missing" >&2; exit 1;
}
for secret in "$env_dir/uma.env" "$env_dir/browser.env"; do
  [[ $(stat -c '%u:%a' "$secret") = 0:600 ]] || { echo "$secret must be root:root 0600" >&2; exit 1; }
done
umaagent_gid=$(id -g umaagent)
[[ $(stat -c '%u:%g:%a' "$env_dir/uma.config.json") = "0:${umaagent_gid}:640" ]] || {
  echo "staging config must be root:umaagent 0640" >&2
  exit 1
}
grep -q '"port"[[:space:]]*:[[:space:]]*3211' "$env_dir/uma.config.json"
grep -q '"host"[[:space:]]*:[[:space:]]*"127\.0\.0\.1"' "$env_dir/uma.config.json"
grep -q 'staging.robotclaw.site' "$env_dir/uma.config.json"
grep -q '"maxParallelSessions"[[:space:]]*:[[:space:]]*1' "$env_dir/uma.config.json"
! grep -q '"xianyu"' "$env_dir/uma.config.json" || { echo "Xianyu is not enabled in staging" >&2; exit 1; }

bash "$release_real/deploy/link-native-dependencies.sh" "$release_real" "$shared_dir"
bash "$release_real/deploy/verify-staging-release.sh" "$release_real" "$shared_dir"
install -d -o umaagent -g umaagent -m 0770 /var/lib/uma-agent-staging/state /var/lib/uma-agent-staging/telemetry /srv/uma-workspace-staging
install -d -o umaagent-browser -g umaagent-browser -m 0770 /var/lib/uma-agent-staging/browser /var/lib/uma-agent-staging/browser-telemetry
install -o root -g root -m 0644 "$release_real/deploy/uma-agent-staging.service" "$core_unit"
install -o root -g root -m 0644 "$release_real/deploy/uma-browser-worker-staging.service" "$browser_unit"

previous=$(readlink -e -- "$current_link" 2>/dev/null || true)
rollback() {
  if [[ -n "$previous" ]]; then
    ln -sfn -- "$previous" "$current_link.rollback"
    mv -Tf "$current_link.rollback" "$current_link"
    systemctl restart uma-browser-worker-staging.service uma-agent-staging.service || true
  else
    systemctl stop uma-agent-staging.service uma-browser-worker-staging.service || true
    rm -f -- "$current_link"
  fi
}
trap rollback ERR
systemctl daemon-reload
systemctl enable uma-browser-worker-staging.service uma-agent-staging.service >/dev/null
systemctl stop uma-agent-staging.service uma-browser-worker-staging.service || true
ln -sfn -- "$release_real" "$current_link.next"
mv -Tf "$current_link.next" "$current_link"
systemctl start uma-browser-worker-staging.service uma-agent-staging.service
for _ in $(seq 1 30); do
  curl --fail --silent http://127.0.0.1:3211/api/v15/health/ready >/dev/null && break
  sleep 1
done
curl --fail --silent http://127.0.0.1:3211/api/v15/health/live >/dev/null
curl --fail --silent http://127.0.0.1:3211/api/v15/health/ready >/dev/null
ss -lnt '( sport = :3211 or sport = :3231 )' | grep -E '127\.0\.0\.1:(3211|3231)'
systemctl is-active --quiet uma-agent-staging.service
systemctl is-active --quiet uma-browser-worker-staging.service
trap - ERR
printf 'Activated staging UmaAgent release: %s\n' "$release_real"
