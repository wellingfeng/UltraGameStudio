param(
  # Target install root. Defaults to the FreeUltraCode managed tools dir passed by the backend.
  [string]$InstallRoot = "",
  # Optional model profile id to download (see $ModelProfiles). Empty = recommended.
  [string]$Model = "",
  # Skip launching the server after install (download/extract only).
  [switch]$NoLaunch,
  # Skip the model download (runtime only).
  [switch]$SkipModel
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

# Official ComfyUI Windows portable (NVIDIA + CPU). Pinned to the latest-release
# redirect so we always pull a current build.
$PortableUrl = "https://github.com/comfyanonymous/ComfyUI/releases/latest/download/ComfyUI_windows_portable_nvidia.7z"
# Standalone 7-Zip extractor (the portable build is .7z; Expand-Archive can't read it).
$SevenZrUrl = "https://www.7-zip.org/a/7zr.exe"

# Ungated, directly downloadable checkpoints. Flux-dev / gated HF repos are left
# out on purpose so the one-click path never stalls on an auth wall.
$ModelProfiles = @(
  [pscustomobject]@{
    Id = "sd1.5"
    Label = "SD 1.5 (轻量)"
    MinVramGb = 4
    Url = "https://huggingface.co/Comfy-Org/stable-diffusion-v1-5-archive/resolve/main/v1-5-pruned-emaonly-fp16.safetensors?download=true"
    FileName = "v1-5-pruned-emaonly-fp16.safetensors"
    SubDir = "checkpoints"
  },
  [pscustomobject]@{
    Id = "sdxl-turbo"
    Label = "SDXL Turbo (均衡)"
    MinVramGb = 8
    Url = "https://huggingface.co/stabilityai/sdxl-turbo/resolve/main/sd_xl_turbo_1.0_fp16.safetensors?download=true"
    FileName = "sd_xl_turbo_1.0_fp16.safetensors"
    SubDir = "checkpoints"
  },
  [pscustomobject]@{
    Id = "flux-schnell"
    Label = "FLUX.1 schnell (高质量)"
    MinVramGb = 12
    Url = "https://huggingface.co/Comfy-Org/flux1-schnell/resolve/main/flux1-schnell-fp8.safetensors?download=true"
    FileName = "flux1-schnell-fp8.safetensors"
    SubDir = "checkpoints"
  }
)

function Write-Step([string]$m) { Write-Host "[..] $m" }
function Write-Ok([string]$m)   { Write-Host "[OK] $m" }

function Get-MachineVram {
  try {
    $vramBytes = (Get-CimInstance Win32_VideoController -ErrorAction Stop |
      Where-Object { $_.AdapterRAM -gt 0 } |
      Measure-Object -Property AdapterRAM -Maximum).Maximum
    if ($vramBytes) { return [math]::Round($vramBytes / 1GB, 1) }
  } catch {}
  return 0
}

function Get-RecommendedModel {
  $vram = Get-MachineVram
  if ($vram -ge 12) { return "flux-schnell" }
  if ($vram -ge 8)  { return "sdxl-turbo" }
  return "sd1.5"
}

function Select-Model([string]$Requested) {
  $trimmed = $Requested.Trim()
  if ($trimmed) {
    $hit = $ModelProfiles | Where-Object { $_.Id -eq $trimmed } | Select-Object -First 1
    if ($hit) { return $hit }
    throw "未知的模型档位：$trimmed"
  }
  $rec = Get-RecommendedModel
  return ($ModelProfiles | Where-Object { $_.Id -eq $rec } | Select-Object -First 1)
}

function Download-File([string]$Url, [string]$Dest) {
  $tmp = "$Dest.download"
  Write-Step "下载 $([System.IO.Path]::GetFileName($Dest)) ..."
  Invoke-WebRequest -Uri $Url -OutFile $tmp -UseBasicParsing
  if (Test-Path -LiteralPath $Dest) { Remove-Item -LiteralPath $Dest -Force }
  Move-Item -LiteralPath $tmp -Destination $Dest -Force
}

if (-not $InstallRoot) {
  $InstallRoot = Join-Path $env:LOCALAPPDATA "FreeUltraCode\tools\comfyui"
}
New-Item -ItemType Directory -Force -Path $InstallRoot | Out-Null

$RuntimeDir = Join-Path $InstallRoot "ComfyUI_windows_portable"
$RunBat = Join-Path $RuntimeDir "run_nvidia_gpu.bat"
$RunCpuBat = Join-Path $RuntimeDir "run_cpu.bat"

# ── 1. Runtime ──────────────────────────────────────────────────────────────
if (Test-Path -LiteralPath $RunBat) {
  Write-Ok "已检测到 ComfyUI 运行时，跳过下载。"
} else {
  $SevenZr = Join-Path $InstallRoot "7zr.exe"
  if (-not (Test-Path -LiteralPath $SevenZr)) {
    Download-File -Url $SevenZrUrl -Dest $SevenZr
  }
  $Archive = Join-Path $InstallRoot "ComfyUI_windows_portable_nvidia.7z"
  Download-File -Url $PortableUrl -Dest $Archive
  Write-Step "解压 ComfyUI 运行时（较大，请耐心等待）..."
  & $SevenZr x $Archive "-o$InstallRoot" -y | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "7zr 解压失败，退出码 $LASTEXITCODE。" }
  Remove-Item -LiteralPath $Archive -Force -ErrorAction SilentlyContinue
  if (-not (Test-Path -LiteralPath $RunBat)) {
    throw "解压完成但未找到 run_nvidia_gpu.bat，目录结构可能已变化。"
  }
  Write-Ok "ComfyUI 运行时就绪：$RuntimeDir"
}

# ── 2. Model ────────────────────────────────────────────────────────────────
if (-not $SkipModel) {
  $profile = Select-Model -Requested $Model
  $ModelsRoot = Join-Path $RuntimeDir "ComfyUI\models"
  $TargetDir = Join-Path $ModelsRoot $profile.SubDir
  New-Item -ItemType Directory -Force -Path $TargetDir | Out-Null
  $ModelPath = Join-Path $TargetDir $profile.FileName
  if (Test-Path -LiteralPath $ModelPath) {
    Write-Ok "模型已存在，跳过下载：$($profile.FileName)"
  } else {
    Write-Step "下载模型 $($profile.Label)（多 GB，依网速可能较久）..."
    Download-File -Url $profile.Url -Dest $ModelPath
    Write-Ok "模型就绪：$($profile.FileName)"
  }
}

# ── 3. Launch ───────────────────────────────────────────────────────────────
if (-not $NoLaunch) {
  $launch = if (Test-Path -LiteralPath $RunBat) { $RunBat } else { $RunCpuBat }
  Write-Step "启动 ComfyUI 服务（127.0.0.1:8188）..."
  Start-Process -FilePath "cmd.exe" -ArgumentList "/c", "`"$launch`"" -WorkingDirectory $RuntimeDir
  for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Seconds 2
    try {
      Invoke-RestMethod -Uri "http://127.0.0.1:8188/system_stats" -Method Get -TimeoutSec 2 | Out-Null
      Write-Ok "ComfyUI 已就绪：http://127.0.0.1:8188"
      break
    } catch {}
  }
}

Write-Host ""
Write-Host "完成。在 FreeUltraCode 中："
Write-Host "  1. 设置 -> 生图渠道 -> ComfyUI (本地/远程)，确认 base URL 为 http://127.0.0.1:8188"
Write-Host "  2. 发送 /comfyui-mode-start 即可在信息流里生成并编辑节点图。"
