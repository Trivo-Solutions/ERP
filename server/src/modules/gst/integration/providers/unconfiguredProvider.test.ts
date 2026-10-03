import { describe, it, expect } from 'vitest';
import { UnconfiguredProvider } from './unconfiguredProvider';
import { resolveProvider } from './resolveProvider';
import { NicIrpProvider } from './nicIrpProvider';
import { GstIntegrationCallContext, GST_PROVIDERS } from '../types';

const ctx: GstIntegrationCallContext = {
  companyId: 'c1', gstRegistrationId: 'r1', configId: 'cfg1', environment: 'SANDBOX',
  correlationId: 'corr-1', credentials: {},
};

describe('G8a UnconfiguredProvider: deterministic, never fakes a real result', () => {
  it('authenticate() is NOT_CONFIGURED, never a fabricated token', async () => {
    const provider = new UnconfiguredProvider('IRIS_IRP');
    const result = await provider.authenticate(ctx);
    expect(result.status).toBe('NOT_CONFIGURED');
    expect(result.token).toBeUndefined();
  });

  it('health() is NOT_CONFIGURED and carries the correlationId through', async () => {
    const provider = new UnconfiguredProvider('NIC_IRP');
    const result = await provider.health(ctx);
    expect(result.status).toBe('NOT_CONFIGURED');
    expect(result.correlationId).toBe('corr-1');
  });

  it('every future capability method returns UNSUPPORTED_PROVIDER_OPERATION, never throws, never fabricates data', async () => {
    const provider = new UnconfiguredProvider('CYGNET_IRP');
    const results = await Promise.all([
      provider.getGstinDetails(ctx, '24AAAAA0000A1Z8'),
      provider.generateIrn(ctx, {} as never),
      provider.cancelIrn(ctx, {}),
      provider.getIrn(ctx, 'some-irn'),
      provider.getIrnByDocument(ctx, {}),
      provider.generateEwayBill(ctx, {}),
      provider.cancelEwayBill(ctx, {}),
    ]);
    for (const r of results) {
      expect(r.status).toBe('UNSUPPORTED_PROVIDER_OPERATION');
      expect(r.provider).toBe('CYGNET_IRP');
    }
  });

  it('never generates anything resembling a fake IRN — no "irn" field anywhere in the result', async () => {
    const provider = new UnconfiguredProvider('CLEAR_IRP');
    const result = await provider.generateIrn(ctx, { documentNumber: 'INV-1' } as never);
    expect(JSON.stringify(result)).not.toMatch(/"irn"\s*:/i);
    expect((result as any).irn).toBeUndefined();
  });
});

describe('resolveProvider: every known provider name resolves; only implemented adapters are real', () => {
  it.each(GST_PROVIDERS)('resolves %s without throwing', (name) => {
    const provider = resolveProvider(name);
    expect(provider.name).toBe(name);
    // G8b: NIC_IRP is the first real adapter; every other name is still UnconfiguredProvider.
    if (name === 'NIC_IRP') expect(provider).toBeInstanceOf(NicIrpProvider);
    else expect(provider).toBeInstanceOf(UnconfiguredProvider);
  });

  it('falls back to OTHER for an unrecognized provider string rather than throwing', () => {
    const provider = resolveProvider('SOME_FUTURE_PROVIDER_NOT_YET_KNOWN');
    expect(provider.name).toBe('OTHER');
  });
});
