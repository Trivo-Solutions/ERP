// G8a — the ONLY concrete GstIntegrationProvider this phase ships (brief §4/§10/§23). Every
// capability is a deterministic, non-network response — this provider never makes an HTTP call, so
// it is safe to resolve by default in every environment, including tests and production, with zero
// risk of an accidental live call to a real IRP/GSP. A real adapter (G8b+) implements the same
// GstIntegrationProvider interface and is wired in via resolveProvider.ts — nothing in
// gstIntegration.service.ts or the routes needs to change when that happens.
import {
  GstIntegrationProvider, GstIntegrationCallContext, GstIntegrationAuthResult,
  GstIntegrationHealthResult, UnsupportedOperationResult, GstProviderName, unsupported,
} from '../types';

export class UnconfiguredProvider implements GstIntegrationProvider {
  constructor(readonly name: GstProviderName) {}

  async authenticate(ctx: GstIntegrationCallContext): Promise<GstIntegrationAuthResult> {
    return { status: 'NOT_CONFIGURED', message: `No live adapter is implemented for provider ${this.name} in this phase.` };
  }

  async health(ctx: GstIntegrationCallContext): Promise<GstIntegrationHealthResult> {
    return {
      status: 'NOT_CONFIGURED',
      message: `No live adapter is implemented for provider ${this.name} in this phase (G8a is infrastructure-only).`,
      checkedAt: new Date().toISOString(),
      correlationId: ctx.correlationId,
    };
  }

  async getGstinDetails(_ctx: GstIntegrationCallContext, _gstin: string): Promise<UnsupportedOperationResult> {
    return unsupported(this.name, 'GET_GSTIN_DETAILS');
  }
  async generateIrn(_ctx: GstIntegrationCallContext, _payload: unknown): Promise<UnsupportedOperationResult> {
    return unsupported(this.name, 'GENERATE_IRN');
  }
  async cancelIrn(_ctx: GstIntegrationCallContext, _payload: unknown): Promise<UnsupportedOperationResult> {
    return unsupported(this.name, 'CANCEL_IRN');
  }
  async getIrn(_ctx: GstIntegrationCallContext, _irn: string): Promise<UnsupportedOperationResult> {
    return unsupported(this.name, 'GET_IRN');
  }
  async getIrnByDocument(_ctx: GstIntegrationCallContext, _payload: unknown): Promise<UnsupportedOperationResult> {
    return unsupported(this.name, 'GET_IRN_BY_DOCUMENT');
  }
  async generateEwayBill(_ctx: GstIntegrationCallContext, _payload: unknown): Promise<UnsupportedOperationResult> {
    return unsupported(this.name, 'GENERATE_EWAYBILL');
  }
  async cancelEwayBill(_ctx: GstIntegrationCallContext, _payload: unknown): Promise<UnsupportedOperationResult> {
    return unsupported(this.name, 'CANCEL_EWAYBILL');
  }
}
