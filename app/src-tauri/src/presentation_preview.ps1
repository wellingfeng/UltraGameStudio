$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)

try {
    $app = New-Object -ComObject PowerPoint.Application
} catch {
    [Console]::Error.WriteLine('无法启动 Microsoft PowerPoint：' + $_.Exception.Message)
    exit 1
}

$security = $null
$alerts = $null
$deck = $null
try {
    $security = $app.AutomationSecurity
    $alerts = $app.DisplayAlerts
    $app.AutomationSecurity = 3 # msoAutomationSecurityForceDisable
    $app.DisplayAlerts = 1      # ppAlertsNone
    # ReadOnly, Untitled, WithWindow
    $deck = $app.Presentations.Open($env:UGS_PPT_PREVIEW_SOURCE, -1, 0, 0)
    $deck.PrintOptions.PrintHiddenSlides = -1
    $deck.SaveAs($env:UGS_PPT_PREVIEW_OUTPUT, 32) # ppSaveAsPDF
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
} finally {
    try {
        if ($null -ne $deck) {
            try { $deck.Close() }
            finally { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($deck) }
        }
    } finally {
        if ($null -ne $security) { $app.AutomationSecurity = $security }
        if ($null -ne $alerts) { $app.DisplayAlerts = $alerts }
        [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($app)
    }
}
