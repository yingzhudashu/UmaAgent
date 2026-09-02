#!/usr/bin/env bash
set -euo pipefail

release=${1:?usage: promote-staging-release.sh RELEASE_ID SHARED_NODE_MODULES}
shared_dir=${2:?usage: promote-staging-release.sh RELEASE_ID SHARED_NODE_MODULES}
staging_root=/opt/uma-agent-staging
production_root=/opt/uma-agent
source_release="$staging_root/releases/$release"
target_release="$production_root/releases/$release"

[[ $(id -u) = 0 ]] || { echo "production promotion must run as root" >&2; exit 1; }
[[ "$release" =~ ^[0-9]{14}-[0-9a-f]{7,40}$ ]] || { echo "invalid release ID" >&2; exit 1; }
[[ $(readlink -f -- "$staging_root/current") = "$source_release" ]] || { echo "release is not active in staging" >&2; exit 1; }
systemctl is-active --quiet uma-agent-staging.service
curl --fail --silent http://127.0.0.1:3211/api/v15/health/ready >/dev/null
[[ ! -e "$target_release" ]] || { echo "production release already exists: $target_release" >&2; exit 1; }

install -d -o root -g root -m 0755 "$target_release"
tar --exclude=node_modules -C "$source_release" -cf - . | tar -C "$target_release" -xf -
chown -R root:root "$target_release"
diff -qr -x node_modules "$source_release" "$target_release" >/dev/null
bash "$target_release/deploy/link-native-dependencies.sh" "$target_release" "$shared_dir"
bash "$target_release/deploy/verify-native-release.sh" "$target_release" "$shared_dir"
bash "$target_release/deploy/promote-native-release.sh" "$target_release" "$shared_dir"
printf 'Promoted byte-for-byte verified staging UmaAgent release: %s\n' "$release"
