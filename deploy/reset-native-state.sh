#!/usr/bin/env bash
set -euo pipefail

if [[ "${1:-}" != "--apply" ]]; then
  echo "Refusing to reset state without --apply" >&2
  exit 2
fi

state_root=/var/lib/uma-agent/state
workspace_root=/srv/uma-workspace
browser_root=/var/lib/uma-agent/browser
archive_root=/srv/backups/uma-agent/reset-$(date -u +%Y%m%d%H%M%S)
archive_glob_root=/var/lib/uma-agent

for path in "$state_root" "$workspace_root" "$browser_root"; do
  case "$path" in
    /var/lib/uma-agent/state|/srv/uma-workspace|/var/lib/uma-agent/browser) ;;
    *) echo "Unexpected reset path: $path" >&2; exit 3 ;;
  esac
done

systemctl stop uma-browser-worker.service uma-agent.service 2>/dev/null || true
install -d -m 0700 "$archive_root"
for path in "$state_root" "$workspace_root" "$browser_root"; do
  if [[ -e "$path" ]]; then
    name=${path##*/}
    mv -- "$path" "$archive_root/$name"
  fi
done
for path in "$archive_glob_root"/archive-state-*; do
  if [[ -d "$path" ]]; then
    name=${path##*/}
    mv -- "$path" "$archive_root/$name"
  fi
done
install -d -o umaagent -g umaagent -m 0750 "$state_root" "$workspace_root"
install -d -o umaagent-browser -g umaagent-browser -m 0750 "$browser_root"
echo "UmaAgent state reset; archived previous data at $archive_root"
