#!/usr/bin/env bash
set -euo pipefail
dest="$HOME/.config/opencode/plugins/goal-lite"
src="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$dest"
for file in index.ts rpc.ts tui.tsx; do
  cp "$src/$file" "$dest/$file"
done
echo "Installed goal-lite to $dest"
echo 'Ensure ~/.config/opencode/opencode.json has plugins: ["-opencode.goal"] (add "@openviking/opencode-plugin" only if installed) and experimental.todo: true'
