// READ-ONLY evidence report: tags whose stored free-text `name` disagrees with the sub-category they currently
// carry (the "MATTU BOWL under BOWL > 3 LEG" class of discrepancy). It writes NOTHING to the database — every
// statement runs inside one `SET TRANSACTION READ ONLY` transaction, which Postgres itself enforces.
//
// It never infers a tag's correct classification and never proposes updates from names alone. It lists facts:
// for each tag the stored name, the current category / sub-category (ids, names, codes), when it was tagged (IST),
// status, branch, its tag_history events (what changed on the tag row, when, by whom), and its print / reprint /
// classification audit rows. Separately it lists the sub-category master rows and links with their created
// timestamps, so the owner can see which masters exist now and when they appeared.
//
// What this CAN'T show (so don't read absence as proof): tag_history records changes to the TAG row only. A
// sub-category master that was renamed or re-coded in place changes no tag row, and before this fix renames were
// not audited — so such a rename is not recoverable from the database. Say "not recoverable", never guess.
//
// Usage (run by someone authorised for the target database; the owner approves running it against production):
//   npx ts-node scripts/reportClassificationDiscrepancy.ts --company OSSP --stored-name "MATTU BOWL" \
//       --category BOWL --sub-code 3LE --out ./classification-report --also SBWL00133,SBWL00134
//
// Connects with PLATFORM_DATABASE_URL (BYPASSRLS, so it can read the tenant's rows) when set, else DATABASE_URL.
// Every query is filtered by the company id resolved from --company. The URL is never printed.
import { config } from 'dotenv';
config();
import { PrismaClient } from '@prisma/client';
import * as fs from 'fs';
import * as path from 'path';

const url = process.env.PLATFORM_DATABASE_URL || process.env.DATABASE_URL;
if (!url) { console.error('Neither PLATFORM_DATABASE_URL nor DATABASE_URL is set.'); process.exit(2); }
const prisma = new PrismaClient({ datasources: { db: { url } } });

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const IST = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
});
const ist = (d: Date | string | null | undefined) => (d ? `${IST.format(new Date(d))} IST` : '');
const csvCell = (v: unknown) => {
  const s = v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const toCsv = (rows: Record<string, unknown>[]) => {
  if (!rows.length) return '';
  const cols = Object.keys(rows[0]);
  return [cols.join(','), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(','))].join('\n') + '\n';
};

async function main() {
  const companyCode = arg('company');
  const storedName = arg('stored-name');
  const categoryCode = arg('category');         // category code OR name
  const subCode = arg('sub-code');              // the sub-category the tags CURRENTLY carry
  const also = (arg('also') ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  const outDir = path.resolve(arg('out') ?? './classification-report');
  if (!companyCode || (!storedName && !also.length)) {
    console.error('Required: --company <code> and at least one of --stored-name <text> / --also <tagNumber,...>');
    process.exit(2);
  }

  const result = await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
    const companies = await tx.$queryRawUnsafe<{ id: string; name: string }[]>('SELECT id, name FROM companies WHERE code = $1', companyCode);
    if (companies.length !== 1) throw new Error(`Company code "${companyCode}" matched ${companies.length} companies`);
    const companyId = companies[0].id;

    const tags = await tx.$queryRawUnsafe<any[]>(
      `SELECT t.id, t."tagNumber", t.name AS stored_name, t.status, t."createdAt", t."updatedAt",
              t."categoryId", c.name AS category_name, c.code AS category_code,
              t."subCategoryId", s.name AS sub_name, s.code AS sub_code, s."isActive" AS sub_active, s."createdAt" AS sub_created,
              b.name AS branch_name, b."branchCode" AS branch_code
         FROM jewelry_tags t
         LEFT JOIN product_categories c ON c.id = t."categoryId" AND c."companyId" = t."companyId"
         LEFT JOIN sub_categories s ON s.id = t."subCategoryId" AND s."companyId" = t."companyId"
         LEFT JOIN branches b ON b.id = t."branchId" AND b."companyId" = t."companyId"
        WHERE t."companyId" = $1
          AND ( ($2::text IS NOT NULL AND lower(btrim(t.name)) = lower(btrim($2))
                 AND ($3::text IS NULL OR upper(c.code) = upper($3) OR upper(c.name) = upper($3))
                 AND ($4::text IS NULL OR upper(s.code) = upper($4)))
                OR t."tagNumber" = ANY($5::text[]) )
        ORDER BY t."tagNumber"`,
      companyId, storedName ?? null, categoryCode ?? null, subCode ?? null, also);

    const tagIds = tags.map((t) => t.id);
    const history = tagIds.length ? await tx.$queryRawUnsafe<any[]>(
      `SELECT h."tagNumber", h.event, h."createdAt", h."changedFields", h.changes, h."actorUserId", u.name AS actor_name
         FROM tag_history h LEFT JOIN users u ON u.id = h."actorUserId"
        WHERE h."companyId" = $1 AND h."tagId" = ANY($2::text[])
        ORDER BY h."tagNumber", h."createdAt"`, companyId, tagIds) : [];
    const audits = tagIds.length ? await tx.$queryRawUnsafe<any[]>(
      `SELECT a."recordId", a.action, a."timestamp", a."userId", u.name AS actor_name, a."oldValues", a."newValues"
         FROM audit_logs a LEFT JOIN users u ON u.id = a."userId"
        WHERE a."companyId" = $1 AND a."tableName" = 'jewelry_tags' AND a."recordId" = ANY($2::text[])
        ORDER BY a."recordId", a."timestamp"`, companyId, tagIds) : [];
    const subMasters = await tx.$queryRawUnsafe<any[]>(
      `SELECT s.id, s.code, s.name, s."isActive", s."createdAt",
              (SELECT string_agg(c.code, ';' ORDER BY c.code) FROM category_sub_categories l JOIN product_categories c ON c.id = l."categoryId" WHERE l."subCategoryId" = s.id AND l."companyId" = s."companyId") AS linked_categories,
              (SELECT count(*) FROM jewelry_tags t WHERE t."subCategoryId" = s.id AND t."companyId" = s."companyId")::int AS tags_using
         FROM sub_categories s WHERE s."companyId" = $1 ORDER BY s."createdAt"`, companyId);
    const masterAudits = await tx.$queryRawUnsafe<any[]>(
      `SELECT a."tableName", a."recordId", a.action, a."timestamp", u.name AS actor_name, a."oldValues", a."newValues"
         FROM audit_logs a LEFT JOIN users u ON u.id = a."userId"
        WHERE a."companyId" = $1 AND a."tableName" IN ('sub_categories','category_sub_categories','product_categories')
        ORDER BY a."timestamp"`, companyId);
    const tpls = await tx.$queryRawUnsafe<any[]>(
      `SELECT id, name, "isDefault", "updatedAt", layout FROM tag_templates WHERE "companyId" = $1 ORDER BY "isDefault" DESC, name`, companyId);
    return { companyId, companyName: companies[0].name, tags, history, audits, subMasters, masterAudits, tpls };
  });

  // Which template elements print a classification, and from where.
  const templateBindings = result.tpls.flatMap((t: any) => ((t.layout?.elements ?? []) as any[])
    .filter((e) => ['name', 'categoryName', 'categoryCode', 'subCategoryName', 'subCategoryCode'].includes(e.boundField) || (!e.boundField && e.literalText))
    .map((e) => ({
      template: t.name, isDefault: t.isDefault, templateUpdatedAt: ist(t.updatedAt), element: e.id, wing: e.wing,
      source: e.boundField ? `field:${e.boundField}` : 'STATIC TEXT', literalText: e.boundField ? '' : e.literalText,
    })));

  const tagRows = result.tags.map((t: any) => ({
    tagNumber: t.tagNumber, tagId: t.id, storedName: t.stored_name,
    categoryId: t.categoryId, category: t.category_name, categoryCode: t.category_code,
    subCategoryId: t.subCategoryId, subCategory: t.sub_name, subCategoryCode: t.sub_code, subCategoryActive: t.sub_active,
    subCategoryMasterCreatedIST: ist(t.sub_created), taggedIST: ist(t.createdAt), lastUpdatedIST: ist(t.updatedAt),
    status: t.status, branch: t.branch_name, branchCode: t.branch_code,
    nameMatchesCurrentSubCategory: (t.stored_name ?? '').trim().toLowerCase() === (t.sub_name ?? '').trim().toLowerCase(),
    historyEvents: result.history.filter((h: any) => h.tagNumber === t.tagNumber).length,
    printAuditRows: result.audits.filter((a: any) => a.recordId === t.id && /PRINT/.test(a.action)).length,
  }));
  const histRows = result.history.map((h: any) => ({ tagNumber: h.tagNumber, event: h.event, atIST: ist(h.createdAt), changedFields: (h.changedFields ?? []).join(';'), changes: h.changes, actor: h.actor_name ?? h.actorUserId ?? '' }));
  const auditRows = result.audits.map((a: any) => ({ tagId: a.recordId, action: a.action, atIST: ist(a.timestamp), actor: a.actor_name ?? a.userId, oldValues: a.oldValues, newValues: a.newValues }));
  const masterRows = result.subMasters.map((s: any) => ({ id: s.id, code: s.code, name: s.name, active: s.isActive, createdIST: ist(s.createdAt), linkedCategories: s.linked_categories, tagsUsing: s.tags_using }));
  const masterAuditRows = result.masterAudits.map((a: any) => ({ table: a.tableName, recordId: a.recordId, action: a.action, atIST: ist(a.timestamp), actor: a.actor_name ?? '', oldValues: a.oldValues, newValues: a.newValues }));

  fs.mkdirSync(outDir, { recursive: true });
  const write = (name: string, rows: Record<string, unknown>[]) => fs.writeFileSync(path.join(outDir, name), '﻿' + toCsv(rows));
  write('1_tags.csv', tagRows);
  write('2_tag_history.csv', histRows);
  write('3_tag_audit_rows.csv', auditRows);
  write('4_subcategory_masters.csv', masterRows);
  write('5_master_audit_rows.csv', masterAuditRows);
  write('6_template_bindings.csv', templateBindings);
  fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify({
    generatedAtIST: ist(new Date()), company: result.companyName, readOnly: true,
    filters: { storedName, category: categoryCode, currentSubCode: subCode, also },
    tagCount: tagRows.length,
    note: 'Facts only. A master renamed before the audit fix is not recoverable from the database; nothing here proposes a classification.',
  }, null, 2));
  console.log(`Read-only report written to ${outDir}: ${tagRows.length} tag(s), ${histRows.length} history row(s), ${auditRows.length} audit row(s), ${masterRows.length} sub-category master(s).`);
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); }).finally(() => prisma.$disconnect());
