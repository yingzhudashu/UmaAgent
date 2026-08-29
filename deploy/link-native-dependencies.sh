#!/usr/bin/env bash
set -euo pipefail

release_dir=${1:?usage: link-native-dependencies.sh RELEASE_DIR SHARED_NODE_MODULES}
shared_dir=${2:?usage: link-native-dependencies.sh RELEASE_DIR SHARED_NODE_MODULES}

if [[ ! -d "$release_dir/packages" || ! -d "$release_dir/apps" ]]; then
  echo "release directory is missing packages/apps: $release_dir" >&2
  exit 1
fi
if [[ ! -d "$shared_dir" ]]; then
  echo "shared node_modules directory does not exist: $shared_dir" >&2
  exit 1
fi

rm -rf -- "$release_dir/node_modules"
install -d -- "$release_dir/node_modules/@uma-agent"

for entry in "$shared_dir"/* "$shared_dir"/.[!.]*; do
  [[ -e "$entry" || -L "$entry" ]] || continue
  name=${entry##*/}
  [[ "$name" == "@uma-agent" ]] && continue
  ln -s -- "$entry" "$release_dir/node_modules/$name"
done

for package in browser-worker channel-adapter cli client core eval-runner protocol server telemetry xianyu-adapter; do
  case "$package" in
    browser-worker|cli|eval-runner|server|xianyu-adapter) parent=apps ;;
    *) parent=packages ;;
  esac
  ln -s -- "../../$parent/$package" "$release_dir/node_modules/@uma-agent/$package"
done
