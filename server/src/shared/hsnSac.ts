// GST Phase C — HSN/SAC master service. Read-only: HsnCode is global platform reference data
// (CLAUDE.md §11's allow-list), and db-secure.sql grants the runtime role SELECT-only on
// hsn_codes — the same reason masters.router.ts has no HSN route at all. A row can only ever be
// added/changed via a migration (see prisma/migrations/20260930130000_gst_master_services_hsn_code_type),
// never through this service or any request.
//
// Distinct from the ad-hoc `prisma.hsnCode.findMany(...)` calls already in sales.service.ts /
// procurement.service.ts / creditNote.service.ts / debitNote.service.ts — those resolve a specific
// set of codes needed to price a transaction; this module is the general-purpose search/lookup/
// validate surface Customer/Supplier/Product masters and future screens can call directly.
//
// No GST rate is invented here for SAC: this app has no authoritative SAC rate source (see the
// migration's own comment), so searchSAC()/getSAC() simply return whatever SAC rows exist (zero,
// today) rather than fabricate any.

import { prisma } from '../config/database';

export type HsnSacCodeType = 'HSN' | 'SAC';

export interface HsnSacCode {
  code: string;
  description: string | null;
  gstRate: number;
  codeType: HsnSacCodeType;
  defaultUqc: string | null;
  isActive: boolean;
}

export interface SearchOptions {
  limit?: number;
  offset?: number;
}

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit) || limit <= 0) return DEFAULT_LIMIT;
  return Math.min(Math.floor(limit), MAX_LIMIT);
}

function clampOffset(offset: number | undefined): number {
  if (offset === undefined || !Number.isFinite(offset) || offset < 0) return 0;
  return Math.floor(offset);
}

function toHsnSacCode(row: { code: string; description: string | null; gstRate: unknown; codeType: string; defaultUqc: string | null; isActive: boolean }): HsnSacCode {
  return {
    code: row.code,
    description: row.description,
    gstRate: Number(row.gstRate),
    codeType: row.codeType === 'SAC' ? 'SAC' : 'HSN',
    defaultUqc: row.defaultUqc,
    isActive: row.isActive,
  };
}

/**
 * Substring/prefix search over active codes of the given type. Never loads the whole master into
 * memory — the query itself is bounded by `limit`/`offset` (default 25, hard-capped at 100).
 * Matches on the code itself (prefix) or its description (substring), case-insensitive.
 */
async function search(codeType: HsnSacCodeType, query: string | undefined, options: SearchOptions = {}): Promise<{ results: HsnSacCode[]; total: number }> {
  const limit = clampLimit(options.limit);
  const offset = clampOffset(options.offset);
  const q = query?.trim();

  const where = {
    codeType,
    isActive: true,
    ...(q ? { OR: [{ code: { startsWith: q, mode: 'insensitive' as const } }, { description: { contains: q, mode: 'insensitive' as const } }] } : {}),
  };

  const [rows, total] = await Promise.all([
    prisma.hsnCode.findMany({ where, orderBy: { code: 'asc' }, take: limit, skip: offset }),
    prisma.hsnCode.count({ where }),
  ]);

  return { results: rows.map(toHsnSacCode), total };
}

export function searchHSN(query: string | undefined, options?: SearchOptions) {
  return search('HSN', query, options);
}

export function searchSAC(query: string | undefined, options?: SearchOptions) {
  return search('SAC', query, options);
}

async function getByCode(codeType: HsnSacCodeType, code: string): Promise<HsnSacCode | null> {
  const trimmed = code?.trim();
  if (!trimmed) return null;
  const row = await prisma.hsnCode.findFirst({ where: { code: trimmed, codeType } });
  return row ? toHsnSacCode(row) : null;
}

export function getHSN(code: string) {
  return getByCode('HSN', code);
}

export function getSAC(code: string) {
  return getByCode('SAC', code);
}

export interface CodeValidationResult {
  valid: boolean;
  code: string;
  codeType: HsnSacCodeType;
  errors: string[];
}

/**
 * Validates that `code` is a non-empty, active, existing HSN or SAC code of the requested type.
 * Purely a lookup against the master (no format/checksum rules exist for HSN/SAC the way they do
 * for GSTIN) — "valid" here means "resolvable and usable today", not "syntactically well-formed".
 */
export async function validateCode(code: string, codeType: HsnSacCodeType): Promise<CodeValidationResult> {
  const trimmed = code?.trim() ?? '';
  const errors: string[] = [];
  if (trimmed === '') {
    errors.push(`${codeType} code is required`);
    return { valid: false, code: trimmed, codeType, errors };
  }

  const row = await prisma.hsnCode.findFirst({ where: { code: trimmed, codeType } });
  if (!row) {
    errors.push(`"${trimmed}" is not a known ${codeType} code`);
  } else if (!row.isActive) {
    errors.push(`"${trimmed}" is a ${codeType} code but is inactive`);
  }

  return { valid: errors.length === 0, code: trimmed, codeType, errors };
}
