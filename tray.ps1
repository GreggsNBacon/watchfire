param([int]$Port)
# PortHop system-tray helper. Started (hidden) by PortHop itself; talks only to http://127.0.0.1:$Port.
#
# Kept snappy on purpose: nothing here ever waits on the network on the UI thread.
#  - A background request keeps $script:data current; the menu is built instantly from that.
#  - Clicks fire their request and return straight away.
#  - The HttpClient skips proxy auto-detection (WPAD), which can add seconds to every local call.
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Net.Http
[System.Windows.Forms.Application]::EnableVisualStyles()

$base = "http://127.0.0.1:$Port"
$tick = [string][char]0x2713

$handler = New-Object System.Net.Http.HttpClientHandler
$handler.UseProxy = $false
$http = New-Object System.Net.Http.HttpClient($handler)
$http.Timeout = [TimeSpan]::FromSeconds(120) # long enough for "close all forwards" on a slow router
$poll = New-Object System.Net.Http.HttpClient($handler, $false)
$poll.Timeout = [TimeSpan]::FromSeconds(4) # background reads: give up quickly

function Send-Post([string]$path, $body = $null) {
  # Fire and forget: the result shows up in the next background refresh.
  $json = '{}'
  if ($body) { $json = $body | ConvertTo-Json -Compress }
  $content = New-Object System.Net.Http.StringContent($json, [System.Text.Encoding]::UTF8, 'application/json')
  $req = New-Object System.Net.Http.HttpRequestMessage([System.Net.Http.HttpMethod]::Post, ($base + $path))
  $req.Content = $content
  [void]$req.Headers.TryAddWithoutValidation('X-PortHop', '1')
  try { [void]$http.SendAsync($req) } catch { }
}

# Both icons are drawn once; switching between them is then free.
function New-PortIcon([bool]$active) {
  $bmp = New-Object System.Drawing.Bitmap 32, 32
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $rect = New-Object System.Drawing.Rectangle 1, 1, 30, 30
  $c1 = [System.Drawing.Color]::FromArgb(56, 189, 248)
  $c2 = [System.Drawing.Color]::FromArgb(139, 92, 246)
  $brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush($rect, $c1, $c2, 45.0)
  $g.FillEllipse($brush, $rect)
  $pen = New-Object System.Drawing.Pen([System.Drawing.Color]::White, 3.2)
  $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
  $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
  $pen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
  $g.DrawLine($pen, 8, 16, 23, 16)
  $pts = [System.Drawing.Point[]]@((New-Object System.Drawing.Point 17, 9), (New-Object System.Drawing.Point 24, 16), (New-Object System.Drawing.Point 17, 23))
  $g.DrawLines($pen, $pts)
  if ($active) {
    $dark = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(20, 24, 36))
    $green = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(52, 211, 153))
    $g.FillEllipse($dark, 17, 17, 15, 15)
    $g.FillEllipse($green, 19, 19, 11, 11)
  }
  $g.Dispose()
  $icon = [System.Drawing.Icon]::FromHandle($bmp.GetHicon()) # two handles for the life of the tray: nothing to clean up
  $bmp.Dispose()
  return $icon
}
$iconIdle = New-PortIcon $false
$iconActive = New-PortIcon $true

$script:data = $null       # last /api/tray answer
$script:pending = $null    # in-flight request
$script:fails = 0
$script:activeState = $false

$notify = New-Object System.Windows.Forms.NotifyIcon
$notify.Icon = $iconIdle
$notify.Text = 'PortHop'
$notify.Visible = $true
$menu = New-Object System.Windows.Forms.ContextMenuStrip
$notify.ContextMenuStrip = $menu

function Add-Item([string]$text, $onClick, [bool]$enabled = $true, $checked = $null, [bool]$bold = $false) {
  $it = New-Object System.Windows.Forms.ToolStripMenuItem($text)
  $it.Enabled = $enabled
  if ($null -ne $checked) { $it.Checked = [bool]$checked }
  if ($bold) { $it.Font = New-Object System.Drawing.Font($it.Font, [System.Drawing.FontStyle]::Bold) }
  if ($onClick) { $it.Add_Click($onClick) }
  [void]$menu.Items.Add($it)
  return $it
}
function Add-Sep { [void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator)) }

function Build-Menu {
  $menu.Items.Clear()
  $d = $script:data
  [void](Add-Item 'Open PortHop' { Send-Post '/api/show' } $true $null $true)
  Add-Sep
  if ($null -eq $d) {
    [void](Add-Item 'Connecting to PortHop...' $null $false)
  } else {
    $title = 'Forwarded now'
    if ($d.router) { $title = 'Forwarded now - ' + $d.router }
    [void](Add-Item $title $null $false)
    $list = @($d.forwards)
    if ($list.Count -eq 0) {
      [void](Add-Item '   Nothing forwarded' $null $false)
    } else {
      foreach ($f in $list) {
        $it = Add-Item ("   $tick  " + $f.name + '   ' + $f.summary) {
          param($sender, $e)
          if ($sender.Tag) {
            [System.Windows.Forms.Clipboard]::SetText([string]$sender.Tag)
            $notify.ShowBalloonTip(1500, 'PortHop', ('Copied ' + $sender.Tag), [System.Windows.Forms.ToolTipIcon]::Info)
          }
        } ([bool]$f.address)
        $it.Tag = [string]$f.address
        if ($f.address) { $it.ToolTipText = 'Click to copy ' + $f.address }
      }
    }
    if ($d.otherPorts -gt 0) { [void](Add-Item ('   + ' + $d.otherPorts + ' other port(s)') $null $false) }
  }
  Add-Sep
  $canStartup = $false; $startup = $false; $restore = $true
  if ($d) { $canStartup = [bool]$d.canStartup; $startup = [bool]$d.startup; $restore = [bool]$d.restore }
  [void](Add-Item 'Start with Windows' {
      param($sender, $e)
      $on = -not $sender.Checked
      if ($script:data) { $script:data.startup = $on } # show the change right away
      Send-Post '/api/settings' @{ startup = $on }
    } $canStartup $startup)
  [void](Add-Item 'Restore forwards on launch' {
      param($sender, $e)
      $on = -not $sender.Checked
      if ($script:data) { $script:data.restore = $on }
      Send-Post '/api/settings' @{ restore = $on }
    } $true $restore)
  Add-Sep
  [void](Add-Item 'Exit' { Send-Post '/api/quit' })
  [void](Add-Item 'Exit and close all forwards' {
      $notify.Text = 'PortHop - closing forwards...'
      Send-Post '/api/quit' @{ closeForwards = $true }
    })
}

$menu.Add_Opening({ param($sender, $e) Build-Menu })
$notify.Add_MouseClick({
    param($sender, $e)
    if ($e.Button -eq [System.Windows.Forms.MouseButtons]::Left) { Send-Post '/api/show' }
  })

function Stop-Tray {
  $timer.Stop()
  $notify.Visible = $false
  $notify.Dispose()
  [System.Windows.Forms.Application]::Exit()
}

function Apply-Data($d) {
  $n = @($d.forwards).Count
  $txt = 'PortHop - nothing forwarded'
  if ($n -eq 1) { $txt = 'PortHop - 1 game forwarded' } elseif ($n -gt 1) { $txt = "PortHop - $n games forwarded" }
  if ($notify.Text -ne $txt -and $notify.Text -ne 'PortHop - closing forwards...') { $notify.Text = $txt }
  $isActive = ($n -gt 0) -or ($d.otherPorts -gt 0)
  if ($isActive -ne $script:activeState) {
    $script:activeState = $isActive
    if ($isActive) { $notify.Icon = $iconActive } else { $notify.Icon = $iconIdle }
  }
}

# Every second: collect the previous background request (if it finished) and start the next one.
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 1000
$timer.Add_Tick({
    $p = $script:pending
    if ($p -and -not $p.IsCompleted) { return } # still waiting; never block
    if ($p) {
      $script:pending = $null
      if ($p.Status -eq [System.Threading.Tasks.TaskStatus]::RanToCompletion) {
        $script:fails = 0
        try { $script:data = $p.Result | ConvertFrom-Json } catch { }
        if ($script:data) {
          if ($script:data.quit) { Stop-Tray; return }
          Apply-Data $script:data
        }
      } else {
        $script:fails++
        if ($script:fails -ge 6) { Stop-Tray; return } # PortHop has gone away
      }
    }
    try { $script:pending = $poll.GetStringAsync($base + '/api/tray') } catch { $script:fails++ }
  })
$timer.Start()

Send-Post '/api/tray/ready'
$script:pending = $poll.GetStringAsync($base + '/api/tray') # first data as soon as possible
[System.Windows.Forms.Application]::Run((New-Object System.Windows.Forms.ApplicationContext))
