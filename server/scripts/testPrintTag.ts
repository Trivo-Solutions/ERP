// Dev-only CLI to prove Stage 1 end to end on real hardware: load a real tag, generate TSPL for
// it, and send it straight to a Windows-installed TSC TTP-244 Pro via print-raw.ps1's raw byte
// write. Not exposed via any API — this is how alignment/scannability get verified before the
// persistent print agent (Stage 2) exists.
//
// Usage: npm run print:test -- <tagId> [templateId]
// Requires TEST_PRINTER_NAME in server/.env — the printer's exact Windows name (see it with
// `Get-Printer` in PowerShell, or Control Panel > Devices and Printers).

import { config } from 'dotenv';
config();
import path from 'path';
import os from 'os';
import fs from 'fs';
import { spawnSync } from 'child_process';
import { PrismaClient } from '@prisma/client';
import { generateTsplForTag, TagTemplateLayout } from '../src/shared/tsplGenerator';

const prisma = new PrismaClient();

async function main() {
  const [, , tagId, templateId] = process.argv;
  if (!tagId) {
    console.error('Usage: npm run print:test -- <tagId> [templateId]');
    process.exit(1);
  }

  const printerName = process.env.TEST_PRINTER_NAME;
  if (!printerName) {
    console.error("Set TEST_PRINTER_NAME in server/.env to the printer's exact Windows name (see `Get-Printer` in PowerShell).");
    process.exit(1);
  }

  const tag = await prisma.jewelryTag.findUnique({
    where: { id: tagId },
    include: { branch: { select: { name: true } } },
  });
  if (!tag) {
    console.error(`Tag not found: ${tagId}`);
    process.exit(1);
  }

  const template = templateId
    ? await prisma.tagTemplate.findUnique({ where: { id: templateId } })
    : await prisma.tagTemplate.findFirst({ where: { isDefault: true } });
  if (!template) {
    console.error(templateId ? `Template not found: ${templateId}` : 'No default TagTemplate found — run migrations.');
    process.exit(1);
  }

  const tspl = generateTsplForTag(
    {
      widthMm: template.widthMm,
      heightMm: template.heightMm,
      gapMm: template.gapMm,
      layout: template.layout as unknown as TagTemplateLayout,
    },
    tag,
  );

  console.log('--- Generated TSPL ---');
  console.log(tspl);
  console.log('-----------------------');

  const tmpFile = path.join(os.tmpdir(), `tag-${tag.tagNumber}-${Date.now()}.prn`);
  fs.writeFileSync(tmpFile, tspl);

  const psScript = path.resolve(__dirname, 'print-raw.ps1');
  const result = spawnSync('powershell.exe', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', psScript,
    '-PrinterName', printerName, '-FilePath', tmpFile,
  ], { encoding: 'utf-8' });

  if (result.stdout) console.log(result.stdout.trim());
  if (result.stderr) console.error(result.stderr.trim());

  if (result.status !== 0) {
    console.error(`Print failed (exit ${result.status})`);
    process.exit(1);
  }
  console.log(`Printed tag ${tag.tagNumber} using template "${template.name}" to "${printerName}".`);
}

main()
  .then(() => prisma.$disconnect())
  .catch((e) => { console.error(e); prisma.$disconnect(); process.exit(1); });
