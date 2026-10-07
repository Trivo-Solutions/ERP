import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SnackbarProvider } from 'notistack';
import * as exportUtils from '../utils/exportToCsv';
import { OldGoldExchange, MaterialPurchaseTable, MaterialPurchaseDetails } from '../pages/Sales/OldGoldExchange';
import { buildListParams, purchaseTypeLabel, baseRateFor, baseRateKarat, baseRateName, materialLabel, purchaseDetailItems, EMPTY_FILTERS, MATERIAL_PURCHASE_CSV_COLUMNS, SUPPORTED_MATERIALS } from '../pages/Sales/materialPurchaseRegister';
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
    for (const h of ['Date &amp; Time', 'Purchase No.', 'Customer', 'Material', 'Purchase Type', 'Gross Weight', 'Tested Purity', 'Fine Weight',
      'Base Rate', 'Effective Rate', 'Purchase Value', 'Store Credit', 'Branch', 'Created By']) expect(html).toContain(h);
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

  it('offers Gold and Silver as materials (Platinum/Other cannot be chosen)', () => {
    expect(SUPPORTED_MATERIALS.map((m) => m.value)).toEqual(['GOLD', 'SILVER']);
    const html = page();
    expect(html).toContain('Silver');
    expect(html).not.toMatch(/Platinum/);
  });
});

describe('purchase type', () => {
  it('shows Old / Pure in the register and the details, and a historical row with none as Old', () => {
    const html = wrap(<MaterialPurchaseTable rows={[{ ...row, purchaseType: 'PURE', id: 'x1' }, { ...row, id: 'x2', purchaseType: null }, { ...row, id: 'x3' }]} onOpen={() => {}} />);
    expect(html).toContain('Pure');
    expect(html).toContain('Old');
    expect(purchaseTypeLabel({ ...row, purchaseType: 'PURE' })).toBe('Pure');
    expect(purchaseTypeLabel({ ...row, purchaseType: null })).toBe('Old');
    expect(purchaseTypeLabel(row)).toBe('Old');
    expect(Object.fromEntries(purchaseDetailItems({ ...row, purchaseType: 'PURE' }))['Purchase Type']).toBe('Pure');
    expect(Object.fromEntries(purchaseDetailItems(row))['Purchase Type']).toBe('Old');
    expect(Object.keys(Object.fromEntries(purchaseDetailItems(row)))).toContain('Base Rate');
  });

  it('prices off the right 24K family: Old -> Old Gold rate, Pure -> normal rate, never a fallback', () => {
    const r = { karat: '24K', ratePerGram: '15000', ogRatePerGram: '14000' };
    expect(baseRateFor(r, 'OLD')).toBe(14000);
    expect(baseRateFor(r, 'PURE')).toBe(15000);
    expect(baseRateFor({ karat: '24K', ratePerGram: '15000', ogRatePerGram: null }, 'OLD')).toBe(0);
    expect(baseRateFor({ karat: '24K', ratePerGram: '0', ogRatePerGram: '14000' }, 'PURE')).toBe(0);
    expect(baseRateFor(undefined, 'PURE')).toBe(0);
  });

  it('picks the right rate family per material + type: Gold on 24K, Silver on the 999 row, never crossing', () => {
    expect(baseRateKarat('GOLD')).toBe('24K');
    expect(baseRateKarat('SILVER')).toBe('999');
    expect(baseRateName('GOLD', 'OLD')).toBe('24K Old Gold Rate');
    expect(baseRateName('GOLD', 'PURE')).toBe('24K Gold Rate');
    expect(baseRateName('SILVER', 'OLD')).toBe('Old Silver 999 Rate');
    expect(baseRateName('SILVER', 'PURE')).toBe('Silver 999 Rate');
    const silver = { karat: '999', ratePerGram: '230', ogRatePerGram: '200' };
    expect(baseRateFor(silver, 'OLD')).toBe(200);
    expect(baseRateFor(silver, 'PURE')).toBe(230);
    expect(baseRateFor({ karat: '999', ratePerGram: '230', ogRatePerGram: null }, 'OLD')).toBe(0); // no fallback to normal
    // the preview maths (999 benchmark): 100 g at 92.5% on 230 -> 92.5926 g 999-equivalent, 212.963/g, 21,296.30
    const g = 100, p = 92.5, base = baseRateFor(silver, 'PURE');
    expect(Math.round(g * p * 100) / 10000).toBe(92.5);
    expect(Math.round(base * p / 99.9 * 1000) / 1000).toBe(212.963);
    expect(Math.round((Math.round(g * p / 99.9 * 10000) / 10000) * base * 100) / 100).toBe(21296.3);
  });

  it('a historical row with no material is Gold; Silver rows are labelled and export with their rates', () => {
    expect(materialLabel(null)).toBe('Gold');
    expect(materialLabel('SILVER')).toBe('Silver');
    const silverRow = { ...row, metalType: 'SILVER', purchaseType: 'PURE', baseRate24K: '230', effectivePurchaseRate: '212.9630', fineWeight: '92.5', valuedAmount: '21296.30', testedPurityPercent: '92.5', grossWeight: '100' };
    const cells = Object.fromEntries(MATERIAL_PURCHASE_CSV_COLUMNS.map((c) => [c.header, c.value(silverRow)]));
    expect(cells).toMatchObject({ Material: 'Silver', 'Purchase Type': 'Pure', 'Base Rate': '230.00', 'Effective Rate': '212.96', 'Fine Weight (g)': '92.5000', 'Purchase Value': '21296.30' });
    expect(buildListParams({ ...EMPTY_FILTERS, metalType: 'SILVER', purchaseType: 'OLD' })).toEqual({ metalType: 'SILVER', purchaseType: 'OLD' });
  });

  it('the dialog sends the chosen material and still no calculated figures', () => {
    const dlg = readFileSync(new URL('../pages/Sales/MaterialPurchaseDialog.tsx', import.meta.url), 'utf8');
    const body = dlg.match(/apiPost<any>\('\/sales\/material-purchases', \{([\s\S]*?)\}\)/)![1];
    expect(body).toContain('metalType: material');
    expect(body).not.toContain("'GOLD'");
    expect(dlg).toContain("useState<Material>('GOLD')");
    expect(dlg).toContain("setMaterial('GOLD'); setPurchaseType('OLD'); setGross(''); setPurity('')"); // default Gold + Old, purity blank
  });

  it('sends the purchase-type filter, and the dialog sends purchaseType but no calculated figures', () => {
    expect(buildListParams({ ...EMPTY_FILTERS, purchaseType: 'PURE' })).toEqual({ purchaseType: 'PURE' });
    const dlg = readFileSync(new URL('../pages/Sales/MaterialPurchaseDialog.tsx', import.meta.url), 'utf8');
    const body = dlg.match(/apiPost<any>\('\/sales\/material-purchases', \{([\s\S]*?)\}\)/)![1];
    expect(body).toContain('purchaseType');
    expect(body).not.toMatch(/\b(effective\w*|fineWeight|valuedAmount|purchaseValue|baseRate\w*)\s*:/);
    expect(dlg).not.toMatch(/Internal Conversion/i);
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
