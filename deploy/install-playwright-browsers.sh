#!/usr/bin/env bash
set -euo pipefail

release_dir=${1:?usage: install-playwright-browsers.sh RELEASE_DIR}
node_bin=/opt/node-v22.23.2-linux-x64/bin/node
browser_user=umaagent-browser
browser_group=umaagent-browser
browser_path=/var/lib/uma-agent/browser/.cache/ms-playwright

[[ -x "$node_bin" ]] || { echo "required Node runtime is missing: $node_bin" >&2; exit 1; }
id "$browser_user" >/dev/null 2>&1 || { echo "browser service account is missing: $browser_user" >&2; exit 1; }
release_real=$(readlink -f -- "$release_dir")
case "$release_real" in
  /opt/uma-agent/releases/*) ;;
  *) echo "release resolves outside /opt/uma-agent/releases: $release_real" >&2; exit 1 ;;
esac
[[ -d "$release_real/node_modules" ]] || { echo "release dependencies are not linked" >&2; exit 1; }

install -d -o "$browser_user" -g "$browser_group" -m 0750 \
  /var/lib/uma-agent/browser /var/lib/uma-agent/browser/.cache "$browser_path"
expected=$(cd "$release_real" && PLAYWRIGHT_BROWSERS_PATH="$browser_path" "$node_bin" --input-type=module -e 'import { chromium } from "playwright"; process.stdout.write(chromium.executablePath())')
case "$expected" in
  "$browser_path"/*) ;;
  *) echo "Playwright executable resolves outside the browser cache: $expected" >&2; exit 1 ;;
esac

if [[ ! -x "$expected" ]]; then
  cli="$release_real/node_modules/playwright/cli.js"
  [[ -f "$cli" ]] || { echo "Playwright CLI is missing: $cli" >&2; exit 1; }
  echo "Installing the pinned Playwright Chromium runtime for $release_real"
  runuser -u "$browser_user" -- env PLAYWRIGHT_BROWSERS_PATH="$browser_path" \
    "$node_bin" "$cli" install chromium
fi

[[ -x "$expected" ]] || { echo "Playwright Chromium executable is missing after installation: $expected" >&2; exit 1; }
printf 'Playwright Chromium installed: %s\n' "$expected"
