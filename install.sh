#!/usr/bin/env bash
set -euo pipefail
dest="$HOME/.config/opencode/plugins/goal-lite"
mkdir -p "$dest"
cp "$(cd "$(dirname "$0")" && pwd)/index.ts" "$dest/index.ts"
echo "Installed goal-lite to $dest"
echo 'Ensure ~/.config/opencode/opencode.json has: plugins: ["@openviking/opencode-plugin", "-opencode.goal"] and experimental.todo: true'
