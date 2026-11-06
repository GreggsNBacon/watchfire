# Draws PortHop's app icon (the logo from the UI: a sky-to-violet rounded square with a white arrow) and writes
# assets\porthop.ico with sizes 16-256, plus branding\porthop-256.png for previews.
#   powershell -ExecutionPolicy Bypass -File branding\render-icon.ps1
Add-Type -AssemblyName System.Drawing
$root = Split-Path $PSScriptRoot -Parent

function New-Logo([int]$size) {
  $bmp = New-Object System.Drawing.Bitmap $size, $size, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.Clear([System.Drawing.Color]::Transparent)

  # Small sizes fill the whole square; larger ones leave a little room, like other Windows app icons.
  $pad = if ($size -le 24) { 0 } else { [math]::Round($size * 0.04, 2) }
  $s = $size - 2 * $pad
  $r = $s * 0.3                      # the UI's 9px radius on a 30px square
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $path.AddArc($pad, $pad, 2 * $r, 2 * $r, 180, 90)
  $path.AddArc($pad + $s - 2 * $r, $pad, 2 * $r, 2 * $r, 270, 90)
  $path.AddArc($pad + $s - 2 * $r, $pad + $s - 2 * $r, 2 * $r, 2 * $r, 0, 90)
  $path.AddArc($pad, $pad + $s - 2 * $r, 2 * $r, 2 * $r, 90, 90)
  $path.CloseFigure()
  $rect = New-Object System.Drawing.RectangleF $pad, $pad, $s, $s
  $brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush($rect, [System.Drawing.Color]::FromArgb(56, 189, 248), [System.Drawing.Color]::FromArgb(139, 92, 246), 45.0)
  $g.FillPath($brush, $path)

  # The arrow from the UI's SVG (M5 12h14 M13 6l6 6-6 6 in a 24 box), drawn at 18/30 of the square, centred.
  $box = $s * 0.6; $ox = $pad + ($s - $box) / 2; $unit = $box / 24
  $width = [math]::Max(1.6, 2.4 * $unit * ($(if ($size -le 24) { 1.25 } else { 1 })))
  $pen = New-Object System.Drawing.Pen([System.Drawing.Color]::White, $width)
  $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
  $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
  $pen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
  function P([double]$x, [double]$y) { New-Object System.Drawing.PointF ($ox + $x * $unit), ($ox + $y * $unit) }
  $g.DrawLine($pen, (P 5 12), (P 19 12))
  $g.DrawLines($pen, [System.Drawing.PointF[]]@((P 13 6), (P 19 12), (P 13 18)))
  $g.Dispose()
  return $bmp
}

$sizes = 16, 20, 24, 32, 40, 48, 64, 128, 256
$pngs = foreach ($n in $sizes) {
  $bmp = New-Logo $n
  $ms = New-Object System.IO.MemoryStream
  $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  if ($n -eq 256) { $bmp.Save((Join-Path $PSScriptRoot 'porthop-256.png'), [System.Drawing.Imaging.ImageFormat]::Png) }
  $bmp.Dispose()
  , $ms.ToArray()
}

# ICO: header, one directory entry per size, then the PNG data.
New-Item -ItemType Directory -Force (Join-Path $root 'assets') | Out-Null
$out = New-Object System.IO.MemoryStream
$w = New-Object System.IO.BinaryWriter $out
$w.Write([uint16]0); $w.Write([uint16]1); $w.Write([uint16]$sizes.Count)
$offset = 6 + 16 * $sizes.Count
for ($i = 0; $i -lt $sizes.Count; $i++) {
  $n = $sizes[$i]; $len = $pngs[$i].Length
  $w.Write([byte]($n % 256)); $w.Write([byte]($n % 256)); $w.Write([byte]0); $w.Write([byte]0)
  $w.Write([uint16]1); $w.Write([uint16]32); $w.Write([uint32]$len); $w.Write([uint32]$offset)
  $offset += $len
}
foreach ($p in $pngs) { $w.Write($p) }
$w.Flush()
[System.IO.File]::WriteAllBytes((Join-Path $root 'assets\porthop.ico'), $out.ToArray())
"Wrote assets\porthop.ico ($($sizes -join ', ') px)"
