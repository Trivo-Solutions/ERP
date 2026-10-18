// Fixed-price-per-piece tagging: selling price = cost x (1 + markup%/100), rounded to 2 dp (GST-exclusive, like the field it fills).
// Returns null when either input is blank / not a finite number, or the cost is not positive, so the caller leaves the price alone.
export function priceFromMarkup(cost: unknown, markupPercent: unknown): number | null {
  const blank = (v: unknown) => v === '' || v === null || v === undefined;
  if (blank(cost) || blank(markupPercent)) return null;
  const c = Number(cost), p = Number(markupPercent);
  if (!Number.isFinite(c) || !Number.isFinite(p) || !(c > 0) || p <= -100) return null;
  return Math.round(c * (1 + p / 100) * 100) / 100;
}
