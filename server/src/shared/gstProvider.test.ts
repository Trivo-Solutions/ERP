import { describe, it, expect, afterEach } from 'vitest';
import { lookupGstin, UnconfiguredGstProvider, HttpGstProvider, GstProvider, GstinLookupOutcome, GstinLookupResult } from './gstProvider';

const VALID_GSTIN = '24AAAAA0000A1Z8'; // see gstin.test.ts for how this checksum was derived

class FakeProvider implements GstProvider {
  readonly name = 'fake';
  constructor(private readonly outcome: GstinLookupOutcome | (() => GstinLookupOutcome)) {}
  async lookupGstin(_gstin: string): Promise<GstinLookupOutcome> {
    return typeof this.outcome === 'function' ? this.outcome() : this.outcome;
  }
}

class ThrowingProvider implements GstProvider {
  readonly name = 'throwing';
  async lookupGstin(_gstin: string): Promise<GstinLookupOutcome> {
    throw new Error('simulated network failure');
  }
}

describe('gstProvider: lookupGstin', () => {
  it('rejects a malformed GSTIN before ever calling the provider', async () => {
    let called = false;
    const provider = new FakeProvider(() => {
      called = true;
      return { status: 'FOUND', result: { gstin: VALID_GSTIN, source: 'fake' } };
    });
    const outcome = await lookupGstin('not-a-gstin', provider);
    expect(outcome.status).toBe('INVALID');
    expect(called).toBe(false);
  });

  it('reports NOT_CONFIGURED with the default (unconfigured) provider', async () => {
    const outcome = await lookupGstin(VALID_GSTIN, new UnconfiguredGstProvider());
    expect(outcome.status).toBe('NOT_CONFIGURED');
  });

  it('returns the provider result unchanged on a FOUND outcome', async () => {
    const result: GstinLookupResult = {
      gstin: VALID_GSTIN,
      legalName: 'Test Jewellers Pvt Ltd',
      registrationStatus: 'Active',
      stateCode: '24',
      source: 'fake',
    };
    const provider = new FakeProvider({ status: 'FOUND', result });
    const outcome = await lookupGstin(VALID_GSTIN, provider);
    expect(outcome.status).toBe('FOUND');
    if (outcome.status === 'FOUND') {
      expect(outcome.result).toEqual(result);
    }
  });

  it('passes through a NOT_FOUND outcome from the provider', async () => {
    const provider = new FakeProvider({ status: 'NOT_FOUND' });
    const outcome = await lookupGstin(VALID_GSTIN, provider);
    expect(outcome.status).toBe('NOT_FOUND');
  });

  it('passes through a PROVIDER_ERROR outcome from the provider', async () => {
    const provider = new FakeProvider({ status: 'PROVIDER_ERROR', message: 'upstream 500' });
    const outcome = await lookupGstin(VALID_GSTIN, provider);
    expect(outcome.status).toBe('PROVIDER_ERROR');
    if (outcome.status === 'PROVIDER_ERROR') {
      expect(outcome.message).toBe('upstream 500');
    }
  });

  it('turns a provider that throws (a malformed/unhandled failure) into PROVIDER_ERROR, never an unhandled rejection', async () => {
    const outcome = await lookupGstin(VALID_GSTIN, new ThrowingProvider());
    expect(outcome.status).toBe('PROVIDER_ERROR');
    if (outcome.status === 'PROVIDER_ERROR') {
      expect(outcome.message).toMatch(/simulated network failure/);
    }
  });
});

describe('gstProvider: HttpGstProvider (a "provider configured" implementation, exercised with a stubbed fetch)', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function stubFetch(handler: (url: string, init?: RequestInit) => Promise<Response> | Response) {
    globalThis.fetch = ((url: string, init?: RequestInit) => Promise.resolve(handler(url, init))) as typeof fetch;
  }

  it('maps a found:true response into a GstinLookupResult, carrying only fields the provider actually supplied', async () => {
    stubFetch(() => new Response(JSON.stringify({ found: true, legalName: 'Real Gold Pvt Ltd', stateCode: '24' }), { status: 200 }));
    const provider = new HttpGstProvider('https://example.invalid/gstin', 'test-key', 'test-provider');
    const outcome = await provider.lookupGstin(VALID_GSTIN);
    expect(outcome.status).toBe('FOUND');
    if (outcome.status === 'FOUND') {
      expect(outcome.result.legalName).toBe('Real Gold Pvt Ltd');
      expect(outcome.result.stateCode).toBe('24');
      expect(outcome.result.tradeName).toBeUndefined();
      expect(outcome.result.source).toBe('test-provider');
    }
  });

  it('maps found:false to NOT_FOUND', async () => {
    stubFetch(() => new Response(JSON.stringify({ found: false }), { status: 200 }));
    const provider = new HttpGstProvider('https://example.invalid/gstin', undefined);
    const outcome = await provider.lookupGstin(VALID_GSTIN);
    expect(outcome.status).toBe('NOT_FOUND');
  });

  it('maps an HTTP 404 to NOT_FOUND', async () => {
    stubFetch(() => new Response('not found', { status: 404 }));
    const provider = new HttpGstProvider('https://example.invalid/gstin', undefined);
    const outcome = await provider.lookupGstin(VALID_GSTIN);
    expect(outcome.status).toBe('NOT_FOUND');
  });

  it('maps a non-2xx/404 HTTP status to PROVIDER_ERROR', async () => {
    stubFetch(() => new Response('server error', { status: 500 }));
    const provider = new HttpGstProvider('https://example.invalid/gstin', undefined);
    const outcome = await provider.lookupGstin(VALID_GSTIN);
    expect(outcome.status).toBe('PROVIDER_ERROR');
  });

  it('maps a malformed (non-JSON) response body to PROVIDER_ERROR', async () => {
    stubFetch(() => new Response('<html>not json</html>', { status: 200 }));
    const provider = new HttpGstProvider('https://example.invalid/gstin', undefined);
    const outcome = await provider.lookupGstin(VALID_GSTIN);
    expect(outcome.status).toBe('PROVIDER_ERROR');
  });

  it("maps a JSON body missing the expected 'found' field to PROVIDER_ERROR", async () => {
    stubFetch(() => new Response(JSON.stringify({ legalName: 'Whoops, no found field' }), { status: 200 }));
    const provider = new HttpGstProvider('https://example.invalid/gstin', undefined);
    const outcome = await provider.lookupGstin(VALID_GSTIN);
    expect(outcome.status).toBe('PROVIDER_ERROR');
  });

  it('maps a network-level fetch failure to PROVIDER_ERROR', async () => {
    globalThis.fetch = (() => Promise.reject(new Error('ECONNREFUSED'))) as typeof fetch;
    const provider = new HttpGstProvider('https://example.invalid/gstin', undefined);
    const outcome = await provider.lookupGstin(VALID_GSTIN);
    expect(outcome.status).toBe('PROVIDER_ERROR');
    if (outcome.status === 'PROVIDER_ERROR') {
      expect(outcome.message).toMatch(/ECONNREFUSED/);
    }
  });
});
