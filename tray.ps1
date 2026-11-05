param([int]$Port)
# PortHop system-tray helper. Started (hidden) by PortHop itself; talks only to http://127.0.0.1:$Port.
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -Namespace Win -Name Native -MemberDefinition '[DllImport("user32.dll")] public static extern bool DestroyIcon(IntPtr h);'
[System.Windows.Forms.Application]::EnableVisualStyles()

$base = "http://127.0.0.1:$Port"
$tick = [string][char]0x2713

function Api([string]$path, [string]$method = 'GET', $body = $null) {
  try {
    if ($method -eq 'GET') { return Invoke-RestMethod -Uri ($base + $path) -TimeoutSec 5 }
    $json = '{}'
    if ($body) { $json = $body | ConvertTo-Json -Compress }
    return Invoke-RestMethod -Uri ($base + $path) -Method Post -Headers @{ 'X-PortHop' = '1' } -ContentType 'application/json' -Body $json -TimeoutSec 90
  } catch { return $null }
}

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
  $h = $bmp.GetHicon()
  $icon = [System.Drawing.Icon]::FromHandle($h).Clone()
  [void][Win.Native]::DestroyIcon($h)
  $bmp.Dispose()
  return $icon
}

$script:activeState = $false
$script:fails = 0
$notify = New-Object System.Windows.Forms.NotifyIcon
$notify.Icon = New-PortIcon $false
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
  $d = Api '/api/tray'
  $s = Api '/api/settings'
  [void](Add-Item 'Open PortHop' { [void](Api '/api/show' 'POST') } $true $null $true)
  Add-Sep
  if ($null -eq $d) {
    [void](Add-Item 'PortHop is not responding' $null $false)
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
  if ($s) { $canStartup = [bool]$s.canStartup; $startup = [bool]$s.startup; $restore = [bool]$s.restore }
  [void](Add-Item 'Start with Windows' {
      param($sender, $e)
      [void](Api '/api/settings' 'POST' @{ startup = (-not $sender.Checked) })
    } $canStartup $startup)
  [void](Add-Item 'Restore forwards on launch' {
      param($sender, $e)
      [void](Api '/api/settings' 'POST' @{ restore = (-not $sender.Checked) })
    } $true $restore)
  Add-Sep
  [void](Add-Item 'Exit' { [void](Api '/api/quit' 'POST') })
  [void](Add-Item 'Exit and close all forwards' { [void](Api '/api/quit' 'POST' @{ closeForwards = $true }) })
}

$menu.Add_Opening({ param($sender, $e) Build-Menu })
$notify.Add_MouseClick({
    param($sender, $e)
    if ($e.Button -eq [System.Windows.Forms.MouseButtons]::Left) { [void](Api '/api/show' 'POST') }
  })

function Stop-Tray {
  $timer.Stop()
  $notify.Visible = $false
  $notify.Dispose()
  [System.Windows.Forms.Application]::Exit()
}

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 2000
$timer.Add_Tick({
    $d = Api '/api/tray'
    if ($null -eq $d) { $script:fails++ } else { $script:fails = 0 }
    if ($script:fails -ge 3 -or ($d -and $d.quit)) { Stop-Tray; return }
    if ($d) {
      $n = @($d.forwards).Count
      $txt = 'PortHop - nothing forwarded'
      if ($n -eq 1) { $txt = 'PortHop - 1 game forwarded' } elseif ($n -gt 1) { $txt = "PortHop - $n games forwarded" }
      if ($notify.Text -ne $txt) { $notify.Text = $txt }
      $isActive = ($n -gt 0) -or ($d.otherPorts -gt 0)
      if ($isActive -ne $script:activeState) {
        $script:activeState = $isActive
        $old = $notify.Icon
        $notify.Icon = New-PortIcon $isActive
        if ($old) { $old.Dispose() }
      }
    }
  })
$timer.Start()

[void](Api '/api/tray/ready' 'POST')
[System.Windows.Forms.Application]::Run((New-Object System.Windows.Forms.ApplicationContext))
