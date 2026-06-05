param(
  [Parameter(Mandatory = $true)]
  [string]$ExePath
)

$ErrorActionPreference = 'Stop'

$target = (Resolve-Path -LiteralPath $ExePath).Path
$name = [IO.Path]::GetFileNameWithoutExtension($target)

$processes = @(
  Get-Process -Name $name -ErrorAction SilentlyContinue | Where-Object {
    try {
      $_.Path -and ([IO.Path]::GetFullPath($_.Path) -ieq $target)
    } catch {
      $false
    }
  }
)

if ($processes.Count -eq 0) {
  exit 0
}

Write-Host "[..] closing running $([IO.Path]::GetFileName($target)) before rebuild ..."

foreach ($process in $processes) {
  try {
    [void]$process.CloseMainWindow()
  } catch {
  }
}

$deadline = (Get-Date).AddSeconds(8)
do {
  Start-Sleep -Milliseconds 500
  $alive = @(
    $processes | Where-Object {
      try {
        [void](Get-Process -Id $_.Id -ErrorAction Stop)
        $true
      } catch {
        $false
      }
    }
  )
} while ($alive.Count -gt 0 -and (Get-Date) -lt $deadline)

if ($alive.Count -gt 0) {
  Write-Host "[..] forcing close for rebuild ..."
  $alive | ForEach-Object {
    Stop-Process -Id $_.Id -Force
  }
  Start-Sleep -Seconds 1
}

exit 0
