# Полный дымовой тест учёта на живой базе (tools/office-smoke.mjs all) одним кликом.
# PIN администратора и собственника спрашиваются в этом окне и нигде не печатаются и не сохраняются;
# служебный ключ берётся из data/service_key.txt (вне git). Тест создаёт записи ZZ_TEST_ на служебных
# точках zz_* и в конце убирает их сам (test_cleanup). Итог пишется в .superpowers/smoke-live.txt.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$keyFile = @((Join-Path $root 'data\service_key.txt'),
             (Join-Path (Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $root))) 'data\service_key.txt')) |
  Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $keyFile) { Write-Host 'Не найден data\service_key.txt — без него тест не уберёт за собой.'; Read-Host 'Enter — выход'; exit 1 }

function Ask([string]$prompt) {
  $s = Read-Host -AsSecureString $prompt
  $p = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($s)
  try { [Runtime.InteropServices.Marshal]::PtrToStringBSTR($p) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($p) }
}

# Коды можно не вводить: если рядом со служебным ключом лежит data\smoke_pins.local (вне git) со строками
# TANDEM_ADMIN_PIN=… / TANDEM_OWNER_PIN=… / TANDEM_ADMIN_LOGIN=…, они берутся оттуда.
$pinFile = Join-Path (Split-Path $keyFile) 'smoke_pins.local'
if (Test-Path $pinFile) {
  foreach ($line in Get-Content $pinFile) {
    if ($line -match '^\s*(TANDEM_ADMIN_PIN|TANDEM_OWNER_PIN|TANDEM_ADMIN_LOGIN)\s*=\s*(.+?)\s*$') { Set-Item -Path ('Env:' + $Matches[1]) -Value $Matches[2] }
  }
  Write-Host 'Коды взяты из data\smoke_pins.local'
}
if (-not $env:TANDEM_ADMIN_PIN) { $env:TANDEM_ADMIN_PIN = Ask 'PIN администратора (admin)' }
if (-not $env:TANDEM_OWNER_PIN) { $env:TANDEM_OWNER_PIN = Ask 'Код собственника' }
$env:TANDEM_SERVICE_KEY = (Get-Content $keyFile -Raw).Trim()
$out = Join-Path $root '.superpowers\smoke-live.txt'
New-Item -ItemType Directory -Force (Split-Path $out) | Out-Null
try {
  Push-Location $root
  Write-Host 'Идёт проверка, 3–6 минут…'
  [Console]::OutputEncoding = [Text.Encoding]::UTF8
  $lines = node tools/office-smoke.mjs all 2>&1 | ForEach-Object { "$_" }
  [IO.File]::WriteAllLines($out, $lines, (New-Object Text.UTF8Encoding $false))
  $lines | Where-Object { $_ -match 'FAIL|пройдено' }
} finally {
  Pop-Location
  Remove-Item Env:TANDEM_ADMIN_PIN, Env:TANDEM_OWNER_PIN, Env:TANDEM_SERVICE_KEY, Env:TANDEM_ADMIN_LOGIN -ErrorAction SilentlyContinue
}
Write-Host "Полный вывод: $out"
Read-Host 'Enter — закрыть'
