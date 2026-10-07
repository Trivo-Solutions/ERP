import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SnackbarProvider } from 'notistack';
import * as exportUtils from '../utils/exportToCsv';
import { OldGoldExchange, MaterialPurchaseTable, MaterialPurchaseDetails } from '../pages/Sales/OldGoldExchange';
import { buildListParams, purchaseDetailItems, EMPTY_FILTERS, MATERIAL_PURCHASE_CSV_COLUMNS, SUPPORTED_MATERIALS } from '../pages/Sales/materialPurchaseRegister';
import { useAuthStore } from '../store/auth.store';
import { readFileSync } from 'node:fs';

const row = {
  id: 'p1', exchangeNumber: 'MP-001', createdAt: '2026-10-07T10:30:00Z', exchangeDate: '2026-10-07T10:30:00Z',
  client: { name: 'Ravi', clientCode: 'C001' }, branch: { name: 'Main' }, metalType: 'GOLD', description: 'Old bangles',
  grossWeight: '47.925', testedPurityPercent: '91.6', fineWeight: '43.8993', baseRate24K: '14000', effectivePurchaseRate: '12824',
  valuedAmount: '614590.20', creditCreated: '614590.20', createdById: 'u1', createdByName: 'Asha', reversedAt: null,
};
// a historical row written before createdBy/branch were tracked
const legacy = { ...row, id: 'p0', exchangeNumber: 'OGX-OLD', branch: null, createdByName: null, createdById: null };

const wrap = (el: React.ReactElement, seed?: (qc: QueryClient) => void) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  seed?.(qc);
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}><SnackbarProvider><MemoryRouter>{el}</MemoryRouter></SnackbarProvider></QueryClientProvider>,
  );
};

describe('Material Purchase register', () => {
  beforeEach(() => useAuthStore.setState({ user: { permissions: ['*'] } } as any));

  const page = () => wrap(<OldGoldExchange />, (qc) => qc.setQueryData(['material-purchases', {}], { success: true, data: [row, legacy] }));

  it('is labelled Material Purchase, never Old Gold Exchange, and has the new-purchase button', () => {
    const html = page();
    expect(html).toContain('Material Purchase');
    expect(html).toContain('+ New Material Purchase');
    expect(html).not.toContain('Old Gold Exchange');
  });

  it('hides the new-purchase button without invoice:create', () => {
    useAuthStore.setState({ user: { permissions: ['sales:view'] } } as any);
    expect(page()).not.toContain('+ New Material Purchase');
  });

  it('loads the register with the server\'s own figures and the requested columns', () => {
    const html = page();
    for (const h of ['Date &amp; Time', 'Purchase No.', 'Customer', 'Material', 'Gross Weight', 'Tested Purity', 'Fine Weight',
      '24K Old Gold Rate', 'Effective Rate', 'Purchase Value', 'Store Credit', 'Branch', 'Created By']) expect(html).toContain(h);
    expect(html).toContain('MP-001');
    expect(html).toContain('43.8993 g'); // stored fine weight, not recomputed
    expect(html).toContain('Gold');
  });

  it('still displays historical rows lacking branch / creator', () => {
    const html = wrap(<MaterialPurchaseTable rows={[legacy]} onOpen={() => {}} />);
    expect(html).toContain('OGX-OLD');
    expect(html).toContain('—');
  });

  it('shows Reversed instead of a credit amount for a reversed purchase', () => {
    expect(wrap(<MaterialPurchaseTable rows={[{ ...row, reversedAt: '2026-10-08T00:00:00Z' }]} onOpen={() => {}} />)).toContain('Reversed');
  });

  it('details view lists every field, read-only (no edit/reverse controls in the component)', () => {
    const d = Object.fromEntries(purchaseDetailItems(row));
    expect(d).toMatchObject({ 'Purchase No.': 'MP-001', Branch: 'Main', Material: 'Gold', 'Gross Weight': '47.925 g',
      'Tested Purity': '91.60%', 'Fine Weight': '43.8993 g', 'Created By': 'Asha' });
    expect(d['Purchase Value']).toContain('6,14,590.2');
    expect(d['Customer']).toContain('Ravi');
    const comp = readFileSync(new URL('../pages/Sales/OldGoldExchange.tsx', import.meta.url), 'utf8');
    expect(comp).not.toMatch(/apiPost|apiPut|apiPatch|apiDelete|useMutation/);
  });

  it('offers only Gold as a material (Silver/Platinum/Other cannot be chosen)', () => {
    expect(SUPPORTED_MATERIALS.map((m) => m.value)).toEqual(['GOLD']);
    const html = page();
    expect(html).not.toMatch(/SILVER|Silver|Platinum/);
  });
});

describe('filters and export', () => {
  it('sends only the filters that are set, to the server', () => {
    expect(buildListParams(EMPTY_FILTERS)).toEqual({});
    const p = buildListParams({ ...EMPTY_FILTERS, from: '2026-10-01', to: '2026-10-07', clientId: 'c1', metalType: 'GOLD', branchId: 'b1', exchangeNumber: ' MP-1 ', createdById: 'u1' });
    expect(p).toMatchObject({ clientId: 'c1', metalType: 'GOLD', branchId: 'b1', exchangeNumber: 'MP-1', createdById: 'u1' });
    expect(new Date(p.to).getTime()).toBeGreaterThan(new Date(p.from).getTime() + 6 * 86400000);
  });

  it('exports every field of the filtered rows through the shared exportToCsv', () => {
    const spy = vi.spyOn(exportUtils, 'exportToCsv').mockImplementation(() => {});
    exportUtils.exportToCsv('material-purchases', MATERIAL_PURCHASE_CSV_COLUMNS, [row]);
    const cols = spy.mock.calls[0][1] as any[];
    expect(cols.length).toBeGreaterThan(13);
    const rec = Object.fromEntries(cols.map((c) => [c.header, c.value(row)]));
    expect(rec).toMatchObject({ 'Purchase No.': 'MP-001', 'Fine Weight (g)': '43.8993', 'Purchase Value': '614590.20', 'Created By': 'Asha', Status: 'Completed' });
    spy.mockRestore();
  });
});

describe('single purchase path', () => {
  const src = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');

  it('register and Tax Invoice both use the one MaterialPurchaseDialog, with no second purchase call', () => {
    const reg = src('../pages/Sales/OldGoldExchange.tsx');
    const sale = src('../pages/Sales/NewSalePage.tsx');
    expect(reg).toContain("from './MaterialPurchaseDialog'");
    expect(sale).toContain("from './MaterialPurchaseDialog'");
    expect(reg).not.toMatch(/apiPost|useMutation|sales\/exchanges/);
    expect(src('../pages/Sales/MaterialPurchaseDialog.tsx').match(/\/sales\/material-purchases/g)).toHaveLength(1);
  });

  it('the dialog invalidates the register query so a new purchase appears after saving', () => {
    expect(src('../pages/Sales/MaterialPurchaseDialog.tsx')).toContain("queryKey: ['material-purchases']");
  });
});
