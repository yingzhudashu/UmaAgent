#!/usr/bin/env bash
set -euo pipefail

backup_root=/srv/backups/uma-agent
state_root=/var/lib/uma-agent/state
config=/etc/uma-agent/uma.config.json
stamp=$(date -u +%Y%m%d%H%M%S)
archive="$backup_root/uma-state-$stamp.tar.gz"
config_copy="$backup_root/uma-config-$stamp.json"

install -d -o umaagent -g umaagent -m 0750 "$backup_root"
systemctl stop uma-agent.service
restart_required=1
cleanup() {
    if test "$restart_required" = 1; then
        systemctl start uma-agent.service
    fi
}
trap cleanup EXIT

tar -czf "$archive" -C "$state_root" .
install -o umaagent -g umaagent -m 0640 "$config" "$config_copy"
sha256sum "$archive" "$config_copy" >"$backup_root/SHA256SUMS-$stamp"
chown umaagent:umaagent "$archive" "$config_copy" "$backup_root/SHA256SUMS-$stamp"
chmod 0640 "$archive" "$config_copy" "$backup_root/SHA256SUMS-$stamp"

systemctl start uma-agent.service
restart_required=0
trap - EXIT
printf '%s\n' "$stamp"
