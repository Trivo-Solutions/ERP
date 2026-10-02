// G8a — the provider-neutral resolution boundary (brief §4/§5). Every future IRP/GSP adapter
// (G8b+) is wired in HERE and nowhere else — gstIntegration.service.ts and the routes call
// resolveProvider(name) and never know which concrete class they got. Today every provider name
// resolves to the same UnconfiguredProvider (deterministic NOT_CONFIGURED/UNSUPPORTED) because no
// real adapter has been built yet; this is the intended end state of G8a, not a gap.
import { GstIntegrationProvider, GstProviderName, isValidGstProvider } from '../types';
import { UnconfiguredProvider } from './unconfiguredProvider';

export function resolveProvider(name: string): GstIntegrationProvider {
  const providerName: GstProviderName = isValidGstProvider(name) ? name : 'OTHER';
  // switch (providerName) { case 'IRIS_IRP': return new IrisIrpProvider(); ... } — G8b+ adds real
  // cases here; every arm not yet implemented still falls through to UnconfiguredProvider so a
  // config created for a not-yet-built provider degrades to NOT_CONFIGURED, never a crash.
  return new UnconfiguredProvider(providerName);
}
