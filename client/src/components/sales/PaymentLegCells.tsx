import { TextField } from '@mui/material';
import { SelectField } from '../fields/SelectField';
import { LegMeta, CollectionOptions, fieldsFor } from '../../utils/paymentLegMeta';

// Single-row variants of PaymentLegFields. A payment table keeps ONE row per entry, so the per-method fields become two
// table cells instead of a second row: the bank / POS terminal picker, and the details (approval code or cheque
// no./date/bank). Same rules as PaymentLegFields (utils/paymentLegMeta.ts); the server re-validates everything.

interface CellProps {
  mode: string;
  value: LegMeta;
  onChange: (patch: Partial<LegMeta>) => void;
  options: CollectionOptions | null;
  isLoading?: boolean;
  isError?: boolean;
  showErrors?: boolean;
  error?: string;
}

const dim = { fontSize: 12, opacity: 0.6 } as const;
const NO_EXTRA = ['CASH', 'OLD_GOLD', 'STORE_CREDIT', 'CUSTOMER_ADVANCE', 'METAL'];

export function PaymentLegBankCell({ mode, value, onChange, options, isLoading, isError, showErrors, error }: CellProps) {
  const f = fieldsFor(mode, options);
  const m = mode.toUpperCase();
  if (NO_EXTRA.includes(m)) return <span style={dim}>—</span>;
  if (isLoading) return <span role="status" style={dim}>Loading…</span>;
  if (isError) return <span role="alert" style={{ fontSize: 12, color: '#b71c1c' }}>Options unavailable</span>;
  if (!f.terminal && !f.provider) {
    return <span style={dim}>{options && (m === 'UPI' || m === 'BANK_TRANSFER') ? 'No bank set up' : '—'}</span>;
  }
  const missing = !!(showErrors && error);
  return (
    <span style={{ display: 'flex', gap: 6 }}>
      {f.provider && (
        <SelectField size="small" fullWidth label={f.providerRequired ? 'Bank *' : 'Bank'} value={value.providerId} emptyLabel="Select bank"
          onChange={(e) => onChange({ providerId: e.target.value })} error={missing && f.providerRequired && !value.providerId}
          options={f.providers.map((p) => ({ value: p.id, label: p.shortCode ? `${p.name} (${p.shortCode})` : p.name }))} />
      )}
      {f.terminal && (
        <SelectField size="small" fullWidth label={f.terminalRequired ? 'POS terminal *' : 'POS terminal'} value={value.terminalId} emptyLabel="Select terminal"
          onChange={(e) => onChange({ terminalId: e.target.value })} error={missing && f.terminalRequired && !value.terminalId}
          options={f.terminals.map((t) => ({ value: t.id, label: `${t.code} · ${t.providerName} · TID ${t.tid}` }))} />
      )}
    </span>
  );
}

export function PaymentLegDetailCell({ mode, value, onChange, options, showErrors, error }: CellProps) {
  const f = fieldsFor(mode, options);
  if (!f.authCode && !f.cheque) return <span style={dim}>—</span>;
  if (f.authCode) {
    const bad = !!(showErrors && error && value.authCode && /approval|auth|card number/i.test(error));
    return (
      <TextField size="small" fullWidth label="Approval / auth code" value={value.authCode} InputLabelProps={{ shrink: true }}
        onChange={(e) => onChange({ authCode: e.target.value })} inputProps={{ maxLength: 30, autoComplete: 'off' }} error={bad} title={bad ? error : undefined} />
    );
  }
  return (
    <span style={{ display: 'flex', gap: 6 }}>
      <TextField size="small" label="Cheque no." value={value.chequeNumber} InputLabelProps={{ shrink: true }} sx={{ width: 110 }}
        onChange={(e) => onChange({ chequeNumber: e.target.value })} inputProps={{ maxLength: 30 }} />
      <TextField size="small" type="date" label="Date" value={value.chequeDate} InputLabelProps={{ shrink: true }} sx={{ width: 140 }}
        onChange={(e) => onChange({ chequeDate: e.target.value })} />
      <TextField size="small" label="Bank" value={value.chequeBank} InputLabelProps={{ shrink: true }} sx={{ width: 120 }}
        onChange={(e) => onChange({ chequeBank: e.target.value })} inputProps={{ maxLength: 80 }} />
    </span>
  );
}
