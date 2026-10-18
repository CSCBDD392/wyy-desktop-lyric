<#
  系统媒体会话桥（SMTC -> 本地歌词服务）

  为什么需要它：网页版播放器不对外暴露「播到第几秒」，但 Windows 的系统媒体会话
  （就是音量键弹出的那个媒体卡片）里有歌名、歌手、播放状态和位置。

  位置有个特点：连续播放时不会刷新，只有在暂停/恢复/切歌/拖动这些事件时才刷一次。
  所以这里做「锚定 + 外推」：记住某次刷新的位置和时间，播放中按流逝时间往前推；
  一旦发现 SMTC 报的位置和推算值差得多，就当发生了拖动，立刻重新锚定。

  用法：
    powershell -ExecutionPolicy Bypass -File smtc-bridge.ps1 [-Port 28123] [-Verbose]
#>

param(
  [int]$Port = 28123,
  [int]$IntervalMs = 1000,
  [string]$LogFile = '',
  [switch]$Verbose
)

$ErrorActionPreference = 'Stop'
$endpoint = "http://127.0.0.1:$Port/api/report"

# 记下自己的 PID，供启动脚本判断是否已经在跑
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$pidFile = Join-Path $here 'logs\bridge.pid'
try {
  $logDir = Split-Path -Parent $pidFile
  if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Force -Path $logDir | Out-Null }
  Set-Content -Path $pidFile -Value $PID -Encoding ASCII
} catch { }

Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
  $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
})[0]

function Await($op, $type) {
  $task = $asTaskGeneric.MakeGenericMethod($type).Invoke($null, @($op))
  if (-not $task.Wait(4000)) { throw 'WinRT 调用超时' }
  return $task.Result
}

# 加载 WinRT 类型
[Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime] | Out-Null
[Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties, Windows.Media.Control, ContentType = WindowsRuntime] | Out-Null

function Get-Manager {
  return Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) `
    ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
}

function Get-Snapshot($manager) {
  $best = $null
  $bestScore = -1
  foreach ($s in $manager.GetSessions()) {
    try {
      $props = Await ($s.TryGetMediaPropertiesAsync()) `
        ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
      if ([string]::IsNullOrWhiteSpace($props.Title)) { continue }
      $info = $s.GetPlaybackInfo()
      $tl = $s.GetTimelineProperties()

      # 打分：正在播的优先，其次有时长的优先（视频/网页杂项会话通常没时长）
      $score = 0
      if ($info.PlaybackStatus -eq 'Playing') { $score += 100 }
      if ($tl.EndTime.TotalSeconds -gt 5) { $score += 20 }
      if ($tl.Position.TotalSeconds -gt 0) { $score += 5 }

      if ($score -gt $bestScore) {
        $bestScore = $score
        $best = [pscustomobject]@{
          Title    = [string]$props.Title
          Artist   = [string]$props.Artist
          Status   = [string]$info.PlaybackStatus
          Position = $tl.Position.TotalSeconds
          End      = $tl.EndTime.TotalSeconds
          Updated  = $tl.LastUpdatedTime
          AppId    = [string]$s.SourceAppUserModelId
        }
      }
    } catch {
      continue
    }
  }
  return $best
}

function Post-Report($payload) {
  try {
    $json = $payload | ConvertTo-Json -Compress
    $bytes = [Text.Encoding]::UTF8.GetBytes($json)
    $req = [Net.HttpWebRequest]::Create($endpoint)
    $req.Method = 'POST'
    $req.ContentType = 'application/json'
    $req.ContentLength = $bytes.Length
    $req.Timeout = 2500
    $req.ReadWriteTimeout = 2500
    $stream = $req.GetRequestStream()
    $stream.Write($bytes, 0, $bytes.Length)
    $stream.Close()
    $resp = $req.GetResponse()
    $resp.Close()
    return $true
  } catch {
    return $false
  }
}

# ---------------------------------------------------------------- 锚定状态
$anchor = $null      # @{ Pos; At; Status; Title; Artist }
$lastKey = ''
$posted = 0
$failed = 0

if ($Verbose) { Write-Host '[smtc] 桥接启动，端口 ' $Port }

while ($true) {
  try {
    $manager = Get-Manager
    $snap = Get-Snapshot $manager

    if (-not $snap) {
      # 没有任何媒体会话：不发送，服务端会因为过期而显示「未连接」
      if ($Verbose) { Write-Host '[smtc] 无媒体会话' }
      Start-Sleep -Milliseconds $IntervalMs
      continue
    }

    $key = "$($snap.Title)|$($snap.Artist)|$($snap.Status)"
    $now = Get-Date

    $trace = ''
    if ($LogFile) {
      $trace = ("{0} status={1} pos={2} upd={3} anchorPos={4} anchorUpd={5} keyEq={6} updEq={7}" -f `
        $now.ToString('HH:mm:ss.fff'), $snap.Status, [Math]::Round($snap.Position, 2),
        $snap.Updated.ToString('HH:mm:ss.fff'),
        $(if ($anchor) { [Math]::Round($anchor.Pos, 2) } else { '-' }),
        $(if ($anchor) { $anchor.Updated.ToString('HH:mm:ss.fff') } else { '-' }),
        $(if ($anchor) { $key -eq $lastKey } else { '-' }),
        $(if ($anchor) { $snap.Updated -eq $anchor.Updated } else { '-' }))
    }

    # 什么时候需要重新锚定？
    #   - 第一次
    #   - 换歌 / 播放状态变了（暂停、恢复）
    #   - SMTC 的 LastUpdatedTime 变了（播放器主动刷新了位置：暂停、拖动、跳转）
    #
    # 注意：连续播放时 SMTC 的 Position 和 LastUpdatedTime 都是「冻住」的，
    # 这不是拖动，不能因此重锚——否则位置会每隔两秒被打回原点。
    $needAnchor = $false
    if ($null -eq $anchor) { $needAnchor = $true }
    elseif ($key -ne $lastKey) { $needAnchor = $true }
    elseif ($snap.Updated -ne $anchor.Updated) { $needAnchor = $true }

    if ($LogFile) {
      $trace += (" need={0} nullEq={1} keyNe={2} updNe={3} anchorType={4}" -f `
        $needAnchor, ($null -eq $anchor), ($key -ne $lastKey),
        $(if ($anchor) { $snap.Updated -ne $anchor.Updated } else { '-' }),
        $(if ($anchor) { $anchor.GetType().Name } else { 'null' }))
    }

    if ($needAnchor) {
      $anchor = [pscustomobject]@{
        Pos     = $snap.Position
        At      = $now
        Status  = $snap.Status
        Updated = $snap.Updated
      }
      $lastKey = $key
      if ($Verbose) {
        Write-Host ("[smtc] 锚定 '{0}' pos={1} status={2} upd={3}" -f `
          $snap.Title, [Math]::Round($snap.Position, 2), $snap.Status, $snap.Updated.ToString('HH:mm:ss.fff'))
      }
      if ($LogFile) { $trace += ' REANCHOR' }
    }

    $playing = ($snap.Status -eq 'Playing')
    $elapsed = $anchor.Pos
    if ($playing) { $elapsed = $anchor.Pos + ($now - $anchor.At).TotalSeconds }
    if ($snap.End -gt 0) { $elapsed = [Math]::Min($elapsed, $snap.End) }
    if ($elapsed -lt 0) { $elapsed = 0 }

    $payload = @{
      title    = $snap.Title
      artist   = $snap.Artist
      playing  = $playing
      elapsed  = [Math]::Round($elapsed, 2)
      duration = [Math]::Round($snap.End, 2)
      source   = 'smtc'
    }

    if (Post-Report $payload) {
      $posted++
      $failed = 0
      if ($LogFile) { $trace += ' POST-OK elapsed=' + $payload.elapsed }
      if ($Verbose -and ($posted % 10 -eq 0)) {
        Write-Host "[smtc] #$posted '$($snap.Title)' $([Math]::Round($elapsed,1))s/$([Math]::Round($snap.End,1))s playing=$playing"
      }
    } else {
      $failed++
      if ($LogFile) { $trace += ' POST-FAIL' }
      if ($Verbose -and ($failed % 15 -eq 1)) { Write-Host '[smtc] 上报失败（服务没启动？）' }
    }
    if ($LogFile) { Add-Content -Path $LogFile -Value $trace -Encoding UTF8 }
  } catch {
    if ($Verbose) { Write-Host "[smtc] 异常: $($_.Exception.Message)" }
  }

  Start-Sleep -Milliseconds $IntervalMs
}
