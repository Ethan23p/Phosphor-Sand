# Serve Phosphor Sand locally and expose it over an HTTPS Cloudflare quick tunnel
# (WebGPU needs a secure context, so a phone can't use the plain LAN address).
# Usage: .\serve.ps1 [-Port 8000]   - Ctrl+C stops both server and tunnel.
param([int]$Port = 8000)

$cloudflared = (Get-Command cloudflared -ErrorAction SilentlyContinue).Source
if (-not $cloudflared) {
  $cloudflared = @(
    "$env:ProgramFiles\cloudflared\cloudflared.exe",
    "${env:ProgramFiles(x86)}\cloudflared\cloudflared.exe"
  ) | Where-Object { Test-Path $_ } | Select-Object -First 1
}
if (-not $cloudflared) { throw 'cloudflared not found - install with: winget install Cloudflare.cloudflared' }

$tmp = Join-Path $env:TEMP "phosphor-sand-serve"
New-Item -ItemType Directory -Force $tmp | Out-Null
$tunnelLog = Join-Path $tmp 'tunnel.log'
Remove-Item $tunnelLog -ErrorAction SilentlyContinue

$server = Start-Process python -ArgumentList '-m', 'http.server', $Port, '--bind', '127.0.0.1' `
  -WorkingDirectory $PSScriptRoot -NoNewWindow -PassThru `
  -RedirectStandardOutput (Join-Path $tmp 'server.out') -RedirectStandardError (Join-Path $tmp 'server.log')
$tunnel = Start-Process $cloudflared -ArgumentList 'tunnel', '--no-autoupdate', '--url', "http://localhost:$Port" `
  -NoNewWindow -PassThru -RedirectStandardOutput (Join-Path $tmp 'tunnel.out') -RedirectStandardError $tunnelLog

try {
  Write-Host "Local:  http://localhost:$Port"
  Write-Host 'Waiting for tunnel...'
  $url = $null
  for ($i = 0; $i -lt 60 -and -not $url; $i++) {
    Start-Sleep -Milliseconds 500
    if ($tunnel.HasExited) { throw "cloudflared exited - see $tunnelLog" }
    $m = Select-String -Path $tunnelLog -Pattern 'https://[a-z0-9-]+\.trycloudflare\.com' -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($m) { $url = $m.Matches[0].Value }
  }
  if (-not $url) { throw "No tunnel URL after 30s - see $tunnelLog" }

  Write-Host ''
  Write-Host "Phone:  $url" -ForegroundColor Cyan
  Write-Host ''
  Write-Host 'Ctrl+C to stop.'
  Wait-Process -Id $tunnel.Id
} finally {
  foreach ($p in $tunnel, $server) { if (-not $p.HasExited) { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue } }
  Write-Host 'Stopped.'
}
