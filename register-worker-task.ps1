# Register the repostops.xyz automation WORKER (:9411) as an auto-start +
# self-healing Windows scheduled task.
#
# The worker is the long-lived controller the console drives per profile
# (▶ Start / ⏹ Stop / 🧹 Clear). start-worker.bat is self-guarded: it exits
# immediately if :9411 is already listening, so running it every 5 minutes is a
# free health check that revives the worker if it ever dies.
$ErrorActionPreference = 'Stop'

$taskName = 'repostops-worker'
$bat      = 'C:\Users\ankit\x_panel\start-worker.bat'

$action = New-ScheduledTaskAction `
    -Execute 'powershell.exe' `
    -Argument "-NoProfile -WindowStyle Hidden -Command `"Start-Process -FilePath '$bat' -WindowStyle Hidden`""

# at logon ...
$tLogon = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERNAME"
# ... and every 5 minutes forever (self-guarded, so a no-op while it is alive)
$tEvery = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(2) `
    -RepetitionInterval (New-TimeSpan -Minutes 5) `
    -RepetitionDuration (New-TimeSpan -Days 3650)

$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -MultipleInstances IgnoreNew

$principal = New-ScheduledTaskPrincipal -UserId "$env:USERNAME" -LogonType Interactive -RunLevel Limited

Register-ScheduledTask `
    -TaskName $taskName `
    -Action $action `
    -Trigger $tLogon, $tEvery `
    -Settings $settings `
    -Principal $principal `
    -Description 'Keeps the repostops.xyz automation worker (per-profile Start/Stop/Clear engine, :9411) alive; revives it within 5 minutes if it dies.' `
    -Force | Out-Null

Write-Output "REGISTERED OK"
Get-ScheduledTask -TaskName $taskName |
    Select-Object TaskName, State | Format-List | Out-String -Width 200
