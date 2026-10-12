import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient } from '@tanstack/react-query';
import { resolveLayout, defaultLayout, layoutSignature, toSavedLayout } from '../utils/tableLayout';

// What the signed-in member has saved on the server, as the shared hook would hand it to a table.
let mockSaved: Record<string, any> | undefined;
let mockLoaded = true;
vi.mock('../hooks/useSavedTableLayouts', () => ({
  useSavedTableLayouts: () => ({ layouts: mockSaved, isLoaded: mockLoaded, save: vi.fn(), reset: vi.fn() }),
}));

import { DataTable, DataTableColumn } from '../components/common/DataTable';

const COLS: DataTableColumn[] = [
  { key: 'a', label: 'Alpha' },
  { key: 'b', label: 'Bravo' },
  { key: 'c', label: 'Charlie' },
  { key: 'd', label: 'Delta', defaultHidden: true },
];
const ROWS = [{ id: '1', a: 'a1', b: 'b1', c: 'c1', d: 'd1' }];
const render = (tableId = 't1', columns = COLS) => renderToStaticMarkup(
  <DataTable tableId={tableId} columns={columns} rows={ROWS} isLoading={false} getRowId={(r) => r.id} emptyLabel="none" />,
);
const headerOrder = (html: string) => ['Alpha', 'Bravo', 'Charlie', 'Delta'].filter((l) => html.includes(`>${l}<`) || html.includes(`>${l} `))
  .sort((x, y) => html.indexOf(x) - html.indexOf(y));

describe('layout rules (pure)', () => {
  it('no saved layout resolves to the page defaults (defaultHidden columns start hidden)', () => {
    const d = defaultLayout(COLS);
    expect(d.order).toEqual(['a', 'b', 'c', 'd']);
    expect(Array.from(d.hidden)).toEqual(['d']);
    expect(d.widths).toEqual({});
    expect(resolveLayout(undefined, COLS)).toEqual(d);
  });

  it('a saved layout wins, and survives columns being removed or added later', () => {
    const r = resolveLayout({ order: ['c', 'gone', 'a', 'b', 'd'], hidden: ['a', 'gone'], widths: { b: 300, gone: 50, c: NaN as any } }, COLS);
    expect(r.order).toEqual(['c', 'a', 'b', 'd']);
    expect(Array.from(r.hidden)).toEqual(['a']); // d is NOT hidden: the user's saved layout had it visible
    expect(r.widths).toEqual({ b: 300 });

    const withNew = resolveLayout({ order: ['b', 'a'], hidden: [], widths: {} }, COLS);
    expect(withNew.order).toEqual(['b', 'a', 'c', 'd']); // unseen columns appended
    expect(Array.from(withNew.hidden)).toEqual(['d']);   // …and a defaultHidden one stays hidden until chosen
  });

  it('malformed saved data falls back safely instead of throwing', () => {
    for (const bad of [null, 'x', 5, [], { order: 'a', hidden: 3, widths: 'w' }, { order: [1, 2], hidden: [null], widths: [] }]) {
      expect(resolveLayout(bad as any, COLS)).toEqual(defaultLayout(COLS));
    }
  });

  it('the unsaved check ignores hidden/width ordering noise but notices real changes', () => {
    const base = resolveLayout({ order: ['a', 'b', 'c', 'd'], hidden: ['b', 'c'], widths: { a: 100, b: 200 } }, COLS);
    const same = { order: ['a', 'b', 'c', 'd'], hidden: new Set(['c', 'b']), widths: { b: 200.2, a: 100 } };
    expect(layoutSignature(same)).toBe(layoutSignature(base));
    expect(layoutSignature({ ...same, order: ['b', 'a', 'c', 'd'] })).not.toBe(layoutSignature(base));
    expect(layoutSignature({ ...same, hidden: new Set(['b']) })).not.toBe(layoutSignature(base));
    expect(layoutSignature({ ...same, widths: { a: 100, b: 260 } })).not.toBe(layoutSignature(base));
  });

  it('what is sent to the server only holds columns that exist, with whole-number widths', () => {
    const payload = toSavedLayout({ order: ['b', 'zzz', 'a'], hidden: new Set(['a', 'zzz']), widths: { a: 120.6, zzz: 9 } }, COLS);
    expect(payload).toEqual({ order: ['b', 'a'], hidden: ['a'], widths: { a: 121 } });
  });
});

describe('DataTable uses the signed-in member\'s saved layout', () => {
  beforeEach(() => { mockSaved = undefined; mockLoaded = true; });

  it('shows the page defaults when nothing is saved (and no "Save layout" prompt)', () => {
    const html = render();
    expect(headerOrder(html)).toEqual(['Alpha', 'Bravo', 'Charlie']);
    expect(html).not.toContain('Save layout');
  });

  it('applies the saved order and hidden columns for that table only', () => {
    mockSaved = { t1: { order: ['c', 'a', 'b', 'd'], hidden: ['b'], widths: {} } };
    const html = render('t1');
    expect(headerOrder(html)).toEqual(['Charlie', 'Alpha', 'Delta']); // Delta was left visible in the saved layout
    expect(html).not.toContain('>Bravo<');
    // a different table of the same user is untouched
    expect(headerOrder(render('other'))).toEqual(['Alpha', 'Bravo', 'Charlie']);
  });

  it('a saved layout that already matches the screen is not flagged as unsaved', () => {
    mockSaved = { t1: { order: ['c', 'a', 'b', 'd'], hidden: ['b', 'd'], widths: { a: 222 } } };
    expect(render('t1')).not.toContain('Save layout');
  });

  it('still renders with defaults while the saved layouts are loading or unavailable', () => {
    mockLoaded = false; mockSaved = undefined;
    expect(headerOrder(render())).toEqual(['Alpha', 'Bravo', 'Charlie']);
  });

  it('never reads or writes per-browser localStorage any more', () => {
    const get = vi.fn(); const set = vi.fn();
    (globalThis as any).localStorage = { getItem: get, setItem: set, removeItem: vi.fn() };
    render();
    expect(get).not.toHaveBeenCalled();
    expect(set).not.toHaveBeenCalled();
    delete (globalThis as any).localStorage;
  });
});

// The real cache/request functions (the hook above is mocked for the render tests).
const apiMock = vi.hoisted(() => ({ put: vi.fn(), delete: vi.fn() }));
vi.mock('../api/client', () => ({ api: apiMock }));

describe('save / reset keep the server and the screen in step', async () => {
  const { saveTableLayout, resetTableLayout, TABLE_LAYOUTS_KEY } = await vi.importActual<typeof import('../hooks/useSavedTableLayouts')>('../hooks/useSavedTableLayouts');
  const L = { order: ['b', 'a'], hidden: ['c'], widths: { a: 120 } };
  beforeEach(() => { apiMock.put.mockReset(); apiMock.delete.mockReset(); });

  it('save PUTs the layout under the encoded table id and caches what the server returned', async () => {
    const qc = new QueryClient();
    qc.setQueryData(TABLE_LAYOUTS_KEY, { other: L });
    apiMock.put.mockResolvedValue({ data: { data: { ...L, widths: { a: 121 } } } });
    await saveTableLayout(qc, 'sales/invoices', L);
    expect(apiMock.put).toHaveBeenCalledWith('/user-preferences/table-layouts/sales%2Finvoices', { layout: L });
    expect(qc.getQueryData<any>(TABLE_LAYOUTS_KEY)).toEqual({ other: L, 'sales/invoices': { ...L, widths: { a: 121 } } });
  });

  it('a failed save leaves the cache untouched and surfaces the error to the table', async () => {
    const qc = new QueryClient();
    qc.setQueryData(TABLE_LAYOUTS_KEY, { t: L });
    apiMock.put.mockRejectedValue(new Error('500'));
    await expect(saveTableLayout(qc, 't', { ...L, order: ['x'] })).rejects.toThrow();
    expect(qc.getQueryData<any>(TABLE_LAYOUTS_KEY).t).toEqual(L);
  });

  it('reset DELETEs the server copy, forgets only that table, and the table then resolves to its defaults', async () => {
    const qc = new QueryClient();
    qc.setQueryData(TABLE_LAYOUTS_KEY, { t1: L, t2: L });
    apiMock.delete.mockResolvedValue({ data: { success: true } });
    await resetTableLayout(qc, 't1');
    expect(apiMock.delete).toHaveBeenCalledWith('/user-preferences/table-layouts/t1');
    const cached = qc.getQueryData<any>(TABLE_LAYOUTS_KEY);
    expect(cached).toEqual({ t2: L });
    expect(resolveLayout(cached.t1, COLS)).toEqual(defaultLayout(COLS));
  });

  it('a failed reset keeps the cached layout (the server copy still exists)', async () => {
    const qc = new QueryClient();
    qc.setQueryData(TABLE_LAYOUTS_KEY, { t1: L });
    apiMock.delete.mockRejectedValue(new Error('500'));
    await expect(resetTableLayout(qc, 't1')).rejects.toThrow();
    expect(qc.getQueryData<any>(TABLE_LAYOUTS_KEY)).toEqual({ t1: L });
  });
});
