import type { EstimateTemplateElement } from '../types/estimateTemplate';

// Every estimate element is absolutely positioned at its design-time yMm. A materials table's row
// count varies per estimate, so whatever sits below it has to move with it: pulled UP for a short
// estimate (otherwise the roll is fed past a big blank gap) and pushed DOWN for a long one
// (otherwise the table overprints it). This is the pure geometry step; the DOM measuring lives in
// printTagEstimate.ts.

// Space left between a table's last row and the first element below it.
export const GAP_BELOW_TABLE_MM = 3;
// Blank paper under the lowest element.
export const BOTTOM_PADDING_MM = 2;
// Safeguards. MIN keeps a near-empty template from printing a sliver; MAX only guards against a
// corrupt measurement (it is far beyond any real estimate, so it never cuts real content).
export const MIN_PAGE_HEIGHT_MM = 20;
export const MAX_PAGE_HEIGHT_MM = 5000;

// heightsMm: rendered height of each element by id (absent = not rendered, e.g. an image-less
// image element). Returns the elements with yMm re-anchored, plus the page height.
export function flowBelowTables(
  elements: EstimateTemplateElement[],
  heightsMm: Record<string, number>,
  fallbackHeightMm: number,
): { elements: EstimateTemplateElement[]; pageHeightMm: number } {
  const placed = elements.map((e) => ({ ...e }));
  const tables = placed.filter((e) => e.type === 'materialsTable').sort((a, b) => a.yMm - b.yMm);

  for (const table of tables) {
    const tableBottom = table.yMm + (heightsMm[table.id] ?? 0);
    const below = placed.filter((e) => e !== table && e.yMm > table.yMm);
    if (below.length === 0) continue;
    const delta = tableBottom + GAP_BELOW_TABLE_MM - Math.min(...below.map((e) => e.yMm));
    for (const e of below) e.yMm = Math.max(0, e.yMm + delta);
  }

  let bottom = 0;
  for (const e of placed) {
    if (heightsMm[e.id] == null) continue;
    bottom = Math.max(bottom, e.yMm + heightsMm[e.id]);
  }
  const measured = Math.ceil(bottom) + BOTTOM_PADDING_MM;
  const pageHeightMm = Number.isFinite(measured) && bottom > 0
    ? Math.min(MAX_PAGE_HEIGHT_MM, Math.max(MIN_PAGE_HEIGHT_MM, measured))
    : Math.max(MIN_PAGE_HEIGHT_MM, fallbackHeightMm);
  return { elements: placed, pageHeightMm };
}
