param(
  [ValidateSet('install', 'uninstall', 'status')]
  [string]$Action = 'install'
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$cmd = Join-Path $here '启动.cmd'
$taskName = 'WyyDesktopLyric'

function Say($m) { Write-Host $m }

switch ($Action) {
  'install' {
    if (-not (Test-Path $cmd)) { Write-Error "找不到 $cmd" }

    $existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    if ($existing) {
      Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
      Say "已移除旧任务"
    }

    $action = New-ScheduledTaskAction -Execute $cmd -WorkingDirectory $here
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
    $settings = New-ScheduledTaskSettingsSet `
      -AllowStartIfOnBatteries `
      -DontStopIfGoingOnBatteries `
      -StartWhenAvailable `
      -ExecutionTimeLimit ([TimeSpan]::Zero) `
      -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)

    Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings `
      -Description '登录后自动启动桌面歌词（网页版网易云音乐）' -Force | Out-Null

    Say "已设置开机（登录）自启：$taskName"
    Say "用的是：$cmd"
    Say '想关掉就运行：powershell -ExecutionPolicy Bypass -File 安装开机自启.ps1 uninstall'
  }
  'uninstall' {
    $existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    if (-not $existing) { Say '没有找到自启任务，无需处理'; return }
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
    Say "已移除自启任务：$taskName"
  }
  'status' {
    $t = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    if (-not $t) { Say '未设置开机自启'; return }
    $info = Get-ScheduledTaskInfo -TaskName $taskName
    [pscustomobject]@{
      任务     = $t.TaskName
      状态     = $t.State
      上次运行 = $info.LastRunTime
      上次结果 = $info.LastTaskResult
      下次运行 = $info.NextRunTime
    } | Format-List
  }
}
