// G2g-7e — GSTR-2B source normalization layer (brief §5). Pure, synchronous, no Prisma, no
// Date.now(), no network. Transforms an arbitrary parsed GSTN GSTR-2B JSON payload into a stable,
// internal `Gstr2bNormalizedDocument[]` the rest of this phase operates on.
//
// CONFIDENCE STATEMENT (see PHASE_G2G7E_AUDIT.md §2 for the full read-only audit this is built
// against — same posture as this codebase's existing `shared/gstin.ts`/`shared/gstUqc.ts`
// disclaimers): the exact GSTN wire JSON field spelling below is a best-effort reconstruction from
// converging secondary technical sources, not a byte-exact official schema fetched this session.
// Two design choices exist specifically to make that uncertainty safe rather than silently wrong:
//
//   1. This function is deliberately LIBERAL about field-name variants (several candidate keys are
//      tried per value) but NEVER invents a value it found no candidate for — a field that cannot
//      be confidently located is left `null`, and a document missing a genuinely required fact
//      (document number, or every taxable/tax amount) is still emitted, flagged with a diagnostic,
//      never silently dropped (a government source statement must remain reproducible — brief §25).
//   2. The caller (`gstr2bImport.service.ts`) ALWAYS persists the complete original parsed JSON
//      verbatim (`Gst2bStatement.rawPayload`) regardless of how well this function understood it,
//      and stamps a `normalizerVersion` — so a future correction to the field-mapping below is a
//      documented RE-NORMALIZATION of already-preserved source data, never a re-import.
//
// Verify the mapping below against a real portal-downloaded GSTR-2B JSON file before relying on
// this for a live filing/reconciliation decision.

import { normalizeGstin } from '../../../shared/gstin';
import type {
  Gstr2bDocumentType,
  Gstr2bItcAvailability,
  Gstr2bNormalizationDiagnostic,
  Gstr2bNormalizationResult,
  Gstr2bNormalizedDocument,
  Gstr2bSection,
  Gstr2bSupportStatus,
} from './gstr2b.types';

export const GSTR2B_NORMALIZER_VERSION = 'g2g7e-v1';

export class Gstr2bNormalizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'Gstr2bNormalizationError';
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Low-level helpers — liberal field-name lookup, never guessing a VALUE.
// ─────────────────────────────────────────────────────────────────────────────

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function firstString(obj: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'string' && v.trim() !== '') return v.trim();
  }
  return null;
}

function firstNumber(obj: Record<string, unknown>, keys: string[]): number | null {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  }
  return null;
}

function firstArray(obj: Record<string, unknown>, keys: string[]): unknown[] | null {
  for (const k of keys) {
    const v = obj[k];
    if (Array.isArray(v)) return v;
  }
  return null;
}

/** GSTN's own convention is DD-MM-YYYY. Never throws — unparseable input returns null, reported by
 *  the caller as a diagnostic rather than silently defaulting to "now" or an invalid Date. */
function parseGstnDate(raw: string | null): Date | null {
  if (!raw) return null;
  const m = /^(\d{2})-(\d{2})-(\d{4})$/.exec(raw.trim());
  if (m) {
    const [, dd, mm, yyyy] = m;
    const d = new Date(Date.UTC(Number(yyyy), Number(mm) - 1, Number(dd)));
    if (!Number.isNaN(d.getTime())) return d;
    return null;
  }
  // Tolerate an already-ISO date too (some GSP/export tools re-serialize GSTN JSON with ISO dates).
  const iso = new Date(raw);
  return Number.isNaN(iso.getTime()) ? null : iso;
}

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

function sumItems(items: unknown[] | null): { taxableValue: number; igst: number; cgst: number; sgst: number; cess: number } {
  const totals = { taxableValue: 0, igst: 0, cgst: 0, sgst: 0, cess: 0 };
  if (!items) return totals;
  for (const raw of items) {
    if (!isObj(raw)) continue;
    totals.taxableValue = round2(totals.taxableValue + (firstNumber(raw, ['txval', 'taxableValue', 'taxable_value']) ?? 0));
    totals.igst = round2(totals.igst + (firstNumber(raw, ['iamt', 'igst']) ?? 0));
    totals.cgst = round2(totals.cgst + (firstNumber(raw, ['camt', 'cgst']) ?? 0));
    totals.sgst = round2(totals.sgst + (firstNumber(raw, ['samt', 'sgst']) ?? 0));
    totals.cess = round2(totals.cess + (firstNumber(raw, ['csamt', 'cess']) ?? 0));
  }
  return totals;
}

function resolveItcAvailability(raw: Record<string, unknown>): Gstr2bItcAvailability | null {
  const flag = firstString(raw, ['itcavl', 'itc_avl', 'itcAvailability']);
  if (flag === 'Y') return 'AVAILABLE';
  if (flag === 'N') return 'NOT_AVAILABLE';
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-document normalization
// ─────────────────────────────────────────────────────────────────────────────

function normalizeOneDocument(
  section: Gstr2bSection,
  documentType: Gstr2bDocumentType,
  supportStatus: Gstr2bSupportStatus,
  supplierGstin: string | null,
  supplierTradeName: string | null,
  raw: Record<string, unknown>,
  diagnostics: Gstr2bNormalizationDiagnostic[],
): Gstr2bNormalizedDocument {
  const documentNumber = firstString(raw, ['inum', 'invoiceNumber', 'bono', 'boe_num', 'docNum']);
  const documentDateRaw = firstString(raw, ['dt', 'idt', 'date', 'boe_dt', 'docDate']);
  const documentDate = parseGstnDate(documentDateRaw);
  const documentValue = firstNumber(raw, ['val', 'invoiceValue', 'assval', 'txval']);
  const placeOfSupply = firstString(raw, ['pos', 'placeOfSupply']);
  const reverseChargeFlag = firstString(raw, ['rev', 'reverseCharge']);
  const items = firstArray(raw, ['itms', 'items']);
  const itemTotals = sumItems(items);
  // Some records carry totals at the document level instead of (or in addition to) an items array —
  // prefer the items-array sum when present (it is the more granular, authoritative figure the
  // official statement actually itemizes), falling back to document-level fields only when no items
  // array exists at all.
  const hasItemTotals = !!items && items.length > 0;
  const taxableValue = hasItemTotals ? itemTotals.taxableValue : (firstNumber(raw, ['txval', 'taxableValue']) ?? 0);
  const igst = hasItemTotals ? itemTotals.igst : (firstNumber(raw, ['iamt', 'igst']) ?? 0);
  const cgst = hasItemTotals ? itemTotals.cgst : (firstNumber(raw, ['camt', 'cgst']) ?? 0);
  const sgst = hasItemTotals ? itemTotals.sgst : (firstNumber(raw, ['samt', 'sgst']) ?? 0);
  const cess = hasItemTotals ? itemTotals.cess : (firstNumber(raw, ['csamt', 'cess']) ?? 0);

  const amendsDocumentNumber = firstString(raw, ['og_num', 'ogn', 'original_number', 'org_num', 'oinum']);
  const amendsDocumentDateRaw = firstString(raw, ['og_dt', 'ogdt', 'original_date', 'org_dt']);
  const amendsDocumentDate = parseGstnDate(amendsDocumentDateRaw);

  if (!documentNumber) {
    diagnostics.push({
      section,
      code: 'MISSING_DOCUMENT_NUMBER',
      reason: `A ${section} record for supplier ${supplierGstin ?? '(unknown GSTIN)'} has no recognizable document/invoice number field — preserved with documentNumber=null rather than dropped.`,
      rawRecord: raw,
    });
  }
  if (taxableValue === 0 && igst === 0 && cgst === 0 && sgst === 0 && cess === 0) {
    diagnostics.push({
      section,
      code: 'MISSING_TAXABLE_AMOUNTS',
      reason: `A ${section} record for supplier ${supplierGstin ?? '(unknown GSTIN)'}${documentNumber ? ` / document ${documentNumber}` : ''} has no recognizable taxable-value or tax-amount fields — recorded as all-zero rather than guessed.`,
      rawRecord: raw,
    });
  }

  return {
    section,
    documentType,
    supplierGstin,
    supplierTradeName,
    documentNumber,
    documentDate,
    documentValue,
    placeOfSupply,
    taxableValue,
    igst,
    cgst,
    sgst,
    cess,
    reverseCharge: reverseChargeFlag === 'Y',
    itcAvailability: resolveItcAvailability(raw),
    ineligibilityReason: firstString(raw, ['itc_rmrk', 'itcRemark', 'ineligibilityReason']),
    amendsDocumentNumber,
    amendsDocumentDate,
    supportStatus,
    rawRecord: raw,
  };
}

function normalizeSupplierGroupedSection(
  section: Gstr2bSection,
  documentType: Gstr2bDocumentType,
  supportStatus: Gstr2bSupportStatus,
  groups: unknown[] | null,
  diagnostics: Gstr2bNormalizationDiagnostic[],
): Gstr2bNormalizedDocument[] {
  if (!groups) return [];
  const out: Gstr2bNormalizedDocument[] = [];
  for (const group of groups) {
    if (!isObj(group)) {
      diagnostics.push({ section, code: 'UNRECOGNIZED_RECORD_SHAPE', reason: `A ${section} supplier group was not an object — skipped.`, rawRecord: group });
      continue;
    }
    const supplierGstin = normalizeGstin(firstString(group, ['ctin', 'gstin', 'supplierGstin']) ?? '') || null;
    const supplierTradeName = firstString(group, ['trdnm', 'tradeName', 'supplierTradeName']);
    // B2B/B2BA nest invoices under 'inv'; CDNR/CDNRA commonly nest notes under 'nt' — accept both,
    // since this is exactly the kind of section-specific key-naming divergence §2's confidence
    // caveat exists for.
    const docs = firstArray(group, ['inv', 'nt', 'docs']) ?? [];
    for (const raw of docs) {
      if (!isObj(raw)) {
        diagnostics.push({ section, code: 'UNRECOGNIZED_RECORD_SHAPE', reason: `A ${section} document under supplier ${supplierGstin ?? '(unknown)'} was not an object — skipped.`, rawRecord: raw });
        continue;
      }
      out.push(normalizeOneDocument(section, documentType, supportStatus, supplierGstin, supplierTradeName, raw, diagnostics));
    }
  }
  return out;
}

// IMPG/IMPGSEZ/ISD/ISDA do not share the ctin-grouped B2B shape (imports have no domestic supplier
// GSTIN at all; ISD entries key off the ISD's own GSTIN as a flat list) — normalized minimally,
// preserved faithfully, never reconciled (brief §7/§8).
function normalizeFlatSection(
  section: Gstr2bSection,
  documentType: Gstr2bDocumentType,
  supportStatus: Gstr2bSupportStatus,
  entries: unknown[] | null,
  diagnostics: Gstr2bNormalizationDiagnostic[],
): Gstr2bNormalizedDocument[] {
  if (!entries) return [];
  const out: Gstr2bNormalizedDocument[] = [];
  for (const raw of entries) {
    if (!isObj(raw)) {
      diagnostics.push({ section, code: 'UNRECOGNIZED_RECORD_SHAPE', reason: `A ${section} entry was not an object — skipped.`, rawRecord: raw });
      continue;
    }
    const supplierGstin = normalizeGstin(firstString(raw, ['ctin', 'gstin', 'isdGstin']) ?? '') || null;
    const supplierTradeName = firstString(raw, ['trdnm', 'tradeName']);
    out.push(normalizeOneDocument(section, documentType, supportStatus, supplierGstin, supplierTradeName, raw, diagnostics));
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Public entry point
// ─────────────────────────────────────────────────────────────────────────────

export function normalizeGstr2bPayload(raw: unknown): Gstr2bNormalizationResult {
  if (!isObj(raw)) {
    throw new Gstr2bNormalizationError('The uploaded GSTR-2B payload is not a JSON object — nothing to normalize.');
  }

  const diagnostics: Gstr2bNormalizationDiagnostic[] = [];
  const data = isObj(raw.data) ? raw.data : raw;

  const gstin = normalizeGstin(firstString(raw, ['gstin']) ?? firstString(data, ['gstin']) ?? '') || null;
  if (!gstin) {
    diagnostics.push({ section: 'META', code: 'GSTIN_META_UNRESOLVED', reason: 'Could not locate the statement\'s own GSTIN at the top level or under "data" — the import route\'s own GSTIN-vs-registration cross-check cannot run for this payload.' });
  }

  const taxPeriodRaw = firstString(raw, ['fp', 'rtnprd']) ?? firstString(data, ['fp', 'rtnprd', 'ret_period']);
  let taxPeriod: string | null = null;
  if (taxPeriodRaw) {
    if (/^\d{6}$/.test(taxPeriodRaw)) taxPeriod = taxPeriodRaw;
    else if (/^\d{2}[-/]\d{4}$/.test(taxPeriodRaw)) taxPeriod = taxPeriodRaw.replace(/[-/]/, '');
  }
  if (!taxPeriod) {
    diagnostics.push({ section: 'META', code: 'TAX_PERIOD_UNRESOLVED', reason: 'Could not resolve a MMYYYY tax period from the payload\'s own metadata ("fp"/"rtnprd") — the caller must supply one explicitly.' });
  }

  const generatedAtRaw = firstString(raw, ['gendt']) ?? firstString(data, ['gendt']);
  const generatedAt = parseGstnDate(generatedAtRaw);

  const docdata = isObj(data.docdata) ? data.docdata : isObj(raw.docdata) ? raw.docdata : data;

  const documents: Gstr2bNormalizedDocument[] = [
    ...normalizeSupplierGroupedSection('B2B', 'INVOICE', 'SUPPORTED', firstArray(docdata, ['b2b']), diagnostics),
    ...normalizeSupplierGroupedSection('B2BA', 'INVOICE', 'SUPPORTED', firstArray(docdata, ['b2ba']), diagnostics),
    ...normalizeSupplierGroupedSection('CDNR', 'CREDIT_NOTE', 'SUPPORTED', firstArray(docdata, ['cdnr']), diagnostics),
    ...normalizeSupplierGroupedSection('CDNRA', 'CREDIT_NOTE', 'SUPPORTED', firstArray(docdata, ['cdnra']), diagnostics),
    ...normalizeFlatSection('ISD', 'ISD_INVOICE', 'ISD_NOT_SUPPORTED', firstArray(docdata, ['isd']), diagnostics),
    ...normalizeFlatSection('ISDA', 'ISD_INVOICE', 'ISD_NOT_SUPPORTED', firstArray(docdata, ['isda']), diagnostics),
    ...normalizeFlatSection('IMPG', 'IMPORT_BOE', 'IMPORTS_NOT_RECONCILABLE', firstArray(docdata, ['impg']), diagnostics),
    ...normalizeFlatSection('IMPGSEZ', 'IMPORT_BOE', 'IMPORTS_NOT_RECONCILABLE', firstArray(docdata, ['impgsez']), diagnostics),
  ];

  return {
    meta: { gstin, taxPeriod, generatedAt },
    documents,
    diagnostics,
  };
}
