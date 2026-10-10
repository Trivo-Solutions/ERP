import { AppError } from '../middleware/error';

// A tag can only be quoted or sold from its own data when its SALE rates exist. Gold is the one live element (read from the
// metal-rate table every time), so a METAL row's stored rate is irrelevant; everything else the price is built from must be
// present on the tag: the making-charge rate, the VA %, and a sale rate on every non-metal row (stones etc). A missing value is
// never read as 0 and never filled from "today's" anything - the piece is refused until its rates are set on the tag.
export interface PriceabilityTag {
  tagNumber?: string | null;
  saleMcRate: unknown;
  saleVaPercent: unknown;
  materials: Array<{ code: string; materialType: string; saleRate: unknown }>;
}

export function missingSaleRates(tag: PriceabilityTag): string[] {
  const missing: string[] = [];
  if (tag.saleMcRate == null) missing.push('making charge rate');
  if (tag.saleVaPercent == null) missing.push('VA %');
  for (const m of tag.materials) {
    if (m.materialType !== 'METAL' && m.saleRate == null) missing.push(`${m.code} sale rate`);
  }
  return missing;
}

export function assertTagPriceable(tag: PriceabilityTag): void {
  const missing = missingSaleRates(tag);
  if (missing.length > 0) {
    throw new AppError(`Tag ${tag.tagNumber ?? ''} cannot be priced - missing: ${missing.join(', ')}. Set them on the tag first.`.replace('Tag  ', 'Tag '), 409);
  }
}
