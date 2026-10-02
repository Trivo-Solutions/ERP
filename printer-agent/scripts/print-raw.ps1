<#
  Sends a file's raw bytes straight to a Windows-installed printer's spooler queue using the
  RAW datatype (Win32 winspool.drv OpenPrinter/StartDocPrinter/WritePrinter — the classic
  Microsoft KB Q322091 pattern), bypassing the driver's normal GDI text/graphics rendering.
  This is required for TSPL: if the print went through the driver's usual rendering path
  instead, the driver could reinterpret or mangle the raw command bytes.

  No native Node module / build toolchain needed on the machine running this, and no need to
  share the printer — only that it's already installed under Windows with the name passed
  below (Control Panel > Printers, or `Get-Printer` to list).

  Usage: powershell -NoProfile -ExecutionPolicy Bypass -File print-raw.ps1 -PrinterName "TSC TTP-244 Pro" -FilePath C:\path\to\label.prn
#>
param(
    [Parameter(Mandatory = $true)][string]$PrinterName,
    [Parameter(Mandatory = $true)][string]$FilePath
)

$ErrorActionPreference = 'Stop'

$signature = @'
using System;
using System.Runtime.InteropServices;

public class RawPrinterHelper
{
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Ansi)]
    public class DOCINFOA
    {
        [MarshalAs(UnmanagedType.LPStr)] public string pDocName;
        [MarshalAs(UnmanagedType.LPStr)] public string pOutputFile;
        [MarshalAs(UnmanagedType.LPStr)] public string pDataType;
    }

    [DllImport("winspool.drv", EntryPoint = "OpenPrinterA", SetLastError = true, CharSet = CharSet.Ansi, ExactSpelling = true, CallingConvention = CallingConvention.StdCall)]
    public static extern bool OpenPrinter(string szPrinter, out IntPtr hPrinter, IntPtr pd);

    [DllImport("winspool.drv", EntryPoint = "ClosePrinter", SetLastError = true, ExactSpelling = true, CallingConvention = CallingConvention.StdCall)]
    public static extern bool ClosePrinter(IntPtr hPrinter);

    [DllImport("winspool.drv", EntryPoint = "StartDocPrinterA", SetLastError = true, CharSet = CharSet.Ansi, ExactSpelling = true, CallingConvention = CallingConvention.StdCall)]
    public static extern int StartDocPrinter(IntPtr hPrinter, int level, [In, MarshalAs(UnmanagedType.LPStruct)] DOCINFOA di);

    [DllImport("winspool.drv", EntryPoint = "EndDocPrinter", SetLastError = true, ExactSpelling = true, CallingConvention = CallingConvention.StdCall)]
    public static extern bool EndDocPrinter(IntPtr hPrinter);

    [DllImport("winspool.drv", EntryPoint = "StartPagePrinter", SetLastError = true, ExactSpelling = true, CallingConvention = CallingConvention.StdCall)]
    public static extern bool StartPagePrinter(IntPtr hPrinter);

    [DllImport("winspool.drv", EntryPoint = "EndPagePrinter", SetLastError = true, ExactSpelling = true, CallingConvention = CallingConvention.StdCall)]
    public static extern bool EndPagePrinter(IntPtr hPrinter);

    [DllImport("winspool.drv", EntryPoint = "WritePrinter", SetLastError = true, ExactSpelling = true, CallingConvention = CallingConvention.StdCall)]
    public static extern bool WritePrinter(IntPtr hPrinter, byte[] pBytes, int dwCount, out int dwWritten);

    public static void SendBytesToPrinter(string szPrinterName, byte[] pBytes)
    {
        IntPtr hPrinter;
        DOCINFOA di = new DOCINFOA();
        int dwWritten = 0;
        bool bSuccess = false;
        di.pDocName = "TSPL Raw Print Job";
        di.pDataType = "RAW";

        if (!OpenPrinter(szPrinterName, out hPrinter, IntPtr.Zero))
            throw new Exception("OpenPrinter failed for '" + szPrinterName + "'. Win32 error: " + Marshal.GetLastWin32Error());

        try
        {
            if (StartDocPrinter(hPrinter, 1, di) == 0)
                throw new Exception("StartDocPrinter failed. Win32 error: " + Marshal.GetLastWin32Error());

            // No StartPagePrinter/EndPagePrinter: those frame a drawn page, and TSC's "Dynamic Print
            // Monitor" port can lock the printer up when a raw TSPL stream is wrapped in them.
            bSuccess = WritePrinter(hPrinter, pBytes, pBytes.Length, out dwWritten);
            EndDocPrinter(hPrinter);

            if (!bSuccess)
                throw new Exception("WritePrinter failed. Win32 error: " + Marshal.GetLastWin32Error());
            if (dwWritten != pBytes.Length)
                throw new Exception("WritePrinter wrote " + dwWritten + " of " + pBytes.Length + " bytes.");
        }
        finally
        {
            ClosePrinter(hPrinter);
        }
    }
}
'@

Add-Type -TypeDefinition $signature -Language CSharp

if (-not (Test-Path -LiteralPath $FilePath)) {
    Write-Error "File not found: $FilePath"
    exit 1
}

$bytes = [System.IO.File]::ReadAllBytes($FilePath)

try {
    [RawPrinterHelper]::SendBytesToPrinter($PrinterName, $bytes)
    Write-Output "OK: sent $($bytes.Length) bytes to '$PrinterName'"
    exit 0
} catch {
    # Plain stderr write, not Write-Error — Write-Error's default host formatting spans several
    # lines (At/CategoryInfo/FullyQualifiedErrorId noise) that a caller parsing stderr for the
    # actual message shouldn't have to strip out. The real message is on InnerException — a
    # call into the C# helper surfaces here as a wrapping MethodInvocationException first.
    $detail = if ($_.Exception.InnerException) { $_.Exception.InnerException.Message } else { $_.Exception.Message }
    [Console]::Error.WriteLine("Print failed: $detail")
    exit 1
}
