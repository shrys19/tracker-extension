<#
.SYNOPSIS
    Build the native host and register it with installed Chromium-family
    browsers on Windows. Mirrors install.sh (macOS/Linux).

.DESCRIPTION
    On Windows, native messaging hosts are registered in the registry
    (HKCU), where the default value of
    HKCU\Software\<Browser>\NativeMessagingHosts\<name> points to a JSON
    manifest file. The manifest itself holds the path to the .exe and the
    allowed extension origin.

.PARAMETER ExtensionId
    The extension ID from chrome://extensions (Developer mode). Pass the ID
    for the browser you actually use; re-run per browser if their IDs differ.

.EXAMPLE
    .\install.ps1 abcdefghijklmnopabcdefghijklmnop
#>

param(
    [Parameter(Mandatory = $true, Position = 0)]
    [string]$ExtensionId
)

$ErrorActionPreference = "Stop"
$HostName = "com.webtracker.host"

# Crate root = this script's directory.
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Exe = Join-Path $ScriptDir "target\release\web-tracker-host.exe"

# --- 1. build ---------------------------------------------------------
Write-Host "==> building release binary"
Push-Location $ScriptDir
try {
    cargo build --release
    if ($LASTEXITCODE -ne 0) { throw "cargo build failed" }
}
finally {
    Pop-Location
}

if (-not (Test-Path $Exe)) {
    throw "binary not found at $Exe"
}

# --- 2. write the host manifest --------------------------------------
# ConvertTo-Json escapes the backslashes in $Exe to valid JSON (\\).
$manifest = [ordered]@{
    name            = $HostName
    description     = "Website Time Tracker native messaging host"
    path            = $Exe
    type            = "stdio"
    allowed_origins = @("chrome-extension://$ExtensionId/")
}

$ManifestPath = Join-Path $ScriptDir "$HostName.json"
$manifest | ConvertTo-Json -Depth 5 | Set-Content -Encoding UTF8 -Path $ManifestPath
Write-Host "==> wrote manifest: $ManifestPath"

# --- 3. register in the registry for each browser --------------------
# HKCU keys are harmless to create even if the browser is not installed.
# Opera on Windows reads Chrome's NativeMessagingHosts key, so it is
# covered by the Chrome entry below.
$browserKeys = [ordered]@{
    "Chrome (also Opera)" = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$HostName"
    "Chromium"            = "HKCU:\Software\Chromium\NativeMessagingHosts\$HostName"
    "Edge"                = "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\$HostName"
    "Brave"               = "HKCU:\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\$HostName"
}

foreach ($entry in $browserKeys.GetEnumerator()) {
    New-Item -Path $entry.Value -Force | Out-Null
    Set-ItemProperty -Path $entry.Value -Name "(default)" -Value $ManifestPath
    Write-Host "==> registered: $($entry.Name)  ->  $($entry.Value)"
}

Write-Host "==> done. Reload the extension to pick up the host."
