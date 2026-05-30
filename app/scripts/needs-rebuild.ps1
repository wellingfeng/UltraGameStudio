# Exit code 1 = sources newer than the exe (rebuild needed); 0 = up to date.
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File needs-rebuild.ps1 <exePath> <projectRoot>
param([string]$ExePath, [string]$Root)

if (-not (Test-Path $ExePath)) { exit 1 }
$exe = Get-Item $ExePath

$dirs = @("$Root\app\src", "$Root\app\src-tauri\src") | Where-Object { Test-Path $_ }
$src = @()
if ($dirs.Count -gt 0) {
  $src = Get-ChildItem -Recurse -File $dirs -Include *.ts, *.tsx, *.rs, *.css, *.html -ErrorAction SilentlyContinue
}
$cfgPaths = @(
  "$Root\app\index.html",
  "$Root\app\vite.config.ts",
  "$Root\app\tailwind.config.ts",
  "$Root\app\src-tauri\tauri.conf.json",
  "$Root\app\src-tauri\Cargo.toml"
) | Where-Object { Test-Path $_ }
$cfg = @()
if ($cfgPaths.Count -gt 0) { $cfg = Get-ChildItem -File $cfgPaths -ErrorAction SilentlyContinue }

$all = @($src) + @($cfg)
$newer = $all | Where-Object { $_.LastWriteTime -gt $exe.LastWriteTime } | Select-Object -First 1
if ($newer) { exit 1 } else { exit 0 }
