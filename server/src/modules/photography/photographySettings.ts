// Company-level Photography settings. Stored in the existing per-company SystemConfig table as ONE JSON row
// (key PHOTOGRAPHY_SETTINGS_KEY, category PHOTOGRAPHY) — no second settings framework, no migration. Scope is the
// company; the row shape (one JSON document, defaults merged at read) leaves room for a later branch / station
// override layer without a schema change.
//
// What is configurable lives HERE and nowhere else. Constants in this file are TECHNICAL SAFETY LIMITS (bounds a
// setting may take), not business defaults — a bound exists so a typo cannot ask the server for a 100 000 px image.
import { z } from 'zod';
import { AppError } from '../../middleware/error';
import { createAuditEntry } from '../../middleware/audit';
import { tenantQuery, type TenantContext } from '../../shared/tenantContext';

export const PHOTOGRAPHY_SETTINGS_KEY = 'photography.settings';
export const PHOTOGRAPHY_SETTINGS_CATEGORY = 'PHOTOGRAPHY';

/** Controlled vocabulary — a client can never inject a format the processor does not handle. */
export const OUTPUT_FORMATS = ['WEBP', 'JPEG'] as const;
export type OutputFormat = (typeof OUTPUT_FORMATS)[number];

export interface PhotographySettings {
  // optimized image
  generateOptimized: boolean;
  targetOptimizedSizeKB: number;
  minimumQuality: number;
  maximumQuality: number;
  maximumWidth: number;
  maximumHeight: number;
  /** Size-targeting never shrinks the long edge below this; if the target still is not met the best result is kept. */
  minimumLongEdge: number;
  optimizedFormat: OutputFormat;
  // thumbnail
  generateThumbnail: boolean;
  thumbnailWidth: number;
  thumbnailHeight: number;
  /** false = fit inside the box keeping aspect ratio; true = crop to fill the box exactly. */
  thumbnailCrop: boolean;
  thumbnailFormat: OutputFormat;
  thumbnailQuality: number;
  // original
  /** Always true today: TagImage requires its original object. Reserved so the contract does not change later. */
  keepOriginal: boolean;
  // image handling
  autoOrient: boolean;
  /** Pixel-count guard for the decoder (width × height). A bigger source is refused for processing, never deleted. */
  maxInputWidth: number;
  maxInputHeight: number;
}

export const DEFAULT_PHOTOGRAPHY_SETTINGS: Readonly<PhotographySettings> = Object.freeze({
  generateOptimized: true,
  targetOptimizedSizeKB: 500,
  minimumQuality: 55,
  maximumQuality: 85,
  maximumWidth: 2400,
  maximumHeight: 2400,
  minimumLongEdge: 800,
  optimizedFormat: 'WEBP',
  generateThumbnail: true,
  thumbnailWidth: 300,
  thumbnailHeight: 300,
  thumbnailCrop: false,
  thumbnailFormat: 'WEBP',
  thumbnailQuality: 75,
  keepOriginal: true,
  autoOrient: true,
  maxInputWidth: 12000,
  maxInputHeight: 12000,
});

/** Technical bounds each numeric setting must stay within (inclusive). */
export const SETTING_LIMITS = {
  targetOptimizedSizeKB: [50, 10_240],
  minimumQuality: [10, 100],
  maximumQuality: [10, 100],
  maximumWidth: [200, 10_000],
  maximumHeight: [200, 10_000],
  minimumLongEdge: [200, 10_000],
  thumbnailWidth: [32, 1000],
  thumbnailHeight: [32, 1000],
  thumbnailQuality: [30, 95],
  maxInputWidth: [1000, 30_000],
  maxInputHeight: [1000, 30_000],
} as const;

const int = (key: keyof typeof SETTING_LIMITS) => {
  const [min, max] = SETTING_LIMITS[key];
  return z.number({ invalid_type_error: `${key} must be a number` }).int(`${key} must be a whole number`)
    .min(min, `${key} must be at least ${min}`).max(max, `${key} must be at most ${max}`);
};
const fmt = z.enum(OUTPUT_FORMATS, { errorMap: () => ({ message: `format must be one of ${OUTPUT_FORMATS.join(', ')}` }) });

/** Field-level shape. `.strict()` rejects unknown keys — including a client-supplied companyId. */
const fieldShape = {
  generateOptimized: z.boolean(),
  targetOptimizedSizeKB: int('targetOptimizedSizeKB'),
  minimumQuality: int('minimumQuality'),
  maximumQuality: int('maximumQuality'),
  maximumWidth: int('maximumWidth'),
  maximumHeight: int('maximumHeight'),
  minimumLongEdge: int('minimumLongEdge'),
  optimizedFormat: fmt,
  generateThumbnail: z.boolean(),
  thumbnailWidth: int('thumbnailWidth'),
  thumbnailHeight: int('thumbnailHeight'),
  thumbnailCrop: z.boolean(),
  thumbnailFormat: fmt,
  thumbnailQuality: int('thumbnailQuality'),
  keepOriginal: z.literal(true, { errorMap: () => ({ message: 'keepOriginal must be true: every photo needs its original object' }) }),
  autoOrient: z.boolean(),
  maxInputWidth: int('maxInputWidth'),
  maxInputHeight: int('maxInputHeight'),
};
export const settingsPatchSchema = z.object(fieldShape).partial().strict();

/** Cross-field rules, applied to the MERGED document. Returns the first problem, or null. */
export function crossFieldProblem(s: PhotographySettings): string | null {
  if (s.minimumQuality > s.maximumQuality) return 'minimumQuality cannot be greater than maximumQuality';
  if (s.minimumLongEdge > Math.max(s.maximumWidth, s.maximumHeight)) return 'minimumLongEdge cannot exceed the larger of maximumWidth / maximumHeight';
  if (s.maxInputWidth < s.maximumWidth || s.maxInputHeight < s.maximumHeight) return 'maxInputWidth / maxInputHeight cannot be smaller than maximumWidth / maximumHeight';
  return null;
}

/** Defaults + a stored document. Anything stored that no longer validates falls back to its default, never throws. */
export function resolveSettings(stored: unknown): { settings: PhotographySettings; usingDefaults: boolean } {
  if (!stored || typeof stored !== 'object') return { settings: { ...DEFAULT_PHOTOGRAPHY_SETTINGS }, usingDefaults: true };
  const merged: Record<string, unknown> = { ...DEFAULT_PHOTOGRAPHY_SETTINGS };
  for (const [k, schema] of Object.entries(fieldShape)) {
    const v = (stored as Record<string, unknown>)[k];
    if (v !== undefined && schema.safeParse(v).success) merged[k] = v;
  }
  const settings = merged as unknown as PhotographySettings;
  if (crossFieldProblem(settings)) return { settings: { ...DEFAULT_PHOTOGRAPHY_SETTINGS }, usingDefaults: true };
  return { settings, usingDefaults: false };
}

async function readStored(companyId: string): Promise<unknown> {
  const row = await tenantQuery(companyId, (tx) => tx.systemConfig.findFirst({
    where: { companyId, key: PHOTOGRAPHY_SETTINGS_KEY }, select: { value: true },
  }));
  if (!row) return null;
  try { return JSON.parse(row.value); } catch { return null; }
}

/** The settings in force for a company (used by processing). Never throws on a damaged row — defaults apply. */
export async function loadPhotographySettings(companyId: string): Promise<PhotographySettings> {
  return resolveSettings(await readStored(companyId)).settings;
}

export async function getPhotographySettings(ctx: TenantContext) {
  const stored = await readStored(ctx.companyId);
  const { settings, usingDefaults } = resolveSettings(stored);
  return {
    settings, defaults: DEFAULT_PHOTOGRAPHY_SETTINGS, limits: SETTING_LIMITS,
    formats: OUTPUT_FORMATS, usingDefaults: usingDefaults && !stored,
  };
}

/** PUT semantics: the supplied fields are validated and merged over the current settings; omitted fields keep their value. */
export async function updatePhotographySettings(ctx: TenantContext, body: unknown) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new AppError('Request body must be a settings object', 400);
  const parsed = settingsPatchSchema.safeParse(body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const msg = issue.code === 'unrecognized_keys' ? `Unknown setting: ${(issue as { keys: string[] }).keys.join(', ')}` : issue.message;
    throw new AppError(msg, 400);
  }
  const before = (await getPhotographySettings(ctx)).settings;
  const next: PhotographySettings = { ...before, ...parsed.data } as PhotographySettings;
  const problem = crossFieldProblem(next);
  if (problem) throw new AppError(problem, 400);

  const value = JSON.stringify(next);
  const row = await tenantQuery(ctx.companyId, (tx) => tx.systemConfig.upsert({
    where: { companyId_key: { companyId: ctx.companyId, key: PHOTOGRAPHY_SETTINGS_KEY } },
    create: { companyId: ctx.companyId, key: PHOTOGRAPHY_SETTINGS_KEY, value, category: PHOTOGRAPHY_SETTINGS_CATEGORY },
    update: { value },
    select: { id: true },
  }));
  await createAuditEntry('system_configs', row.id, ctx.userId, 'UPDATE', { photographySettings: before }, { photographySettings: next }, ctx.companyId);
  return getPhotographySettings(ctx);
}
