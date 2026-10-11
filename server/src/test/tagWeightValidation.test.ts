import { describe, it, expect } from 'vitest';
import { assertTagSaleRatesForSave } from '../modules/tagging/tagging.service';

// No metal row + no karat => the metal-rate lookup is never reached, so the context is unused.
const ctx = { companyId: 'unused' } as any;
const ok = { saleMcRate: 10, saleVaPercent: 5, grossWeight: 10, netWeight: 9.5 };

describe('tag save requires real weights', () => {
  it('accepts a valid piece', async () => {
    await expect(assertTagSaleRatesForSave(ctx, ok, { partial: false })).resolves.toBeUndefined();
  });
  it('refuses zero / blank gross or net weight', async () => {
    await expect(assertTagSaleRatesForSave(ctx, { ...ok, grossWeight: 0 }, { partial: false })).rejects.toMatchObject({ statusCode: 400 });
    await expect(assertTagSaleRatesForSave(ctx, { ...ok, netWeight: undefined }, { partial: false })).rejects.toMatchObject({ statusCode: 400 });
  });
  it('refuses net weight above gross', async () => {
    await expect(assertTagSaleRatesForSave(ctx, { ...ok, netWeight: 11 }, { partial: false })).rejects.toMatchObject({ statusCode: 400 });
  });
  it('an edit that does not send weights is not forced to', async () => {
    await expect(assertTagSaleRatesForSave(ctx, { huid: 'AB1234' }, { partial: true })).resolves.toBeUndefined();
  });
});
