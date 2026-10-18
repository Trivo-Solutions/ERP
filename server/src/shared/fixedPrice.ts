import { AppError } from '../middleware/error';

// Category-level pricing mode. WEIGHT_BASED is the original behaviour (metal x live rate + MC + VA + stones).
// FIXED_PRICE_PER_PIECE: the tag carries its own selling price in JewelryTag.sellingPrice - the GST-EXCLUSIVE taxable value of ONE
// piece - and nothing (metal rate, weight, MC, VA, stones) ever recomputes it. GST is added on top at billing by the normal tax engine.
// The mode is snapshotted onto the tag when it is created, so flipping a category later never reprices pieces already tagged.
export const PRICING_MODES = ['WEIGHT_BASED', 'FIXED_PRICE_PER_PIECE'] as const;
export type PricingMode = (typeof PRICING_MODES)[number];
export const FIXED_PRICE_MODE: PricingMode = 'FIXED_PRICE_PER_PIECE';

export const isFixedPrice = (tag: { pricingMode?: string | null } | null | undefined): boolean => tag?.pricingMode === FIXED_PRICE_MODE;

export function assertPricingMode(v: unknown): PricingMode {
  if (typeof v !== 'string' || !(PRICING_MODES as readonly string[]).includes(v)) {
    throw new AppError(`Pricing mode must be one of: ${PRICING_MODES.join(', ')}`, 400);
  }
  return v as PricingMode;
}

/** A fixed per-piece price must be a finite number > 0 (max 2 dp is stored; more is rounded by the column, not silently here). */
export function parseFixedPrice(v: unknown): number {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) {
    throw new AppError('Selling Price per Piece (excluding GST) must be a number greater than 0', 400);
  }
  return Math.round(n * 100) / 100;
}
