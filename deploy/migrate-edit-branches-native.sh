#!/usr/bin/env bash
set -euo pipefail

release=${1:?usage: migrate-edit-branches-native.sh RELEASE_DIR SHARED_NODE_MODULES}
dependencies=${2:?usage: migrate-edit-branches-native.sh RELEASE_DIR SHARED_NODE_MODULES}
node=/opt/node-v22.23.2-linux-x64/bin/node
state=/var/lib/uma-agent/state
secret=/etc/uma-agent/protected-user-pat
services=(uma-agent.service uma-browser-worker.service)
if systemctl cat uma-xianyu-adapter.service >/dev/null 2>&1; then services+=(uma-xianyu-adapter.service); fi
[[ $(id -u) = 0 ]] || { echo 'Run as root' >&2; exit 1; }
release=$(readlink -f -- "$release")
case "$release" in /opt/uma-agent/releases/*) ;; *) exit 1 ;; esac
bash "$release/deploy/verify-native-release.sh" "$release" "$dependencies"
test -f "$release/scripts/migrate-edit-branches.mjs"
schema() { "$node" --input-type=module - "$state/state.db" <<'NODE'
import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync(process.argv[2], { readOnly: true });
console.log(db.prepare("PRAGMA user_version").get().user_version);
db.close();
NODE
}
[[ $(schema) = 25 ]] || { echo 'Only schema 25 can enter this one-time migration' >&2; exit 1; }
before=$($node "$release/deploy/protected-user-fingerprint.mjs" "$state" "$secret")
for service in "${services[@]}"; do systemctl stop "$service"; done
recover() { status=$?; trap - EXIT; if [[ "$status" != 0 && $(schema) = 26 ]]; then systemctl stop "${services[@]}" || true; fi; exit "$status"; }
trap recover EXIT
runuser -u umaagent -- "$node" "$release/scripts/migrate-edit-branches.mjs" "$state/state.db"
bash "$release/deploy/promote-native-release.sh" "$release" "$dependencies"
after=$($node "$release/deploy/protected-user-fingerprint.mjs" "$state" "$secret")
[[ "$before" = "$after" ]] || { echo 'Protected user state changed during migration' >&2; exit 1; }
trap - EXIT
echo 'One-time edit branch migration verified'
