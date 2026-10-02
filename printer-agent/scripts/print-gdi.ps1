<#
  Draws a label (JSON from gdiPrint.ts) as a normal Windows page and prints it through the printer's
  driver — the same path ordinary apps use. All sizes in the JSON are TSPL dots; 8 dots = 1 mm.
#>
param(
    [Parameter(Mandatory = $true)][string]$PrinterName,
    [Parameter(Mandatory = $true)][string]$JobFile
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

try {
    $job = Get-Content -LiteralPath $JobFile -Raw | ConvertFrom-Json
    $dpm = [double]$job.dotsPerMm

    $doc = New-Object System.Drawing.Printing.PrintDocument
    $doc.PrinterSettings.PrinterName = $PrinterName
    if (-not $doc.PrinterSettings.IsValid) { throw "Printer not found: $PrinterName" }
    $doc.DocumentName = 'TRIVO tag'
    $doc.PrintController = New-Object System.Drawing.Printing.StandardPrintController
    $doc.DefaultPageSettings.Margins = New-Object System.Drawing.Printing.Margins(0, 0, 0, 0)
    $w = [int][Math]::Round($job.widthMm / 25.4 * 100)
    $h = [int][Math]::Round($job.heightMm / 25.4 * 100)
    $doc.DefaultPageSettings.PaperSize = New-Object System.Drawing.Printing.PaperSize('TRIVO Tag', $w, $h)

    $doc.add_PrintPage({
        param($sender, $e)
        $g = $e.Graphics
        $g.PageUnit = [System.Drawing.GraphicsUnit]::Millimeter
        $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::None
        $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::NearestNeighbor
        $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::Half
        $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::SingleBitPerPixelGridFit
        # Printable area starts at the hard margin; shift so (0,0) is the label's top-left corner.
        $g.TranslateTransform(-$e.PageSettings.HardMarginX * 0.254, -$e.PageSettings.HardMarginY * 0.254)
        $black = [System.Drawing.Brushes]::Black
        $fmt = [System.Drawing.StringFormat]::GenericTypographic
        $fmt.FormatFlags = $fmt.FormatFlags -bor [System.Drawing.StringFormatFlags]::NoWrap

        foreach ($it in $job.items) {
            $state = $g.Save()
            switch ($it.type) {
                'text' {
                    $g.TranslateTransform($it.x / $dpm, $it.y / $dpm)
                    $g.RotateTransform([single]$it.rot)
                    $font = New-Object System.Drawing.Font('Arial', [single](2.9 * $it.mult), [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Millimeter)
                    $g.DrawString([string]$it.text, $font, $black, 0, 0, $fmt)
                    $font.Dispose()
                }
                'barcode' {
                    # Draw bars ourselves on whole printer dots: a scaled bitmap lands modules on fractional
                    # dots, so bar widths come out uneven and scanners cannot decode it.
                    $g.TranslateTransform($it.x / $dpm, $it.y / $dpm)
                    $g.RotateTransform([single]$it.rot)
                    $dotMm = 25.4 / $g.DpiX
                    $modMm = [Math]::Max(2, [Math]::Round(($it.narrow / $dpm) / $dotMm)) * $dotMm
                    $bh = [Math]::Round(($it.height / $dpm) / $dotMm) * $dotMm
                    $x = 10 * $modMm   # quiet zone
                    $isBar = $true
                    foreach ($w in $it.sbs) {
                        if ($isBar) { $g.FillRectangle($black, [single]$x, [single]0, [single]($w * $modMm), [single]$bh) }
                        $x += $w * $modMm
                        $isBar = -not $isBar
                    }
                    if ($it.readable) {
                        $font = New-Object System.Drawing.Font('Arial', [single]2.2, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Millimeter)
                        $g.DrawString([string]$it.text, $font, $black, [single](10 * $modMm), [single]($bh + 0.3), $fmt)
                        $font.Dispose()
                    }
                }
                'qrcode' {
                    $g.TranslateTransform($it.x / $dpm, $it.y / $dpm)
                    $g.RotateTransform([single]$it.rot)
                    $ms = New-Object System.IO.MemoryStream (, [Convert]::FromBase64String($it.png))
                    $img = [System.Drawing.Image]::FromStream($ms)
                    $bw = $img.Width * $it.cell / $dpm; $bh = $img.Height * $it.cell / $dpm
                    $g.DrawImage($img, [single]0, [single]0, [single]$bw, [single]$bh)
                    $img.Dispose(); $ms.Dispose()
                }
                'box' {
                    $t = [Math]::Max(1, $it.thick) / $dpm
                    $x1 = $it.x1 / $dpm; $y1 = $it.y1 / $dpm; $x2 = $it.x2 / $dpm; $y2 = $it.y2 / $dpm
                    $g.FillRectangle($black, $x1, $y1, ($x2 - $x1), $t)
                    $g.FillRectangle($black, $x1, ($y2 - $t), ($x2 - $x1), $t)
                    $g.FillRectangle($black, $x1, $y1, $t, ($y2 - $y1))
                    $g.FillRectangle($black, ($x2 - $t), $y1, $t, ($y2 - $y1))
                }
                'bar' {
                    $g.FillRectangle($black, $it.x / $dpm, $it.y / $dpm, $it.w / $dpm, $it.h / $dpm)
                }
            }
            $g.Restore($state)
        }
        $e.HasMorePages = $false
    })

    $doc.Print()
    Write-Output "OK: printed via driver to '$PrinterName'"
    exit 0
} catch {
    $detail = if ($_.Exception.InnerException) { $_.Exception.InnerException.Message } else { $_.Exception.Message }
    [Console]::Error.WriteLine("Print failed: $detail")
    exit 1
}
