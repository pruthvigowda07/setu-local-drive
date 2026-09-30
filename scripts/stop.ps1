$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
$taskPidFile = Join-Path $taskRoot 'data\running.pid'
if (-not (Test-Path -LiteralPath $taskPidFile)) { Write-Output 'No background Setu instance was recorded. Close its terminal if it is running.'; exit }
$taskProcessId = [int](Get-Content -LiteralPath $taskPidFile)
$taskProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$taskProcessId"
$taskServer = Join-Path $taskRoot 'server\main.js'
if ($taskProcess -and $taskProcess.Name -eq 'node.exe' -and $taskProcess.CommandLine.Contains($taskServer)) {
    # Stop only this recorded Setu process and any tunnel child it owns.
    $taskChildren = Get-CimInstance Win32_Process -Filter "ParentProcessId=$taskProcessId"
    foreach ($taskChild in $taskChildren) {
        if ($taskChild.Name -eq 'cloudflared.exe') { Stop-Process -Id $taskChild.ProcessId -ErrorAction SilentlyContinue }
    }
    Stop-Process -Id $taskProcessId
    Remove-Item -LiteralPath $taskPidFile
    Write-Output 'Setu stopped. Its receiving port is closed.'
} else { Write-Output 'The recorded process is not this Setu instance. No process was stopped.' }
