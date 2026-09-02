#!/usr/bin/env bash
set -euo pipefail

release_dir=${1:?usage: verify-staging-release.sh RELEASE_DIR SHARED_NODE_MODULES}
shared_dir=${2:?usage: verify-staging-release.sh RELEASE_DIR SHARED_NODE_MODULES}
UMA_RELEASE_ROOT=/opt/uma-agent-staging/releases \
  exec bash "$(dirname "$0")/verify-native-release.sh" "$release_dir" "$shared_dir"
