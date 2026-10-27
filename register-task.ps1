# Register repostops.xyz X-Panel as an auto-start Windows scheduled task
$ErrorActionPreference = 'Stop'

$taskName = 'repostops-panel'
$bat      = 'C:\Users\ankit\x_panel\start-panel.bat'

# run the .bat hidden (no console window flashing at logon)
$action = New-ScheduledTaskAction `
    -Execute 'powershell.exe' `
    -Argument "-NoProfile -WindowStyle Hidden -Command `"Start-Process -FilePath '$bat' -WindowStyle Hidden`""

$tLogon = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERNAME"

$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -MultipleInstances IgnoreNew

$principal = New-ScheduledTaskPrincipal -UserId "$env:USERNAME" -LogonType Interactive -RunLevel Limited

Register-ScheduledTask `
    -TaskName $taskName `
    -Action $action `
    -Trigger $tLogon `
    -Settings $settings `
    -Principal $principal `
    -Description 'Keeps repostops.xyz (X-Panel on :3000) running; restarts it automatically.' `
    -Force | Out-Null

Write-Output "REGISTERED OK"
Get-ScheduledTask -TaskName $taskName |
    Select-Object TaskName, State, @{n='Triggers';e={($_.Triggers | ForEach-Object { $_.CimClass.CimClassName }) -join ','}} |
    Format-List | Out-String -Width 200
