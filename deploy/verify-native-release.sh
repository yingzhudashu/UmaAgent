#!/usr/bin/env bash
set -euo pipefail

release_dir=${1:?usage: verify-native-release.sh RELEASE_DIR SHARED_NODE_MODULES}
shared_dir=${2:?usage: verify-native-release.sh RELEASE_DIR SHARED_NODE_MODULES}

release_real=$(readlink -f -- "$release_dir")
shared_real=$(readlink -f -- "$shared_dir")
[[ -d "$release_real/apps/server/dist" ]] || { echo "missing server dist in $release_real" >&2; exit 1; }
[[ -d "$release_real/packages/core/dist" ]] || { echo "missing core dist in $release_real" >&2; exit 1; }
[[ -d "$shared_real" ]] || { echo "missing shared dependencies: $shared_dir" >&2; exit 1; }

case "$release_real" in
  /opt/uma-agent/releases/*) ;;
  *) echo "release resolves outside /opt/uma-agent/releases: $release_real" >&2; exit 1 ;;
esac

for package in browser-worker channel-adapter cli client core eval-runner feishu-adapter feishu-mcp protocol server skill-worker web; do
  case "$package" in
    browser-worker|cli|eval-runner|feishu-adapter|feishu-mcp|server|skill-worker) parent=apps ;;
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

printf 'UmaAgent release verified: %s\n' "$release_real"
printf 'Core package: %s\n' "$(readlink -f -- "$release_real/node_modules/@uma-agent/core")"
