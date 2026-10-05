// Pure page planner for the tax invoice template printer — no DOM. Given the measured heights of
// the item table's header and rows, it decides how many rows go on each page and how far
// everything below the table has to move.
//
// The model: the designer reserves `reservedMm` of vertical space for the item table (its "body
// area"). Elements below that area ("the below block" — totals, words, signatory) sit at their
// designed positions as long as the rows fit inside the reservation, and are pushed down by exactly
// the overflow when they don't — so a 3-line bill and a 14-line bill both print with the totals
// directly under the table, never overlapped. When even that no longer fits on the page, rows
// continue on further pages (table header repeated) and the below block lands on the last page only.

export interface PlanInput {
  pageHeightMm: number;
  /** Where the table starts on the first page (already includes any shift from tables above it). */
  tableTopMm: number;
  /** Reserved body height on the first page (header + rows area). */
  reservedMm: number;
  headerMm: number;
  rowMm: number[];
  /** Height of the closing Total row; 0 when the table has none. */
  totalRowMm: number;
  /** Where the table starts on continuation pages. */
  contTopMm: number;
  /** Lowest point (page coordinates, before the table's own shift) the below block reaches. */
  belowBottomMm: number;
  bottomMarginMm: number;
}

export interface PagePlan {
  rowStart: number;
  rowEnd: number;       // exclusive
  withTotal: boolean;
  isFirst: boolean;
  isLast: boolean;
  topMm: number;        // where the table starts on this page
  usedMm: number;       // header + rows (+ total) height on this page
  /** Push applied to the below block (last page) — table end minus the reserved bottom. */
  shiftMm: number;
  /** Blank space to leave inside the table (before the total row) so the grid reaches its reserved bottom. */
  fillMm: number;
}

const EPS = 0.01;
// Rows kept together with the total row + below block when the table spills onto a final page.
const MIN_TAIL_ROWS = 2;

export function planPages(input: PlanInput): PagePlan[] {
  const { pageHeightMm: P, tableTopMm, reservedMm, headerMm, rowMm, totalRowMm, contTopMm, belowBottomMm, bottomMarginMm } = input;
  const n = rowMm.length;
  const reservedBottom = tableTopMm + reservedMm;
  const pages: PagePlan[] = [];
  let i = 0;
  // Hard stop: every loop iteration either finishes or consumes at least one row.
  for (let guard = 0; guard < n + 3; guard++) {
    const isFirst = pages.length === 0;
    const top = isFirst ? tableTopMm : contTopMm;
    const restRows = rowMm.slice(i).reduce((s, h) => s + h, 0);
    const needAll = headerMm + restRows + totalRowMm;

    const endEff = isFirst ? Math.max(top + reservedMm, top + needAll) : top + needAll;
    const shift = endEff - reservedBottom;
    const fitsWithBelow = belowBottomMm + shift <= P + EPS;
    if (fitsWithBelow || i >= n && guard > 0) {
      const used = needAll;
      pages.push({
        rowStart: i, rowEnd: n, withTotal: totalRowMm > 0, isFirst, isLast: true, topMm: top, usedMm: used,
        shiftMm: shift,
        fillMm: isFirst ? Math.max(0, reservedMm - needAll) : 0,
      });
      return pages;
    }

    // Fill this page with as many rows as fit above the bottom margin.
    const avail = P - bottomMarginMm - top - headerMm;
    let used = 0;
    let take = 0;
    while (i + take < n && (take === 0 || used + rowMm[i + take] <= avail + EPS)) {
      used += rowMm[i + take];
      take++;
    }
    // Every row fits above the margin but the total row + below block do not: carry the last few rows
    // over with them, so the final page is never just a footer floating under an empty table.
    if (i + take === n && take > 1) {
      const keep = Math.min(MIN_TAIL_ROWS, take - 1);
      for (let k = 0; k < keep; k++) { take--; used -= rowMm[i + take]; }
    }
    pages.push({
      rowStart: i, rowEnd: i + take, withTotal: false, isFirst, isLast: false, topMm: top,
      usedMm: headerMm + used, shiftMm: 0,
      fillMm: Math.max(0, P - bottomMarginMm - top - headerMm - used),
    });
    i += take;
  }
  // Unreachable in practice (the guard exceeds the iterations needed) — close the invoice rather
  // than loop: whatever remains goes on one final page.
  const last = pages[pages.length - 1];
  if (last) { last.isLast = true; last.rowEnd = n; last.withTotal = totalRowMm > 0; }
  return pages;
}
