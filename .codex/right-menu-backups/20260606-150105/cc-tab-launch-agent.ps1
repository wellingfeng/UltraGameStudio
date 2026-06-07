param(
    [Parameter(Mandatory=$true)][string]$Agent,
    [string]$StartPath
)

$ErrorActionPreference = "Stop"

function Get-SettingsPath {
    $base = if ($env:LOCALAPPDATA) { $env:LOCALAPPDATA } elseif ($env:USERPROFILE) { $env:USERPROFILE } else { $HOME }
    return Join-Path $base "cc-tab\local-settings.txt"
}

function Get-SettingValue {
    param([string]$Key, [string]$Default)
    $path = Get-SettingsPath
    if (-not (Test-Path -LiteralPath $path)) { return $Default }
    foreach ($line in Get-Content -LiteralPath $path -ErrorAction SilentlyContinue) {
        $parts = $line -split "=", 2
        if ($parts.Count -eq 2 -and $parts[0].Trim() -eq $Key) {
            $value = $parts[1].Trim()
            if ($value) { return $value }
        }
    }
    return $Default
}

function Normalize-Preset {
    param([string]$Value)
    if ($null -eq $Value) { $Value = "" }
    switch -Regex ($Value.Trim().ToLowerInvariant()) {
        "^(risky|risk|danger|dangerous|full|full_access|full-access|danger-full-access|danger_full_access|full_auto|full-auto|highest|yolo|bypass|never|bypass_permissions|bypasspermissions|bypass-permissions)$" { return "risky" }
        "^(normal|default|ordinary|standard|safe|ask|request|request_based|request-based|on_request|on-request|suggest|plan)$" { return "normal" }
        default { return "auto" }
    }
}

function Get-AgentArgs {
    param([string]$Agent, [string]$Preset)
    switch ($Agent) {
        "codex" {
            if ($Preset -eq "risky") { return @("--dangerously-bypass-approvals-and-sandbox") }
            if ($Preset -eq "normal") { return @("--sandbox", "read-only", "--ask-for-approval", "untrusted") }
            return @("--sandbox", "workspace-write", "--ask-for-approval", "on-request")
        }
        "claude-code" {
            if ($Preset -eq "risky") { return @("--permission-mode", "bypassPermissions") }
            if ($Preset -eq "normal") { return @("--permission-mode", "default") }
            return @("--permission-mode", "acceptEdits")
        }
        "gemini" {
            if ($Preset -eq "risky") { return @("--approval-mode", "yolo") }
            if ($Preset -eq "normal") { return @("--approval-mode", "default") }
            return @("--approval-mode", "auto_edit")
        }
        default { return @() }
    }
}

function Get-AgentCommand {
    param([string]$Agent)
    switch ($Agent) {
        "codex" { return "codex" }
        "claude-code" { return "claude" }
        "gemini" { return "gemini" }
        default { return $null }
    }
}

if ([string]::IsNullOrWhiteSpace($StartPath)) { $StartPath = (Get-Location).Path }
Set-Location -LiteralPath $StartPath

$preset = Normalize-Preset (Get-SettingValue "cli_permission_preset" "auto")
$Host.UI.RawUI.WindowTitle = "cc-tab $Agent ($preset)"
Write-Host ""
Write-Host "cc-tab shell menu" -ForegroundColor Cyan
Write-Host "agent: $Agent" -ForegroundColor DarkCyan
Write-Host "permission preset: $preset" -ForegroundColor DarkCyan
Write-Host "directory: $StartPath" -ForegroundColor DarkCyan
Write-Host ""

if ($Agent -eq "console") {
    & "cc-tab-local" console
    exit $LASTEXITCODE
}

$agentCommand = Get-AgentCommand $Agent
if (-not $agentCommand) {
    Write-Host "unsupported agent: $Agent" -ForegroundColor Red
    exit 2
}

$agentArgs = @(Get-AgentArgs $Agent $preset)
Write-Host "launch mode: direct agent CLI" -ForegroundColor DarkCyan
Write-Host ("command: {0} {1}" -f $agentCommand, ($agentArgs -join " ")) -ForegroundColor DarkCyan
Write-Host ""

& $agentCommand @agentArgs
exit $LASTEXITCODE
