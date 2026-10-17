import { describe, it, expect } from 'vitest';
import type { EstimateTemplateElement } from '../types/estimateTemplate';
import {
  flowBelowTables, GAP_BELOW_TABLE_MM, BOTTOM_PADDING_MM, MIN_PAGE_HEIGHT_MM, MAX_PAGE_HEIGHT_MM,
} from '../utils/estimatePageLayout';

// The shape of the starter 80mm template: table at y=48, GST at 118, footer at 134 (a 70mm slot).
const starter = (): EstimateTemplateElement[] => [
  { id: 'title', type: 'text', xMm: 4, yMm: 4 },
  { id: 'tag', type: 'text', xMm: 4, yMm: 42 },
  { id: 'tbl', type: 'materialsTable', xMm: 4, yMm: 48 },
  { id: 'gst', type: 'text', xMm: 4, yMm: 118 },
  { id: 'net', type: 'text', xMm: 40, yMm: 118 },
  { id: 'foot', type: 'text', xMm: 4, yMm: 134 },
];
const heights = (tableMm: number) => ({ title: 6, tag: 4, tbl: tableMm, gst: 4, net: 4, foot: 3 });
const y = (els: EstimateTemplateElement[], id: string) => els.find((e) => e.id === id)!.yMm;

describe('flowBelowTables', () => {
  it('a short estimate no longer prints the template\'s design-time blank slot', () => {
    const r = flowBelowTables(starter(), heights(20), 160);
    expect(y(r.elements, 'gst')).toBe(48 + 20 + GAP_BELOW_TABLE_MM);
    expect(y(r.elements, 'foot')).toBe(48 + 20 + GAP_BELOW_TABLE_MM + 16); // spacing among below-elements kept
    expect(r.pageHeightMm).toBeLessThan(120);
    expect(r.pageHeightMm).toBe(Math.ceil(y(r.elements, 'foot') + 3) + BOTTOM_PADDING_MM);
  });

  it('a long estimate pushes the totals down and is never truncated', () => {
    const r = flowBelowTables(starter(), heights(200), 160);
    expect(y(r.elements, 'gst')).toBe(48 + 200 + GAP_BELOW_TABLE_MM);
    expect(r.pageHeightMm).toBeGreaterThanOrEqual(y(r.elements, 'foot') + 3);
    expect(r.pageHeightMm).toBeGreaterThan(260);
  });

  it('height grows monotonically with row count', () => {
    const h = [10, 30, 60, 120].map((t) => flowBelowTables(starter(), heights(t), 160).pageHeightMm);
    expect(h).toEqual([...h].sort((a, b) => a - b));
    expect(new Set(h).size).toBe(h.length);
  });

  it('leaves elements above the table, and does not mutate its input', () => {
    const input = starter();
    const r = flowBelowTables(input, heights(20), 160);
    expect(y(r.elements, 'title')).toBe(4);
    expect(y(r.elements, 'tag')).toBe(42);
    expect(y(input, 'gst')).toBe(118);
  });

  it('a template with no table keeps design positions and fits its content', () => {
    const els: EstimateTemplateElement[] = [{ id: 'a', type: 'text', xMm: 0, yMm: 10 }, { id: 'b', type: 'text', xMm: 0, yMm: 30 }];
    const r = flowBelowTables(els, { a: 5, b: 5 }, 100);
    expect(r.elements.map((e) => e.yMm)).toEqual([10, 30]);
    expect(r.pageHeightMm).toBe(35 + BOTTOM_PADDING_MM);
  });

  it('chains two tables', () => {
    const els: EstimateTemplateElement[] = [
      { id: 't1', type: 'materialsTable', xMm: 0, yMm: 10 },
      { id: 't2', type: 'materialsTable', xMm: 0, yMm: 60 },
      { id: 'f', type: 'text', xMm: 0, yMm: 100 },
    ];
    const r = flowBelowTables(els, { t1: 30, t2: 40, f: 5 }, 100);
    expect(y(r.elements, 't2')).toBe(10 + 30 + GAP_BELOW_TABLE_MM);
    expect(y(r.elements, 'f')).toBe(y(r.elements, 't2') + 40 + GAP_BELOW_TABLE_MM);
  });

  it('applies minimum, maximum and fallback safeguards', () => {
    expect(flowBelowTables([{ id: 'a', type: 'text', xMm: 0, yMm: 1 }], { a: 2 }, 100).pageHeightMm).toBe(MIN_PAGE_HEIGHT_MM);
    expect(flowBelowTables([{ id: 'a', type: 'text', xMm: 0, yMm: 1 }], { a: 99999 }, 100).pageHeightMm).toBe(MAX_PAGE_HEIGHT_MM);
    expect(flowBelowTables([{ id: 'a', type: 'text', xMm: 0, yMm: 1 }], {}, 160).pageHeightMm).toBe(160); // nothing measured
    expect(flowBelowTables([{ id: 'a', type: 'text', xMm: 0, yMm: 1 }], { a: NaN }, 160).pageHeightMm).toBe(160);
  });
});
