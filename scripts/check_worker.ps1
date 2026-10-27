Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*worker.py*' -and $_.Name -like '*python*' } | ForEach-Object { "$($_.ProcessId) $($_.Name)" }
