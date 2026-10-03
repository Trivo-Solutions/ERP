// G8b — first real GstIntegrationProvider adapter: NIC e-Invoice (IRP) master-data GSTIN lookup.
//
// SCOPE: authenticate(), health(), getGstinDetails() only. Every IRN / E-Way Bill capability stays
// deterministic UNSUPPORTED_PROVIDER_OPERATION (G8c+).
//
// COMPLIANCE DISCLAIMER (same class as shared/gstin.ts and the G2g-7e normalizer): the wire format
// below — endpoint paths, header names, the `Status`/`Data`/`ErrorDetails` envelope and the field
// names — is a best-effort reconstruction of NIC's published master-data API, NOT verified against a
// live sandbox this session. In particular NIC's real authentication encrypts the credential payload
// with NIC's RSA public key and an AES session key; that handshake is NOT implemented here — this
// adapter sends the credentials as plain JSON over HTTPS. Verify against the provider's current spec
// before pointing a PRODUCTION config at it. All provider-specific knowledge is confined to this file.
//
// Credential keys (stored encrypted per G8a; never logged/echoed):
//   baseUrl (required), clientId, clientSecret, username, password (all required).
import { gstIntegrationFetch } from '../httpClient';
import { GstIntegrationError } from '../errors';
import {
  GstIntegrationProvider, GstIntegrationCallContext, GstIntegrationAuthResult, GstIntegrationHealthResult,
  GstinDetails, UnsupportedOperationResult, GstProviderName, unsupported,
} from '../types';

const REQUIRED_CREDENTIALS = ['baseUrl', 'clientId', 'clientSecret', 'username', 'password'] as const;
// NIC auth tokens last ~6h; a provider-supplied expiry always wins. This is only the fallback.
const DEFAULT_TOKEN_TTL_MS = 30 * 60_000;

export interface NicIrpProviderOptions {
  maxRetries?: number;
  timeoutMs?: number;
}

// The credential-supplied baseUrl is company-controlled input that the server will fetch — refuse
// obvious internal targets in PRODUCTION (SSRF guard). Literal-host check only; DNS rebinding is
// out of scope here.
function isInternalHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.internal') || h === '::1' || h === '::') return true;
  if (/^(fc|fd|fe80)/.test(h) && h.includes(':')) return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

function pad2(n: number) { return String(n).padStart(2, '0'); }

/** NIC sends dd/MM/yyyy; an ISO-looking value passes through. Anything else is null, never guessed. */
function toIsoDate(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  const dmy = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(s);
  if (dmy) return `${dmy[3]}-${dmy[2]}-${dmy[1]}`;
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  return null;
}

function str(v: unknown): string | null {
  if (typeof v === 'string') { const t = v.trim(); return t === '' ? null : t; }
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return null;
}

export class NicIrpProvider implements GstIntegrationProvider {
  readonly name: GstProviderName = 'NIC_IRP';

  constructor(private readonly opts: NicIrpProviderOptions = {}) {}

  private fail(ctx: GstIntegrationCallContext, operation: 'AUTHENTICATE' | 'HEALTH_CHECK' | 'GET_GSTIN_DETAILS', category: 'VALIDATION' | 'AUTHENTICATION' | 'PROVIDER', message: string, providerCode?: string) {
    return new GstIntegrationError({ message, category, provider: this.name, operation, correlationId: ctx.correlationId, providerCode });
  }

  /** Validated base URL (no trailing slash) + required credentials, or throws a safe VALIDATION error. */
  private requireConfig(ctx: GstIntegrationCallContext, operation: 'AUTHENTICATE' | 'HEALTH_CHECK' | 'GET_GSTIN_DETAILS') {
    for (const key of REQUIRED_CREDENTIALS) {
      if (!ctx.credentials[key]) throw this.fail(ctx, operation, 'VALIDATION', `Missing required provider credential '${key}'`);
    }
    let url: URL;
    try { url = new URL(ctx.credentials.baseUrl); } catch { throw this.fail(ctx, operation, 'VALIDATION', "Provider credential 'baseUrl' is not a valid URL"); }
    if (ctx.environment === 'PRODUCTION' && isInternalHost(url.hostname)) {
      throw this.fail(ctx, operation, 'VALIDATION', "Provider credential 'baseUrl' must not point at an internal host in PRODUCTION");
    }
    return { baseUrl: url.toString().replace(/\/+$/, '') };
  }

  private baseHeaders(ctx: GstIntegrationCallContext): Record<string, string> {
    return { Accept: 'application/json', client_id: ctx.credentials.clientId, client_secret: ctx.credentials.clientSecret };
  }

  private parseJson(ctx: GstIntegrationCallContext, operation: 'AUTHENTICATE' | 'GET_GSTIN_DETAILS', body: string): Record<string, any> {
    try {
      const parsed = JSON.parse(body);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch { /* fall through */ }
    throw this.fail(ctx, operation, 'PROVIDER', 'Provider returned a malformed response');
  }

  async authenticate(ctx: GstIntegrationCallContext): Promise<GstIntegrationAuthResult> {
    const { baseUrl } = this.requireConfig(ctx, 'AUTHENTICATE');
    // gstIntegrationFetch already normalizes transport/HTTP failures (401 → AUTHENTICATION etc.).
    const res = await gstIntegrationFetch({
      url: `${baseUrl}/auth`, method: 'POST',
      headers: { ...this.baseHeaders(ctx), 'Content-Type': 'application/json' },
      body: JSON.stringify({ UserName: ctx.credentials.username, Password: ctx.credentials.password }),
      provider: this.name, operation: 'AUTHENTICATE', environment: ctx.environment, correlationId: ctx.correlationId,
      timeoutMs: this.opts.timeoutMs, maxRetries: 0,
    });
    const json = this.parseJson(ctx, 'AUTHENTICATE', res.body);
    const token = str(json.Data?.AuthToken);
    if (json.Status !== 1 || !token) {
      return { status: 'AUTH_FAILED', message: 'Provider rejected the supplied credentials' };
    }
    const expiry = Date.parse(String(json.Data?.TokenExpiry ?? ''));
    return { status: 'AUTHENTICATED', token, expiresAt: Number.isFinite(expiry) && expiry > Date.now() ? expiry : Date.now() + DEFAULT_TOKEN_TTL_MS };
  }

  async health(ctx: GstIntegrationCallContext): Promise<GstIntegrationHealthResult> {
    const base = { checkedAt: new Date().toISOString(), correlationId: ctx.correlationId };
    try {
      const auth = await this.authenticate(ctx);
      if (auth.status === 'AUTHENTICATED') return { ...base, status: 'AVAILABLE' };
      return { ...base, status: auth.status === 'AUTH_FAILED' ? 'AUTH_FAILED' : 'NOT_CONFIGURED', message: auth.message };
    } catch (err) {
      if (err instanceof GstIntegrationError) {
        if (err.category === 'AUTHENTICATION' || err.category === 'AUTHORIZATION') return { ...base, status: 'AUTH_FAILED', message: err.message };
        if (err.category === 'VALIDATION' && err.providerCode === undefined) return { ...base, status: 'NOT_CONFIGURED', message: err.message };
        return { ...base, status: 'UNAVAILABLE', message: err.message };
      }
      throw err;
    }
  }

  async getGstinDetails(ctx: GstIntegrationCallContext, gstin: string): Promise<GstinDetails> {
    const { baseUrl } = this.requireConfig(ctx, 'GET_GSTIN_DETAILS');
    if (!ctx.authToken) throw this.fail(ctx, 'GET_GSTIN_DETAILS', 'AUTHENTICATION', 'Provider session is not authenticated');

    const res = await gstIntegrationFetch({
      url: `${baseUrl}/Master/gstin/${encodeURIComponent(gstin)}`, method: 'GET',
      headers: { ...this.baseHeaders(ctx), AuthToken: ctx.authToken, user_name: ctx.credentials.username },
      provider: this.name, operation: 'GET_GSTIN_DETAILS', environment: ctx.environment, correlationId: ctx.correlationId,
      timeoutMs: this.opts.timeoutMs, maxRetries: this.opts.maxRetries,
    });
    const json = this.parseJson(ctx, 'GET_GSTIN_DETAILS', res.body);

    if (json.Status !== 1) {
      // The provider's own error text is untrusted; surface only its code, never its message/body.
      const code = str(json.ErrorDetails?.[0]?.ErrorCode);
      throw this.fail(ctx, 'GET_GSTIN_DETAILS', 'VALIDATION', 'Provider could not return details for this GSTIN', code ?? undefined);
    }
    const d = json.Data;
    if (!d || typeof d !== 'object' || !str(d.Gstin)) throw this.fail(ctx, 'GET_GSTIN_DETAILS', 'PROVIDER', 'Provider returned a malformed response');
    if (str(d.Gstin)!.toUpperCase() !== gstin) throw this.fail(ctx, 'GET_GSTIN_DETAILS', 'PROVIDER', 'Provider returned details for a different GSTIN');

    const txp = str(d.TxpType)?.toUpperCase() ?? null;
    const addr = [d.AddrBnm, d.AddrBno, d.AddrFlno, d.AddrSt, d.AddrLoc, d.AddrPncd].map(str).filter((p): p is string => !!p).join(', ');
    const stateNum = Number(d.StateCode);
    return {
      gstin,
      legalName: str(d.LegalName),
      tradeName: str(d.TradeName),
      registrationStatus: str(d.Status),
      registrationDate: toIsoDate(d.DtReg),
      cancellationDate: toIsoDate(d.DtDeReg),
      constitutionOfBusiness: null,           // not in this endpoint's response
      taxpayerType: txp,
      stateCode: Number.isInteger(stateNum) && stateNum > 0 ? pad2(stateNum) : null,
      stateName: null,                        // not supplied; callers may resolve via StateMaster
      principalPlaceOfBusiness: addr === '' ? null : addr,
      natureOfBusiness: null,                 // not in this endpoint's response
      compositionStatus: txp === null ? null : txp === 'COM' ? 'COMPOSITION' : 'NOT_COMPOSITION',
      eInvoiceEnabled: null,                  // not in this endpoint's response
      provider: this.name,
      fetchedAt: new Date().toISOString(),
    };
  }

  // G8c: deliberately NOT implemented (supportsIrnGeneration stays false). The current official spec
  // (NIC sandbox, core v1.03 / vital v1.04, read 2026-10-03) documents the Generate IRN payload and
  // response, but not — in a form verifiable here — how the request `Data` is encrypted with the SEK
  // (raw vs base64-wrapped JSON), nor the RSA-encrypted auth handshake this adapter's authenticate()
  // does NOT perform (it sends plain JSON; G8b's own disclaimer). Until both are verified against a
  // live sandbox, no statutory mutation may be sent.
  readonly supportsIrnGeneration = false;
  async generateIrn(): Promise<UnsupportedOperationResult> { return unsupported(this.name, 'GENERATE_IRN'); }
  async cancelIrn(): Promise<UnsupportedOperationResult> { return unsupported(this.name, 'CANCEL_IRN'); }
  async getIrn(): Promise<UnsupportedOperationResult> { return unsupported(this.name, 'GET_IRN'); }
  async getIrnByDocument(): Promise<UnsupportedOperationResult> { return unsupported(this.name, 'GET_IRN_BY_DOCUMENT'); }
  async generateEwayBill(): Promise<UnsupportedOperationResult> { return unsupported(this.name, 'GENERATE_EWAYBILL'); }
  async cancelEwayBill(): Promise<UnsupportedOperationResult> { return unsupported(this.name, 'CANCEL_EWAYBILL'); }
}
