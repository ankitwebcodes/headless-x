param([string]$NodePath = (Get-Command node -ErrorAction Stop).Source)
$dmWorkspace = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $dmWorkspace
# Run this launcher once. A crashed worker restarts; account leases prevent duplicate writes.
while ($true) {
  & $NodePath --experimental-strip-types (Join-Path $PSScriptRoot 'dm-worker.mjs')
  Start-Sleep -Seconds 5
}
