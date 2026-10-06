import { useState } from 'react';
import {
  Box, Card, CardContent, Table, TableHead, TableBody, TableRow, TableCell, Typography,
  Button, Grid, MenuItem, TextField, Divider,
} from '@mui/material';
import { Savings } from '@mui/icons-material';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useSnackbar } from 'notistack';
import { apiGet, apiPost } from '../../api/client';
import { PageHeader } from '../../components/common/PageHeader';
import { useAuthStore } from '../../store/auth.store';
import { MaterialPurchaseDialog } from './MaterialPurchaseDialog';

function fmt(n: number) {
  return '₹' + Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });
}

const EMPTY = { clientId: '', description: '', karat: '', grossWeight: '', stoneWeight: '', deductionPercent: '0', notes: '' };

// D4: take a customer's old/used gold piece in, value it (net weight * today's rate, minus an
// optional melting-loss deduction %), and credit their account — a standing store credit
// (Client.currentBalance), not tied to any specific sale, redeemable whenever they next buy.
// The melted-down weight also lands in the Metal Vault (Inventory > Metal Vault) so the metal
// itself stays tracked. Server is the pricing authority — this page's total is a live preview.
export function OldGoldExchange() {
  const { enqueueSnackbar } = useSnackbar();
  const qc = useQueryClient();
  // POST /sales/exchanges requires invoice:create, a stricter permission than this page's own
  // sales:view route guard (see pageRoutes.tsx / navItems.tsx).
  const canRecord = useAuthStore((s) => s.hasPermission('invoice:create'));
  const [form, setForm] = useState(EMPTY);
  const [purchaseOpen, setPurchaseOpen] = useState(false);

  const set = (field: keyof typeof EMPTY, value: string) => setForm((p) => ({ ...p, [field]: value }));

  const { data: clients } = useQuery({ queryKey: ['clients-list'], queryFn: () => apiGet<any>('/orders/clients') });
  const clientList: any[] = (clients as any)?.clients ?? (clients as any)?.data ?? clients ?? [];

  const { data: karats } = useQuery({ queryKey: ['karats'], queryFn: () => apiGet<any>('/masters/karats') });
  const karatList: any[] = (karats as any)?.data ?? karats ?? [];

  const { data: metalRates } = useQuery({ queryKey: ['metal-rates'], queryFn: () => apiGet<any[]>('/designs/rates/latest') });
  const latestRateByKarat: Record<string, number> = {};
  (metalRates ?? []).forEach((r: any) => {
    if (!(r.karat in latestRateByKarat)) latestRateByKarat[r.karat] = Number(r.ratePerGram);
  });

  const { data: exchangesData } = useQuery({
    queryKey: ['old-gold-exchanges'], queryFn: () => apiGet<any[]>('/sales/exchanges'),
  });
  const exchanges: any[] = exchangesData ?? [];

  const { data: purchasesData } = useQuery({ queryKey: ['material-purchases'], queryFn: () => apiGet<any[]>('/sales/material-purchases') });
  const purchases: any[] = (purchasesData as any)?.data ?? purchasesData ?? [];

  const grossWeight = Number(form.grossWeight) || 0;
  const stoneWeight = Number(form.stoneWeight) || 0;
  const netWeight = Math.max(grossWeight - stoneWeight, 0);
  const deductionPercent = Number(form.deductionPercent) || 0;
  const rate = form.karat ? latestRateByKarat[form.karat] : undefined;
  const previewValue = rate ? netWeight * rate * (1 - deductionPercent / 100) : 0;

  const mutation = useMutation({
    mutationFn: () => apiPost('/sales/exchanges', {
      clientId: form.clientId,
      description: form.description,
      karat: form.karat,
      grossWeight,
      stoneWeight: stoneWeight || undefined,
      deductionPercent: deductionPercent || undefined,
      notes: form.notes || undefined,
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['old-gold-exchanges'] });
      setForm(EMPTY);
      enqueueSnackbar('Old gold exchange recorded — client credited', { variant: 'success' });
    },
    onError: (e: any) => enqueueSnackbar(e.response?.data?.error ?? 'Failed to record exchange', { variant: 'error' }),
  });

  const canSubmit = form.clientId && form.description && form.karat && grossWeight > 0;

  return (
    <Box>
      <PageHeader title="Old Gold Exchange" actions={canRecord ? [
        { label: 'Purchase Old Gold / Material', icon: <Savings />, onClick: () => setPurchaseOpen(true) },
      ] : undefined} />
      <MaterialPurchaseDialog open={purchaseOpen} onClose={() => setPurchaseOpen(false)} />

      <Card sx={{ mb: 2 }}>
        <CardContent>
          <Grid container spacing={2}>
            <Grid item xs={12} sm={6}>
              <TextField select fullWidth label="Client *" value={form.clientId}
                onChange={(e) => set('clientId', e.target.value)}>
                {clientList.map((c: any) => (
                  <MenuItem key={c.id} value={c.id}>{c.clientCode} — {c.name}</MenuItem>
                ))}
              </TextField>
            </Grid>
            <Grid item xs={12} sm={6}>
              <TextField fullWidth label="Description *" placeholder="e.g. Old gold bangle"
                value={form.description} onChange={(e) => set('description', e.target.value)} />
            </Grid>

            <Grid item xs={6} sm={3}>
              <TextField select fullWidth label="Karat *" value={form.karat}
                onChange={(e) => set('karat', e.target.value)}>
                {karatList.map((k: any) => <MenuItem key={k.code} value={k.code}>{k.code}</MenuItem>)}
              </TextField>
            </Grid>
            <Grid item xs={6} sm={3}>
              <TextField fullWidth type="number" label="Gross Weight (g) *"
                value={form.grossWeight} onChange={(e) => set('grossWeight', e.target.value)}
                inputProps={{ step: 0.001, min: 0 }} />
            </Grid>
            <Grid item xs={6} sm={3}>
              <TextField fullWidth type="number" label="Stone Weight (g)"
                value={form.stoneWeight} onChange={(e) => set('stoneWeight', e.target.value)}
                inputProps={{ step: 0.001, min: 0 }} />
            </Grid>
            <Grid item xs={6} sm={3}>
              <TextField fullWidth type="number" label="Deduction %"
                value={form.deductionPercent} onChange={(e) => set('deductionPercent', e.target.value)}
                inputProps={{ step: 0.1, min: 0, max: 100 }}
                helperText="Melting loss / wastage, if any" />
            </Grid>

            <Grid item xs={12}>
              <TextField fullWidth label="Notes" value={form.notes} onChange={(e) => set('notes', e.target.value)} />
            </Grid>
          </Grid>

          <Divider sx={{ my: 2 }} />

          <Grid container spacing={2} alignItems="center">
            <Grid item xs={12} sm={6}>
              <Typography variant="caption" color="text.secondary">Net Weight</Typography>
              <Typography fontWeight={700} fontFamily="monospace">{netWeight.toFixed(3)} g</Typography>
            </Grid>
            <Grid item xs={12} sm={6}>
              <Typography variant="caption" color="text.secondary">
                Estimated Credit {form.karat && !rate ? '(no rate available for this karat today)' : ''}
              </Typography>
              <Typography variant="h5" fontWeight={900} color="primary.main">{fmt(previewValue)}</Typography>
            </Grid>
          </Grid>

          {canRecord && (
            <Button variant="contained" startIcon={<Savings />} sx={{ mt: 2 }}
              disabled={!canSubmit || mutation.isPending} onClick={() => mutation.mutate()}>
              Record Exchange &amp; Credit Client
            </Button>
          )}
        </CardContent>
      </Card>

      <Card>
        <Box sx={{ overflowX: 'auto' }}>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Exchange #</TableCell>
                <TableCell>Date</TableCell>
                <TableCell>Client</TableCell>
                <TableCell>Description</TableCell>
                <TableCell>Karat</TableCell>
                <TableCell align="right">Net Wt (g)</TableCell>
                <TableCell align="right">Credited</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {exchanges.map((x: any) => (
                <TableRow key={x.id} hover>
                  <TableCell sx={{ fontFamily: 'monospace', fontWeight: 700, color: '#44C47A', fontSize: 12 }}>
                    {x.exchangeNumber}
                  </TableCell>
                  <TableCell sx={{ fontSize: 12 }}>{new Date(x.exchangeDate).toLocaleDateString('en-IN')}</TableCell>
                  <TableCell>{x.client?.name}</TableCell>
                  <TableCell>{x.description}</TableCell>
                  <TableCell>{x.karat}</TableCell>
                  <TableCell align="right" sx={{ fontFamily: 'monospace' }}>{Number(x.netWeight).toFixed(3)}</TableCell>
                  <TableCell align="right" sx={{ fontFamily: 'monospace', fontWeight: 700, color: 'success.main' }}>
                    {fmt(Number(x.valuedAmount))}
                  </TableCell>
                </TableRow>
              ))}
              {exchanges.length === 0 && (
                <TableRow><TableCell colSpan={7} align="center" sx={{ py: 4 }}>No old gold exchanges yet</TableCell></TableRow>
              )}
            </TableBody>
          </Table>
        </Box>
      </Card>

      <Typography variant="h6" sx={{ mt: 3, mb: 1 }}>Material Purchases</Typography>
      <Card>
        <Box sx={{ overflowX: 'auto' }}>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Purchase #</TableCell>
                <TableCell>Date / Time</TableCell>
                <TableCell>Customer</TableCell>
                <TableCell>Branch</TableCell>
                <TableCell>Material</TableCell>
                <TableCell align="right">Gross (g)</TableCell>
                <TableCell align="right">Purity %</TableCell>
                <TableCell align="right">Fine (g)</TableCell>
                <TableCell align="right">24K OG Rate</TableCell>
                <TableCell align="right">Effective Rate</TableCell>
                <TableCell align="right">Purchase Value</TableCell>
                <TableCell>By</TableCell>
                <TableCell>Credit</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {purchases.map((x: any) => (
                <TableRow key={x.id} hover>
                  <TableCell sx={{ fontFamily: 'monospace', fontWeight: 700, fontSize: 12 }}>{x.exchangeNumber}</TableCell>
                  <TableCell sx={{ fontSize: 12 }}>{new Date(x.createdAt).toLocaleString('en-IN')}</TableCell>
                  <TableCell>{x.client?.name}</TableCell>
                  <TableCell>{x.branch?.name}</TableCell>
                  <TableCell>{x.metalType}</TableCell>
                  <TableCell align="right" sx={{ fontFamily: 'monospace' }}>{Number(x.grossWeight).toFixed(3)}</TableCell>
                  <TableCell align="right" sx={{ fontFamily: 'monospace' }}>{Number(x.testedPurityPercent).toFixed(2)}</TableCell>
                  <TableCell align="right" sx={{ fontFamily: 'monospace' }}>{Number(x.fineWeight).toFixed(4)}</TableCell>
                  <TableCell align="right" sx={{ fontFamily: 'monospace' }}>{fmt(Number(x.baseRate24K))}</TableCell>
                  <TableCell align="right" sx={{ fontFamily: 'monospace' }}>{fmt(Number(x.effectivePurchaseRate))}</TableCell>
                  <TableCell align="right" sx={{ fontFamily: 'monospace', fontWeight: 700 }}>{fmt(Number(x.valuedAmount))}</TableCell>
                  <TableCell>{x.createdByName ?? '—'}</TableCell>
                  <TableCell sx={{ fontFamily: 'monospace', color: 'success.main' }}>{x.reversedAt ? 'Reversed' : fmt(Number(x.creditCreated))}</TableCell>
                </TableRow>
              ))}
              {purchases.length === 0 && (
                <TableRow><TableCell colSpan={13} align="center" sx={{ py: 4 }}>No material purchases yet</TableCell></TableRow>
              )}
            </TableBody>
          </Table>
        </Box>
      </Card>
    </Box>
  );
}
