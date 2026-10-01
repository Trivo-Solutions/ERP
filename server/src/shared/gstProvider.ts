// GST Phase C — GSTIN lookup service. Provider-independent abstraction over "ask a GST registry
// who this GSTIN belongs to" — deliberately separate from validateGstin() (shared/gstin.ts), which
// only checks the number's own structure/checksum and never claims the registration is real.
//
// No GST Portal scraping, no unofficial/free API dependency, and no fabricated response data — per
// this phase's explicit instructions. This app has no authorized GST provider credentials
// configured today (see config/env.ts: GST_PROVIDER_API_URL/GST_PROVIDER_API_KEY, both unset by
// default — same "declared but unconfigured" posture as the pre-existing METAL_RATE_API_URL/KEY).
// Until a real, authorized provider is configured, every lookup returns NOT_CONFIGURED — never a
// guess, never a hard-coded sample "result".
//
//   GstinLookupService
//     |
//     +-- lookupGstin(gstin, provider?)   — validates the number first, then delegates
//     |
//     +-- GstProvider interface            — what any concrete provider must implement
//     |
//     +-- UnconfiguredGstProvider           — the default; always NOT_CONFIGURED
//     +-- HttpGstProvider                   — ready to use once GST_PROVIDER_API_URL/KEY are set;
//                                             see PHASE_C_GST_MASTER_SERVICES.md for the response
//                                             contract it expects and how to plug in a real one.

import { env } from '../config/env';
import { validateGstin } from './gstin';

/** Everything a provider might return about a registration. Only fields the provider actually supplied are set — never fabricated. */
export interface GstinLookupResult {
  gstin: string;
  legalName?: string;
  tradeName?: string;
  registrationStatus?: string;
  registrationType?: string;
  state?: string;
  stateCode?: string;
  principalPlaceAddress?: string;
  jurisdiction?: string;
  registrationDate?: string;
  cancellationDate?: string;
  taxpayerType?: string;
  /** The provider's own "as of" timestamp for this data, if it supplies one. */
  lastUpdated?: string;
  /** Which provider produced this result (e.g. the configured provider's name) — never fabricated. */
  source: string;
}

export type GstinLookupOutcome =
  | { status: 'INVALID'; errors: string[] }
  | { status: 'NOT_CONFIGURED' }
  | { status: 'FOUND'; result: GstinLookupResult }
  | { status: 'NOT_FOUND' }
  | { status: 'PROVIDER_ERROR'; message: string };

export interface GstProvider {
  readonly name: string;
  lookupGstin(gstin: string): Promise<GstinLookupOutcome>;
}

/** The default provider — always reports NOT_CONFIGURED. Never returns fabricated data. */
export class UnconfiguredGstProvider implements GstProvider {
  readonly name = 'unconfigured';
  async lookupGstin(_gstin: string): Promise<GstinLookupOutcome> {
    return { status: 'NOT_CONFIGURED' };
  }
}

/**
 * Ready-to-use once GST_PROVIDER_API_URL/GST_PROVIDER_API_KEY are set to a real, authorized GST
 * data provider. Expects `GET {url}?gstin=...` with `Authorization: Bearer {key}`, returning either
 * `{ found: true, ...GstinLookupResult fields }` or `{ found: false }`. This exact contract is a
 * TRIVO-side convention for whichever provider is eventually wired in here — adapt the field
 * mapping below (never invent values the response didn't supply) if a chosen provider's actual
 * response shape differs. Untested against any real provider (none is configured in this repo) —
 * see PHASE_C_GST_MASTER_SERVICES.md.
 */
export class HttpGstProvider implements GstProvider {
  readonly name: string;
  constructor(private readonly baseUrl: string, private readonly apiKey: string | undefined, name?: string) {
    this.name = name ?? 'http';
  }

  async lookupGstin(gstin: string): Promise<GstinLookupOutcome> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}?gstin=${encodeURIComponent(gstin)}`, {
        headers: this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {},
      });
    } catch (err) {
      return { status: 'PROVIDER_ERROR', message: err instanceof Error ? err.message : 'Network error' };
    }

    if (response.status === 404) return { status: 'NOT_FOUND' };
    if (!response.ok) return { status: 'PROVIDER_ERROR', message: `Provider responded with HTTP ${response.status}` };

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return { status: 'PROVIDER_ERROR', message: 'Provider returned a malformed (non-JSON) response' };
    }
    if (typeof body !== 'object' || body === null) {
      return { status: 'PROVIDER_ERROR', message: 'Provider returned a malformed response body' };
    }
    const b = body as Record<string, unknown>;
    if (b.found === false) return { status: 'NOT_FOUND' };
    if (b.found !== true) return { status: 'PROVIDER_ERROR', message: "Provider response missing 'found'" };

    const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v : undefined);
    return {
      status: 'FOUND',
      result: {
        gstin,
        legalName: str(b.legalName),
        tradeName: str(b.tradeName),
        registrationStatus: str(b.registrationStatus),
        registrationType: str(b.registrationType),
        state: str(b.state),
        stateCode: str(b.stateCode),
        principalPlaceAddress: str(b.principalPlaceAddress),
        jurisdiction: str(b.jurisdiction),
        registrationDate: str(b.registrationDate),
        cancellationDate: str(b.cancellationDate),
        taxpayerType: str(b.taxpayerType),
        lastUpdated: str(b.lastUpdated),
        source: this.name,
      },
    };
  }
}

/** Picks the configured provider from env, or UnconfiguredGstProvider if none is set. */
export function resolveGstProvider(): GstProvider {
  if (env.GST_PROVIDER_API_URL) {
    return new HttpGstProvider(env.GST_PROVIDER_API_URL, env.GST_PROVIDER_API_KEY, env.GST_PROVIDER_NAME);
  }
  return new UnconfiguredGstProvider();
}

/**
 * Validates the GSTIN first (a malformed number is never sent to a provider), then delegates to
 * `provider` (defaults to whatever env resolves to). Never throws — every outcome, including a
 * provider network/parse failure, comes back as a typed result the caller can render or log.
 */
export async function lookupGstin(rawGstin: unknown, provider: GstProvider = resolveGstProvider()): Promise<GstinLookupOutcome> {
  const validation = validateGstin(rawGstin);
  if (!validation.valid) {
    return { status: 'INVALID', errors: validation.errors };
  }
  try {
    return await provider.lookupGstin(validation.gstin);
  } catch (err) {
    return { status: 'PROVIDER_ERROR', message: err instanceof Error ? err.message : 'Unknown provider error' };
  }
}
