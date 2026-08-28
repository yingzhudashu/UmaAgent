#!/usr/bin/env bash
set -euo pipefail

printf '{\n  "generatedAt": "%s",\n  "paths": [\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
first=1
for path in /srv/backups/uma-agent /var/lib/uma-agent/browser /var/lib/uma-agent /opt/uma-agent/releases /srv/backups/robotclaw; do
  [[ -e "$path" ]] || continue
  size=$(du -sb -- "$path" | awk '{print $1}')
  files=$(find "$path" -type f -printf '.' 2>/dev/null | wc -c)
  [[ $first = 1 ]] || printf ',\n'
  first=0
  printf '    {"path":"%s","bytes":%s,"files":%s}' "$path" "$size" "$files"
done
printf '\n  ],\n  "protected": ["/var/lib/uma-agent/state","/srv/uma-workspace","/var/lib/uma-agent/attachments"]\n}\n'
