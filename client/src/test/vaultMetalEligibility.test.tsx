import React from 'react';
import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { VaultAvailability, vaultQueryKey, vaultQueryParams } from '../pages/Sales/MaterialSaleDialog';
import { buildMetalStockPayload, emptyMetalStockForm } from '../utils/metalStockPayload';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { vi } from 'vitest';
import { RequirePermission } from '../components/auth/RequirePermission';
import { useAuthStore } from '../store/auth.store';
import { NAV_ITEMS } from '../components/Layout/navItems';

// SSR has no store subscription: read the store's current state directly (same shim the GST page tests use).
vi.mock('../store/auth.store', async (importOriginal) => {
  const actual: any = await importOriginal();
  const original = actual.useAuthStore;
  const hook: any = (selector: any) => { const st = original.getState(); return selector ? selector(st) : st; };
  Object.assign(hook, original);
  return { ...actual, useAuthStore: hook };
});

// New Sale shows "available" grams from the server's metal-eligibility filter (the same rule the sale enforces), and the Metal
// Vault form sends the selected karat's own metal. Display only: the server stays the authority for both.
const render = (karat: string, metal: string | undefined, seed: Array<{ key: string[]; lots: Array<{ availableWt: number }> }>) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  for (const s of seed) qc.setQueryData(s.key, { success: true, data: s.lots });
  return renderToStaticMarkup(<QueryClientProvider client={qc}><VaultAvailability karat={karat} weight={1} inCart={0} metal={metal} /></QueryClientProvider>);
};

describe('Material Sale availability asks the server for the metal-eligible lots', () => {
  it('sends the metal with the karat, so the server applies the same eligibility rule as the sale', () => {
    expect(vaultQueryParams('925', 'SILVER')).toEqual({ karat: '925', metalType: 'SILVER' });
    expect(vaultQueryParams('22K', 'GOLD')).toEqual({ karat: '22K', metalType: 'GOLD' });
    expect(vaultQueryParams('22K')).toEqual({ karat: '22K' }); // callers that do not state a metal are unchanged
  });

  it('caches per metal: a gold-eligible figure is never reused for a silver view of the same karat label', () => {
    expect(vaultQueryKey('925', 'SILVER')).not.toEqual(vaultQueryKey('925', 'GOLD'));
    expect(vaultQueryKey('925', 'SILVER')).not.toEqual(vaultQueryKey('925'));
    // 400 g is cached for the GOLD view of label 925; the SILVER view must not show it (it waits for its own, metal-filtered answer)
    const html = render('925', 'SILVER', [{ key: vaultQueryKey('925', 'GOLD'), lots: [{ availableWt: 400 }] }]);
    expect(html).not.toContain('400.000');
    expect(html).toContain('checking');
  });

  it('shows exactly the figure the metal-filtered answer carries', () => {
    const html = render('925', 'SILVER', [{ key: vaultQueryKey('925', 'SILVER'), lots: [{ availableWt: 30 }, { availableWt: 20 }] }]);
    expect(html).toContain('50.000 g');
  });
});

describe('Metal Vault entry sends the selected karat\'s own metal', () => {
  const karats = [{ code: '22K', metalType: 'GOLD' }, { code: '925', metalType: 'SILVER' }];
  const form = { materialName: 'Lot', karat: '22K', purity: '0.916', grossWeight: '10', netWeight: '9.9', location: 'VAULT', sourceType: 'PURCHASE', avgCostPerGram: '5000' };

  it('a gold karat sends GOLD and a silver karat sends SILVER, with the numbers as numbers', () => {
    expect(buildMetalStockPayload(form, karats)).toMatchObject({ karat: '22K', metalType: 'GOLD', purity: 0.916, grossWeight: 10, netWeight: 9.9, avgCostPerGram: 5000 });
    expect(buildMetalStockPayload({ ...form, karat: '925', purity: 0.925 }, karats)).toMatchObject({ karat: '925', metalType: 'SILVER', purity: 0.925 });
  });

  it('a karat the master does not have sends no metal at all (the server refuses it)', () => {
    expect(buildMetalStockPayload({ ...form, karat: 'PT' }, karats).metalType).toBeUndefined();
  });
});

describe('Metal Vault form reset after a successful entry', () => {
  const karats = [{ code: '18K', metalType: 'GOLD', purity: 0.75 }, { code: '22K', metalType: 'GOLD', purity: 0.916 }, { code: '925', metalType: 'SILVER', purity: 0.925 }];
  it('resets to 22K with its own purity, not a blank karat and purity 0', () => {
    expect(emptyMetalStockForm(karats)).toMatchObject({ karat: '22K', purity: 0.916, grossWeight: 0, location: 'VAULT' });
  });
  it('falls back to the first gold karat, then the first vault karat, then blank', () => {
    expect(emptyMetalStockForm([karats[2], karats[0]])).toMatchObject({ karat: '18K', purity: 0.75 });
    expect(emptyMetalStockForm([karats[2]])).toMatchObject({ karat: '925', purity: 0.925 });
    expect(emptyMetalStockForm([])).toMatchObject({ karat: '', purity: 0 });
  });
});

describe('Metal Vault page access follows stock:view (the permission its karat list and stock list need on the server)', () => {
  const as = (permissions: string[]) => useAuthStore.setState({
    user: { id: 'u', email: 'u@x.com', name: 'U', role: 'R', permissions, branchAccess: { allBranches: true, branchIds: [] } } as any,
  });
  const page = () => renderToStaticMarkup(<RequirePermission permission="stock:view"><span>VAULT PAGE</span></RequirePermission>);

  it('the nav entry and the route both require stock:view', () => {
    const entries = NAV_ITEMS.flatMap((g: any) => g.children ?? [g]);
    expect(entries.find((e: any) => e.path === '/inventory/metals')?.permission).toBe('stock:view');
    const routes = readFileSync(resolve(__dirname, '../pageRoutes.tsx'), 'utf8');
    expect(routes).toMatch(/path="inventory\/metals" element=\{<RequirePermission permission="stock:view"><MetalVault \/><\/RequirePermission>\}/);
  });
  it('stock:view reaches the page; without it the page is not rendered', () => {
    as(['stock:view']);
    expect(page()).toContain('VAULT PAGE');
    as(['masters:view']); // masters:view alone is not vault access
    expect(page()).toContain('Access Restricted');
    expect(page()).not.toContain('VAULT PAGE');
  });
});
