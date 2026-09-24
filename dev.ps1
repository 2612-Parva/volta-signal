<#
  Local development helper for volta-signal (Windows / PowerShell).
  Requires `npm run dev` to be running in another terminal.

  Usage:
    .\dev.ps1 health
    .\dev.ps1 collect
    .\dev.ps1 publish          # generate variants + post the Slack review card
    .\dev.ps1 publish -NoPost  # generate only, do not post to Slack
    .\dev.ps1 status
    .\dev.ps1 preview var_abc123
#>
param(
  [Parameter(Mandatory = $true, Position = 0)]
  [ValidateSet("health", "collect", "publish", "status", "preview")]
  [string]$Command,

  [Parameter(Position = 1)]
  [string]$VariantId,

  [switch]$NoPost
)

$ErrorActionPreference = "Stop"
$base = "http://127.0.0.1:8787"

function Get-DevVar([string]$name) {
  $match = Select-String -Path "$PSScriptRoot\.dev.vars" -Pattern "^$name=(.*)$"
  if (-not $match) { throw "$name is not set in .dev.vars" }
  return $match.Matches[0].Groups[1].Value.Trim()
}

function Invoke-Admin([string]$path, [string]$method = "GET", $body = $null) {
  $tmp = Join-Path $env:TEMP "volta-signal-admin.json"
  $curlArgs = @(
    "-sS", "--max-time", "180",
    "-X", $method,
    "$base$path",
    "-H", "authorization: Bearer $(Get-DevVar 'ADMIN_RUN_SECRET')",
    "-o", $tmp,
    "-w", "%{http_code}"
  )
  if ($body) {
    $curlArgs += "-H", "content-type: application/json", "--data-raw", ($body | ConvertTo-Json -Compress)
  }

  $status = & curl.exe @curlArgs
  $text = if (Test-Path $tmp) { Get-Content $tmp -Raw } else { "" }
  if ([int]$status -ge 400) {
    Write-Warning "HTTP $status from $method $path"
    if ($text) { Write-Host $text }
    exit 1
  }
  if ($text) { $text | ConvertFrom-Json | ConvertTo-Json -Depth 8 }
}

switch ($Command) {
  "health" {
    (Invoke-WebRequest -Uri "$base/health" -UseBasicParsing).Content | ConvertFrom-Json | ConvertTo-Json -Depth 8
  }
  "collect" {
    Invoke-Admin "/admin/run" "POST" @{ stage = "collect" }
  }
  "publish" {
    Write-Host "Generating three variants; this can take up to 2 minutes on the Groq free tier..." -ForegroundColor Cyan
    Invoke-Admin "/admin/run" "POST" @{ stage = "publish"; post = (-not $NoPost) }
  }
  "status" {
    Invoke-Admin "/admin/status"
  }
  "preview" {
    if (-not $VariantId) { throw "Pass a variant id, e.g. .\dev.ps1 preview var_abc123" }

    # Preview links are `<expiry>.<hmac>` over the variant id; mint a one-hour token.
    $expiry = [string]([DateTimeOffset]::UtcNow.ToUnixTimeSeconds() + 3600)
    $hmac = [System.Security.Cryptography.HMACSHA256]::new(
      [Text.Encoding]::UTF8.GetBytes((Get-DevVar "PREVIEW_SIGNING_SECRET"))
    )
    $hash = $hmac.ComputeHash([Text.Encoding]::UTF8.GetBytes("${VariantId}:${expiry}"))
    $sig = ($hash | ForEach-Object { $_.ToString("x2") }) -join ""

    $url = "$base/preview/$VariantId`?token=$expiry.$sig"
    Write-Host $url
    Start-Process $url
  }
}
