import { Grid } from '@mui/material';
import { TextField } from '@mui/material';
import { useQuery } from '@tanstack/react-query';
import { apiGet } from '../../api/client';
import { SelectField } from '../fields/SelectField';
import { LegMeta, CollectionOptions, fieldsFor } from '../../utils/paymentLegMeta';

// Payment Configuration, collection side: the extra fields ONE payment leg shows for its method (POS terminal for a card,
// bank / provider for a transfer, cheque details...). Options are the active providers and terminals of the chosen branch;
// the server re-validates every id on save, so this is a convenience, not the control. Cash shows nothing extra.

export const paymentOptionsKey = (branchId: string) => ['payment-options', branchId];

/** The active providers / terminals for one branch. Disabled until a branch is chosen; the caller never blocks on it. */
export function usePaymentOptions(branchId: string | undefined) {
  const q = useQuery({
    queryKey: paymentOptionsKey(branchId ?? ''),
    queryFn: () => apiGet<CollectionOptions>('/payment-config/options', { branchId }),
    enabled: !!branchId,
    staleTime: 30_000,
    retry: false,
  });
  return { options: q.data ?? null, isLoading: q.isLoading && !!branchId, isError: q.isError };
}

interface Props {
  mode: string;
  value: LegMeta;
  onChange: (patch: Partial<LegMeta>) => void;
  options: CollectionOptions | null;
  isLoading?: boolean;
  isError?: boolean;
  /** Show validation messages (after the first submit attempt). */
  showErrors?: boolean;
  error?: string;
  /** Grid item sizes; the host screen decides the density. */
  xs?: number; sm?: number;
  /** Dense layout for grid rows: no blank helper line under each field (it only shows when there is an error). */
  compact?: boolean;
}

export function PaymentLegFields({ mode, value, onChange, options, isLoading, isError, showErrors, error, xs = 12, sm = 4, compact }: Props) {
  const f = fieldsFor(mode, options);
  const m = mode.toUpperCase();
  if (isLoading && m !== 'CASH') {
    return <Grid item xs={12}><span role="status" style={{ fontSize: 12, opacity: 0.7 }}>Loading payment options…</span></Grid>;
  }
  if (isError && m !== 'CASH') {
    return <Grid item xs={12}><span role="alert" style={{ fontSize: 12, color: '#b71c1c' }}>Could not load this branch&apos;s providers and terminals. You can still save; the server checks the payment.</span></Grid>;
  }
  const blank = compact ? undefined : ' ';
  const bad = !!(showErrors && error);
  // Nothing to choose from: say why, so a missing bank is understood as a setup gap rather than a missing field.
  if (options && (m === 'UPI' || m === 'BANK_TRANSFER') && !f.provider) {
    return <Grid item xs={12}><span role="note" style={{ fontSize: 12, opacity: 0.7 }}>No bank is set up for {m === 'UPI' ? 'UPI' : 'bank transfers'} at this branch (Payment Setup &gt; Branch availability).</span></Grid>;
  }
  const authBad = bad && !!value.authCode && /approval|auth|card number/i.test(error ?? '');
  return (
    <>
      {f.terminal && (
        <Grid item xs={xs} sm={sm}>
          <SelectField size="small" label={f.terminalRequired ? 'POS terminal' : 'POS terminal (optional)'} required={f.terminalRequired}
            value={value.terminalId} onChange={(e) => onChange({ terminalId: e.target.value })} emptyLabel="Select terminal"
            options={f.terminals.map((t) => ({ value: t.id, label: `${t.code} · ${t.providerName} · TID ${t.tid}` }))}
            error={bad && f.terminalRequired && !value.terminalId} helperText={bad && f.terminalRequired && !value.terminalId ? error : blank} />
        </Grid>
      )}
      {f.provider && (
        <Grid item xs={xs} sm={sm}>
          <SelectField size="small" label={f.providerRequired ? 'Bank / provider' : 'Bank / provider (optional)'} required={f.providerRequired}
            value={value.providerId} onChange={(e) => onChange({ providerId: e.target.value })} emptyLabel="Select"
            options={f.providers.map((p) => ({ value: p.id, label: p.shortCode ? `${p.name} (${p.shortCode})` : p.name }))}
            error={bad && f.providerRequired && !value.providerId} helperText={bad && f.providerRequired && !value.providerId ? error : blank} />
        </Grid>
      )}
      {f.authCode && (
        <Grid item xs={xs} sm={sm}>
          <TextField size="small" fullWidth label="Approval / auth code" value={value.authCode} InputLabelProps={{ shrink: true }}
            onChange={(e) => onChange({ authCode: e.target.value })} inputProps={{ maxLength: 30, autoComplete: 'off' }}
            error={authBad} helperText={authBad ? error : blank} />
        </Grid>
      )}
      {f.cheque && (
        <>
          <Grid item xs={xs} sm={sm}>
            <TextField size="small" fullWidth label="Cheque no." value={value.chequeNumber} InputLabelProps={{ shrink: true }}
              onChange={(e) => onChange({ chequeNumber: e.target.value })} inputProps={{ maxLength: 30 }} helperText={blank} />
          </Grid>
          <Grid item xs={xs} sm={sm}>
            <TextField size="small" fullWidth type="date" label="Cheque date" value={value.chequeDate} InputLabelProps={{ shrink: true }}
              onChange={(e) => onChange({ chequeDate: e.target.value })} helperText={blank} />
          </Grid>
          <Grid item xs={xs} sm={sm}>
            <TextField size="small" fullWidth label="Cheque bank" value={value.chequeBank} InputLabelProps={{ shrink: true }}
              onChange={(e) => onChange({ chequeBank: e.target.value })} inputProps={{ maxLength: 80 }} helperText={blank} />
          </Grid>
        </>
      )}
    </>
  );
}
