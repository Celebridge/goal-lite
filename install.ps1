$ErrorActionPreference = "Stop"
$dest = Join-Path $env:USERPROFILE ".config\opencode\plugins\goal-lite"
New-Item -ItemType Directory -Force $dest | Out-Null
Copy-Item (Join-Path $PSScriptRoot "index.ts") (Join-Path $dest "index.ts") -Force
Write-Host "Installed goal-lite to $dest"
Write-Host 'Ensure ~/.config/opencode/opencode.json has plugins: ["-opencode.goal"] (add "@openviking/opencode-plugin" only if installed) and experimental.todo: true'
