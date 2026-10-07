import { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Dialog, DialogTitle, DialogContent, DialogActions, Button, Grid, TextField, Typography, Alert, Divider } from '@mui/material';
import { useSnackbar } from 'notistack';
import { apiGet, apiPost } from '../../api/client';
import { SelectField } from '../../components/fields/SelectField';
import { PURCHASE_TYPES, SUPPORTED_MATERIALS, baseRateFor, baseRateKarat, baseRateName, type PurchaseType, type Material } from './materialPurchaseRegister';

const fmt = (n: number) => '₹' + Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const newKey = () => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `mp-${Date.now()}-${Math.random().toString(36).slice(2)}`);

interface Props {
  open: boolean;
  onClose: () => void;
  /** Carried in from the invoice (customer + branch already chosen there); both are editable only when not supplied. */
  clientId?: string;
  branchId?: string;
  onCompleted?: (purchase: any) => void;
}

// Material Purchase — non-tagged gold or silver the customer brings in, bought at the purity the branch TESTED. Material and
// Purchase Type together pick the base rate (Gold: 24K Old / 24K; Silver: Old Silver Base / Silver Base, both quoted for 999 purity); the purity is always the tested one typed here. The result is Store Credit on the customer's account (+ a Metal Vault lot); spending that credit
// is a separate act (the Store Credit payment mode). The figures below are a live preview — the server prices the purchase.
export function MaterialPurchaseDialog({ open, onClose, clientId: clientIdProp, branchId: branchIdProp, onCompleted }: Props) {
  const { enqueueSnackbar } = useSnackbar();
  const qc = useQueryClient();
  const [clientId, setClientId] = useState('');
  const [branchId, setBranchId] = useState('');
  const [material, setMaterial] = useState<Material>('GOLD');
  const [purchaseType, setPurchaseType] = useState<PurchaseType>('OLD');
  const [gross, setGross] = useState('');
  const [purity, setPurity] = useState('');
  const [description, setDescription] = useState('');
  // One key per dialog-open: a double click or a retry after a dropped response can never book the purchase twice.
  const [idempotencyKey, setIdempotencyKey] = useState(newKey);

  useEffect(() => {
    if (!open) return;
    setClientId(clientIdProp ?? '');
    setBranchId(branchIdProp ?? '');
    setMaterial('GOLD'); setPurchaseType('OLD'); setGross(''); setPurity(''); setDescription('');
    setIdempotencyKey(newKey());
  }, [open, clientIdProp, branchIdProp]);

  const { data: clients } = useQuery({ queryKey: ['clients-list'], queryFn: () => apiGet<any>('/orders/clients'), enabled: open && !clientIdProp });
  const clientList: any[] = (clients as any)?.clients ?? (clients as any)?.data ?? clients ?? [];
  const { data: branches } = useQuery({ queryKey: ['sales-branches'], queryFn: () => apiGet<any[]>('/sales/branches'), enabled: open });
  const branchList: any[] = (branches as any)?.data ?? branches ?? [];
  useEffect(() => {
    if (open && !branchId && branchList.length === 1) setBranchId(branchList[0].id);
  }, [open, branchId, branchList.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const { data: rates } = useQuery({ queryKey: ['metal-rates'], queryFn: () => apiGet<any[]>('/designs/rates/latest'), enabled: open });
  // The list is newest-first per karat, so the first matching row is the latest rate. Preview only: the server resolves its own.
  const baseRow = ((rates as any)?.data ?? rates ?? []).find((r: any) => r.karat === baseRateKarat(material));
  const base = baseRateFor(baseRow, purchaseType);
  const baseLabel = baseRateName(material, purchaseType);

  const g = Number(gross) || 0;
  const p = Number(purity) || 0;
  const fine = Math.round(g * p * 100) / 10000;  // gross x purity / 100, to 4 dp like the server
  const equiv999 = Math.round(g * p / 99.9 * 10000) / 10000;  // 999-equivalent weight (gross x purity / 99.9), 4 dp like the server
  const effective = base * p / 99.9;
  const value = Math.round(equiv999 * base * 100) / 100;
  const purityBad = purity !== '' && (p <= 0 || p > 100);

  const mutation = useMutation({
    mutationFn: () => apiPost<any>('/sales/material-purchases', {
      clientId, branchId, metalType: material, purchaseType, grossWeight: g, testedPurityPercent: p, description: description || undefined, idempotencyKey,
    }),
    onSuccess: (res: any) => {
      const purchase = res?.data ?? res;
      qc.invalidateQueries({ queryKey: ['client-credit'] });
      qc.invalidateQueries({ queryKey: ['material-purchases'] });
      qc.invalidateQueries({ queryKey: ['old-gold-exchanges'] });
      enqueueSnackbar(`Material purchase ${purchase?.exchangeNumber ?? ''} recorded — ${fmt(Number(purchase?.valuedAmount))} Store Credit created`, { variant: 'success' });
      onCompleted?.(purchase);
      onClose();
    },
    onError: (e: any) => enqueueSnackbar(e.response?.data?.error ?? 'Failed to record material purchase', { variant: 'error' }),
  });

  const canSubmit = !!clientId && !!branchId && g > 0 && p > 0 && p <= 100 && base > 0 && value > 0;

  return (
    <Dialog open={open} onClose={mutation.isPending ? undefined : onClose} maxWidth="sm" fullWidth>
      <DialogTitle>New Material Purchase</DialogTitle>
      <DialogContent>
        <Alert severity="info" sx={{ mb: 2 }}>
          Buys the customer's physical {material === 'GOLD' ? 'gold' : 'silver'} and creates <b>Store Credit</b> on their account — it does not settle the bill by itself.
          Apply the credit afterwards with the Store Credit payment mode.
        </Alert>
        <Grid container spacing={2} sx={{ mt: 0 }}>
          <Grid item xs={12} sm={6}>
            {clientIdProp
              ? <TextField fullWidth size="small" label="Customer" value="(from this invoice)" InputLabelProps={{ shrink: true }} disabled />
              : (
                <SelectField size="small" label="Customer *" value={clientId} emptyLabel="Select…" onChange={(e) => setClientId(e.target.value)}
                  options={clientList.map((c: any) => ({ value: c.id, label: `${c.clientCode} — ${c.name}` }))} />
              )}
          </Grid>
          <Grid item xs={12} sm={6}>
            <SelectField size="small" label="Branch *" value={branchId} emptyLabel="Select…" disabled={!!branchIdProp}
              onChange={(e) => setBranchId(e.target.value)} options={branchList.map((b: any) => ({ value: b.id, label: b.name }))} />
          </Grid>
          <Grid item xs={12} sm={4}>
            <SelectField size="small" label="Material" value={material} onChange={(e) => setMaterial(e.target.value as Material)} options={SUPPORTED_MATERIALS} />
          </Grid>
          <Grid item xs={12} sm={4}>
            <SelectField size="small" label="Purchase Type" value={purchaseType} onChange={(e) => setPurchaseType(e.target.value as PurchaseType)}
              options={PURCHASE_TYPES} />
          </Grid>
          <Grid item xs={6} sm={4}>
            <TextField fullWidth size="small" type="number" autoFocus label="Gross Weight (g) *" value={gross} onChange={(e) => setGross(e.target.value)}
              InputLabelProps={{ shrink: true }} inputProps={{ step: 0.001, min: 0 }} />
          </Grid>
          <Grid item xs={6} sm={4}>
            <TextField fullWidth size="small" type="number" label="Tested Purity % *" value={purity} onChange={(e) => setPurity(e.target.value)}
              InputLabelProps={{ shrink: true }} inputProps={{ step: 0.01, min: 0, max: 100 }} error={purityBad}
              helperText={purityBad ? 'Between 0 and 100' : undefined} />
          </Grid>
          <Grid item xs={12}>
            <TextField fullWidth size="small" label="Description" placeholder="e.g. Old bangles and chain" value={description}
              InputLabelProps={{ shrink: true }} onChange={(e) => setDescription(e.target.value)} />
          </Grid>
        </Grid>

        <Divider sx={{ my: 2 }} />

        {!base && (
          <Alert severity="warning" sx={{ mb: 1 }}>No {baseLabel} is entered — add it under Metal Rates before buying.</Alert>
        )}
        <Grid container spacing={1} sx={{ fontFamily: 'monospace' }}>
          <Grid item xs={7}><Typography variant="body2" color="text.secondary">Base Rate ({baseLabel})</Typography></Grid>
          <Grid item xs={5}><Typography variant="body2" align="right" sx={{ fontFamily: 'monospace' }}>{base ? `${fmt(base)} /g` : '—'}</Typography></Grid>
          <Grid item xs={7}><Typography variant="body2" color="text.secondary">Effective Rate (999 rate × purity ÷ 99.9)</Typography></Grid>
          <Grid item xs={5}><Typography variant="body2" align="right" sx={{ fontFamily: 'monospace' }}>{base && p ? `${fmt(effective)} /g` : '—'}</Typography></Grid>
          <Grid item xs={7}><Typography variant="body2" color="text.secondary">999 Equivalent ({g || 0} g × {p || 0} ÷ 99.9)</Typography></Grid>
          <Grid item xs={5}><Typography variant="body2" align="right" sx={{ fontFamily: 'monospace' }}>{equiv999.toFixed(4)} g</Typography></Grid>
          <Grid item xs={7}><Typography variant="subtitle1" fontWeight={800}>Purchase Value → Store Credit</Typography></Grid>
          <Grid item xs={5}><Typography variant="h6" align="right" fontWeight={900} color="primary.main" sx={{ fontFamily: 'monospace' }}>{fmt(value)}</Typography></Grid>
        </Grid>
        <Typography variant="caption" color="text.secondary">Preview only — weight, rate and value are read-only; the server recalculates them from its own rate when you confirm.</Typography>
      </DialogContent>
      <DialogActions sx={{ p: 2 }}>
        <Button onClick={onClose} disabled={mutation.isPending}>Cancel</Button>
        <Button variant="contained" disabled={!canSubmit || mutation.isPending} onClick={() => mutation.mutate()}>
          {mutation.isPending ? 'Recording…' : 'Confirm Purchase'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
