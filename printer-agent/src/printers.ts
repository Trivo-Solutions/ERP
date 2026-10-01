import { runPowerShell } from './shell';

// Windows installs these on nearly every machine by default. If they weren't excluded, "exactly
// one real printer installed" (the case that lets setup auto-select with zero clicks) would
// almost never hold, since most PCs would show 2-4 "printers" before the label printer is even
// counted.
const VIRTUAL_PRINTER_PATTERN = /^(Microsoft Print to PDF|Microsoft XPS Document Writer|Fax|OneNote)/i;

export async function listInstalledPrinters(): Promise<string[]> {
  const { code, stdout } = await runPowerShell([
    '-Command',
    'Get-CimInstance -ClassName Win32_Printer | Select-Object -ExpandProperty Name | ConvertTo-Json -Compress',
  ]);
  if (code !== 0 || !stdout.trim()) return [];
  try {
    const parsed = JSON.parse(stdout.trim());
    const names: string[] = Array.isArray(parsed) ? parsed : [parsed];
    return names.filter((n): n is string => typeof n === 'string' && n.length > 0);
  } catch {
    return [];
  }
}

export async function listRealPrinters(): Promise<string[]> {
  const all = await listInstalledPrinters();
  return all.filter((name) => !VIRTUAL_PRINTER_PATTERN.test(name));
}
