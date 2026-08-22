#!/usr/bin/env bash
set -euo pipefail

archive=$1
node_bin=${NODE_BIN:-/opt/node-v22.23.2-linux-x64/bin/node}
scratch=$(mktemp -d /tmp/uma-restore-check.XXXXXX)
cleanup() { rm -rf -- "$scratch"; }
trap cleanup EXIT

tar -xzf "$archive" -C "$scratch"
test -f "$scratch/state.db"
"$node_bin" - "$scratch/state.db" <<'NODE'
const { DatabaseSync } = require("node:sqlite");
const path = process.argv[2];
const db = new DatabaseSync(path, { readOnly: true });
const integrity = db.prepare("PRAGMA integrity_check").get();
if (integrity.integrity_check !== "ok") throw new Error(`integrity_check: ${integrity.integrity_check}`);
const version = db.prepare("PRAGMA user_version").get().user_version;
if (version !== 11) throw new Error(`unexpected schema: ${version}`);
db.close();
console.log(`verified schema=${version}`);
NODE
