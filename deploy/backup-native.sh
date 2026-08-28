#!/usr/bin/env bash
set -euo pipefail

backup_root=/srv/backups/uma-agent
state_root=/var/lib/uma-agent/state
telemetry_root=/var/lib/uma-agent/telemetry
workspace_root=/srv/uma-workspace
xianyu_state_root=/var/lib/uma-agent/channels/xianyu
config=/etc/uma-agent/uma.config.json
xianyu_config=/etc/uma-agent/config.user.json
stamp=$(date -u +%Y%m%d%H%M%S)
archive="$backup_root/uma-state-$stamp.tar.gz"
telemetry_archive="$backup_root/telemetry-$stamp.tar.gz"
workspace_archive="$backup_root/workspace-$stamp.tar.gz"
config_copy="$backup_root/uma-config-$stamp.json"
xianyu_archive="$backup_root/xianyu-state-$stamp.tar.gz"
xianyu_config_copy="$backup_root/xianyu-config-$stamp.json"

install -d -o umaagent -g umaagent -m 0750 "$backup_root"
systemctl stop uma-xianyu-adapter.service uma-browser-worker.service uma-agent.service
restart_required=1
cleanup() {
    if test "$restart_required" = 1; then
        systemctl start uma-agent.service
        systemctl start uma-browser-worker.service 2>/dev/null || true
        systemctl start uma-xianyu-adapter.service 2>/dev/null || true
    fi
}
trap cleanup EXIT

tar -czf "$archive" -C "$state_root" .
if [[ -d "$telemetry_root" ]]; then tar -czf "$telemetry_archive" -C "$telemetry_root" .; fi
if [[ -d "$workspace_root" ]]; then tar -czf "$workspace_archive" -C "$workspace_root" .; fi
if [[ -d "$xianyu_state_root" ]]; then tar -czf "$xianyu_archive" -C "$xianyu_state_root" .; fi
install -o umaagent -g umaagent -m 0640 "$config" "$config_copy"
if [[ -f "$xianyu_config" ]]; then install -o root -g root -m 0600 "$xianyu_config" "$xianyu_config_copy"; fi
backup_files=("$archive" "$config_copy")
[[ -f "$telemetry_archive" ]] && backup_files+=("$telemetry_archive")
[[ -f "$workspace_archive" ]] && backup_files+=("$workspace_archive")
[[ -f "$xianyu_archive" ]] && backup_files+=("$xianyu_archive")
[[ -f "$xianyu_config_copy" ]] && backup_files+=("$xianyu_config_copy")
sha256sum "${backup_files[@]}" >"$backup_root/SHA256SUMS-$stamp"
chown umaagent:umaagent "$archive" "$config_copy" "$backup_root/SHA256SUMS-$stamp"
[[ -f "$telemetry_archive" ]] && chown umaagent:umaagent "$telemetry_archive"
[[ -f "$workspace_archive" ]] && chown umaagent:umaagent "$workspace_archive"
[[ -f "$xianyu_archive" ]] && chown umaagent:umaagent "$xianyu_archive"
chmod 0640 "$archive" "$config_copy" "$backup_root/SHA256SUMS-$stamp"
[[ -f "$telemetry_archive" ]] && chmod 0640 "$telemetry_archive"
[[ -f "$workspace_archive" ]] && chmod 0640 "$workspace_archive"
[[ -f "$xianyu_archive" ]] && chmod 0640 "$xianyu_archive"

# Keep operational data in the ordinary backup set, but never copy secrets from
# uma.env, protected PAT files, or adapter control tokens into that set.
for required in "$archive" "$config_copy"; do
    test -s "$required"
done
sha256sum -c "$backup_root/SHA256SUMS-$stamp" >/dev/null

systemctl start uma-agent.service
systemctl start uma-browser-worker.service
systemctl start uma-xianyu-adapter.service
restart_required=0
trap - EXIT
printf '%s\n' "$stamp"
