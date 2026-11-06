param([int]$Port, [string]$Dir, [string]$DataDir)
# Watchfire's own window: the UI in WebView2 (the Edge engine built into Windows), with a dark title bar and Watchfire's
# icon, instead of an Edge "app" window. Started by Watchfire; talks only to http://127.0.0.1:$Port.
# Exit codes: 0 closed normally, 3 WebView2 couldn't start (Watchfire then falls back to an Edge app window).
$ErrorActionPreference = 'Stop'
$base = "http://127.0.0.1:$Port"

Add-Type @'
using System; using System.Runtime.InteropServices;
public static class PhNative {
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
  [DllImport("user32.dll")] public static extern uint GetDpiForSystem();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("dwmapi.dll")] public static extern int DwmSetWindowAttribute(IntPtr h, int attr, ref int value, int size);
  [DllImport("shell32.dll")] public static extern int SetCurrentProcessExplicitAppUserModelID([MarshalAs(UnmanagedType.LPWStr)] string id);
  public static void DarkTitleBar(IntPtr h) { int on = 1; if (DwmSetWindowAttribute(h, 20, ref on, 4) != 0) DwmSetWindowAttribute(h, 19, ref on, 4); }
}
'@
# Why the window couldn't open goes to window-error.log next to this script; Watchfire then uses a browser window.
function Fail([string]$why) {
  try { Add-Content -Path (Join-Path $Dir 'window-error.log') -Value ("{0:u} {1}" -f (Get-Date), $why) -Encoding UTF8 } catch { }
  [Environment]::Exit(3)
}

# Sharp text on high-DPI screens (must happen before any window exists), and a taskbar button of Watchfire's own
# rather than PowerShell's.
[void][PhNative]::SetProcessDpiAwarenessContext([IntPtr]::new(-4))
[void][PhNative]::SetCurrentProcessExplicitAppUserModelID('Watchfire.App')

try {
  Add-Type -AssemblyName System.Windows.Forms, System.Drawing, System.Net.Http
  Add-Type -Path (Join-Path $Dir 'Microsoft.Web.WebView2.Core.dll')
  Add-Type -Path (Join-Path $Dir 'Microsoft.Web.WebView2.WinForms.dll')
  [Microsoft.Web.WebView2.Core.CoreWebView2Environment]::SetLoaderDllFolderPath($Dir)
  [void][Microsoft.Web.WebView2.Core.CoreWebView2Environment]::GetAvailableBrowserVersionString() # throws if the runtime is missing
} catch { Fail "WebView2 isn't available: $_" }

[System.Windows.Forms.Application]::EnableVisualStyles()
$bg = [System.Drawing.Color]::FromArgb(10, 12, 18) # the page's --bg, so nothing flashes white while it loads
$scale = [PhNative]::GetDpiForSystem() / 96.0
$area = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea

$form = New-Object System.Windows.Forms.Form
$form.Text = 'Watchfire'
$form.BackColor = $bg
$form.StartPosition = 'CenterScreen'
$form.Size = New-Object System.Drawing.Size ([math]::Min([int](1180 * $scale), $area.Width - 60)), ([math]::Min([int](800 * $scale), $area.Height - 60))
$form.MinimumSize = New-Object System.Drawing.Size ([int](720 * $scale)), ([int](520 * $scale))
try { $form.Icon = New-Object System.Drawing.Icon (Join-Path $Dir 'watchfire.ico') } catch { }
# Watchfire starts this script hidden (no console flash), and Windows applies that to the first ShowWindow call: spend that
# call here, before the form is shown, so the window itself appears normally.
$form.Add_HandleCreated({ [void][PhNative]::ShowWindow($form.Handle, 0); [PhNative]::DarkTitleBar($form.Handle) })
# Opened from the tray or a second launch, the window must come to the front rather than open behind others.
$form.Add_Shown({ $form.TopMost = $true; $form.TopMost = $false; $form.Activate(); [void][PhNative]::SetForegroundWindow($form.Handle) })

$web = New-Object Microsoft.Web.WebView2.WinForms.WebView2
$web.Dock = 'Fill'
$web.DefaultBackgroundColor = $bg
$props = New-Object Microsoft.Web.WebView2.WinForms.CoreWebView2CreationProperties
$props.UserDataFolder = $DataDir
$web.CreationProperties = $props
$form.Controls.Add($web)

function Open-External([string]$url) {
  if ($url -match '^https?://') { try { Start-Process $url } catch { } } # only web links leave the app, never files
}

$web.Add_CoreWebView2InitializationCompleted({
  param($s, $e)
  if (-not $e.IsSuccess) { Fail "WebView2 couldn't start: $($e.InitializationException)" }
  $core = $web.CoreWebView2
  $core.Settings.IsStatusBarEnabled = $false
  $core.Settings.AreDevToolsEnabled = $false
  $core.Settings.IsZoomControlEnabled = $true
  $core.add_DocumentTitleChanged({ $t = $web.CoreWebView2.DocumentTitle; $form.Text = $(if ($t) { $t } else { 'Watchfire' }) })
  # Links that leave Watchfire open in the real browser.
  $core.add_NewWindowRequested({ param($s2, $a) $a.Handled = $true; Open-External $a.Uri })
  $core.add_NavigationStarting({ param($s2, $a) if (-not $a.Uri.StartsWith($base, [StringComparison]::OrdinalIgnoreCase)) { $a.Cancel = $true; Open-External $a.Uri } })
  # The page calls window.close() when Watchfire quits.
  $core.add_WindowCloseRequested({ $form.Close() })
})
$web.Source = New-Object System.Uri ("$base/")

# Watchfire asks an open window to come forward (second launch, tray "Open Watchfire") through /api/window.
$handler = New-Object System.Net.Http.HttpClientHandler
$handler.UseProxy = $false
$http = New-Object System.Net.Http.HttpClient($handler)
$http.Timeout = [TimeSpan]::FromSeconds(3)
$script:seen = -1
$script:pending = $null
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 600
$timer.Add_Tick({
  $p = $script:pending
  if ($p -and -not $p.IsCompleted) { return }
  if ($p -and $p.Status -eq 'RanToCompletion') {
    try {
      $n = [int](($p.Result | ConvertFrom-Json).show)
      if ($script:seen -ge 0 -and $n -ne $script:seen) {
        if ($form.WindowState -eq 'Minimized') { $form.WindowState = 'Normal' }
        $form.Activate(); [void][PhNative]::SetForegroundWindow($form.Handle)
      }
      $script:seen = $n
    } catch { }
  }
  $script:pending = $http.GetStringAsync("$base/api/window")
})
$timer.Start()

[System.Windows.Forms.Application]::Run($form)
$timer.Stop()
