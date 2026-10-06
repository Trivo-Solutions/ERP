import React from 'react';
import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { VaultAvailability, sumVaultLots, remainingVault, vaultShortage, vaultQueryKey } from '../pages/Sales/MaterialSaleDialog';

const render = (karat: string, weight: number, inCart: number, lots?: Array<{ availableWt: number | string }>) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  if (lots) qc.setQueryData(vaultQueryKey(karat), { success: true, data: lots });
  return renderToStaticMarkup(<QueryClientProvider client={qc}><VaultAvailability karat={karat} weight={weight} inCart={inCart} /></QueryClientProvider>);
};

describe('Material Sale — vault availability (display only; the server FIFO stays the authority)', () => {
  it('sums several lots', () => {
    expect(sumVaultLots([{ availableWt: '10.250' }, { availableWt: 8.2 }])).toBe(18.45);
    expect(sumVaultLots(undefined)).toBe(0);
  });

  it('shows the available grams for gold 22K', () => {
    const html = render('22K', 4, 0, [{ availableWt: 10.25 }, { availableWt: 8.2 }]);
    expect(html).toContain('Available Vault Stock');
    expect(html).toContain('18.450 g');
    expect(html).not.toContain('Short by');
  });

  it('shows silver availability too', () => {
    expect(render('925', 50, 0, [{ availableWt: 400 }])).toContain('400.000 g');
  });

  it('subtracts material already on the invoice, and flags the shortage', () => {
    const html = render('22K', 4, 16, [{ availableWt: 18.45 }]);
    expect(html).toContain('2.450 g');
    expect(html).toContain('Short by 1.550 g');
  });

  it('flags an empty vault as a shortage', () => {
    expect(render('18K', 2.5, 0, [])).toContain('Short by 2.500 g');
  });

  it('does not block when the vault figure is unknown (server decides)', () => {
    const html = render('22K', 4, 0);
    expect(html).toContain('checking');
    expect(html).not.toContain('Short by');
    expect(vaultShortage(remainingVault(null, 0), 999)).toBe(0);
  });

  it('exact-fit weight is not a shortage', () => {
    expect(vaultShortage(remainingVault(18.45, 0), 18.45)).toBe(0);
  });
});
