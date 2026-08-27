#!/usr/bin/env bash
set -euo pipefail

release_dir=${1:?usage: verify-native-release.sh RELEASE_DIR SHARED_NODE_MODULES}
shared_dir=${2:?usage: verify-native-release.sh RELEASE_DIR SHARED_NODE_MODULES}
node_bin=/opt/node-v22.23.2-linux-x64/bin/node

[[ -x "$node_bin" ]] || { echo "required Node runtime is missing: $node_bin" >&2; exit 1; }

release_real=$(readlink -f -- "$release_dir")
shared_real=$(readlink -f -- "$shared_dir")
[[ -d "$release_real/apps/server/dist" ]] || { echo "missing server dist in $release_real" >&2; exit 1; }
[[ -d "$release_real/apps/xianyu-adapter/dist" ]] || { echo "missing xianyu adapter dist in $release_real" >&2; exit 1; }
[[ -f "$release_real/deploy/uma-xianyu-adapter.service" ]] || { echo "missing xianyu adapter unit in $release_real" >&2; exit 1; }
[[ -d "$release_real/packages/core/dist" ]] || { echo "missing core dist in $release_real" >&2; exit 1; }
[[ -f "$release_real/RELEASE" ]] || { echo "missing RELEASE metadata in $release_real" >&2; exit 1; }
grep -qx 'protocol=14' "$release_real/RELEASE" || { echo "release protocol is not 14" >&2; exit 1; }
grep -qx 'schema=20' "$release_real/RELEASE" || { echo "release schema is not 20" >&2; exit 1; }
[[ -d "$shared_real" ]] || { echo "missing shared dependencies: $shared_dir" >&2; exit 1; }

case "$release_real" in
  /opt/uma-agent/releases/*) ;;
  *) echo "release resolves outside /opt/uma-agent/releases: $release_real" >&2; exit 1 ;;
esac

for package in browser-worker channel-adapter cli client core eval-runner protocol server skill-worker telemetry xianyu-adapter; do
  case "$package" in
    browser-worker|cli|eval-runner|server|skill-worker|xianyu-adapter) parent=apps ;;
    *) parent=packages ;;
  esac
  link="$release_real/node_modules/@uma-agent/$package"
  target=$(readlink -f -- "$link" 2>/dev/null || true)
  expected="$release_real/$parent/$package"
  [[ "$target" == "$expected" ]] || {
    echo "@uma-agent/$package resolves to $target; expected $expected" >&2
    exit 1
  }
done

for entry in "$shared_real"/* "$shared_real"/.[!.]*; do
  [[ -e "$entry" || -L "$entry" ]] || continue
  name=${entry##*/}
  [[ "$name" == "@uma-agent" ]] && continue
  [[ -e "$release_real/node_modules/$name" || -L "$release_real/node_modules/$name" ]] || {
    echo "missing third-party dependency link: $name" >&2
    exit 1
  }
done

(
  cd "$release_real"
  "$node_bin" --input-type=module -e "await import('@uma-agent/protocol'); await import('@uma-agent/telemetry'); await import('@uma-agent/core'); await import('./apps/server/dist/app.js')"
)

printf 'UmaAgent release verified: %s\n' "$release_real"
printf 'Core package: %s\n' "$(readlink -f -- "$release_real/node_modules/@uma-agent/core")"
