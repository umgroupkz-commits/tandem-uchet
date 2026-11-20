# Ставит (или ставит заново) задание Планировщика Windows «Тандем - копия учёта на компьютер»: каждый день
# в 12:00 bot/deploy/kopiya-ucheta.sh забирает с сервера PS.kz свежую копию базы учёта. Компьютер выключен
# в 12:00 - задание выполнится при первом включении. Окна нет (conhost --headless), журнал -
# «Копии учёта Тандема\zhurnal.txt». Задание идёт от имени того, кто его поставил, пароль Windows не хранится.
# Запуск:  powershell -ExecutionPolicy Bypass -File bot/deploy/kopiya-ucheta-raspisanie.ps1
# Файл в UTF-8 с BOM: иначе PowerShell 5.1 портит кириллицу в имени задания.
$ErrorActionPreference = 'Stop'

$imya = 'Тандем - копия учёта на компьютер'
$bash = Join-Path $env:ProgramFiles 'Git\bin\bash.exe'
if (-not (Test-Path -LiteralPath $bash)) { $bash = Join-Path ${env:ProgramFiles(x86)} 'Git\bin\bash.exe' }
if (-not (Test-Path -LiteralPath $bash)) { throw 'Не найден Git Bash (Git для Windows)' }

$src = Join-Path $PSScriptRoot 'kopiya-ucheta.sh'
# Скрипт копируется в папку пользователя: рабочее дерево репозитория могут удалить, а задание должно жить.
$dom = Join-Path $env:USERPROFILE 'Копии учёта Тандема'
New-Item -ItemType Directory -Force -Path $dom | Out-Null
$dst = Join-Path $dom 'kopiya-ucheta.sh'
Copy-Item -LiteralPath $src -Destination $dst -Force
$skript = '/' + $dst.Substring(0, 1).ToLower() + ($dst.Substring(2) -replace '\\', '/')

$conhost = Join-Path $env:WINDIR 'System32\conhost.exe'
$deystvie = New-ScheduledTaskAction -Execute $conhost -Argument ('--headless "' + $bash + '" "' + $skript + '" --zhurnal')
$kogda = New-ScheduledTaskTrigger -Daily -At '12:00'
$nastroyki = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 30) -MultipleInstances IgnoreNew
$kto = New-ScheduledTaskPrincipal -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive

Register-ScheduledTask -TaskName $imya -Action $deystvie -Trigger $kogda -Settings $nastroyki -Principal $kto `
  -Description 'Копия базы учёта Тандема с сервера PS.kz на этот компьютер (bot/deploy/kopiya-ucheta.sh)' -Force | Out-Null
Write-Host "Задание «$imya» поставлено: каждый день в 12:00, журнал - $dom\zhurnal.txt"
