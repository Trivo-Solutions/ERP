import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Box, Card, Table, TableHead, TableBody, TableRow, TableCell, Typography, Button,
  Grid, Chip, Dialog, DialogTitle, DialogContent, DialogActions, TextField, MenuItem,
  Tabs, Tab, Stack, CircularProgress,
} from '@mui/material';
import { Add, TrendingUp, LocalShipping, Scale, CurrencyRupee } from '@mui/icons-material';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm, Controller } from 'react-hook-form';
import { useSnackbar } from 'notistack';
import { apiGet, apiPost } from '../../api/client';
import { PageHeader } from '../../components/common/PageHeader';
import { usePermissions } from '../../hooks/usePermissions';
import { SelectField } from '../../components/fields/SelectField';
import { CurrencyField } from '../../components/fields/CurrencyField';
import { DateField } from '../../components/fields/DateField';

const SUPPLIER_TYPES = ['METAL_REFINER', 'STONE_DEALER', 'FINDINGS_VENDOR', 'KARIGAR', 'OTHER'];

function fmt(n: number) {
  return '₹' + n.toLocaleString('en-IN', { maximumFractionDigits: 0 });
}

function kpiColor(value: number | null, good: number, warn: number) {
  if (value === null) return 'text.secondary';
  if (value >= good) return 'success.main';
  if (value >= warn) return 'warning.main';
  return 'error.main';
}

// ─── Vendor Evaluation Dashboard ─────────────────────────────────────────────

function VendorEvaluation() {
  const { data, isLoading } = useQuery({
    queryKey: ['suppliers-performance'],
    queryFn: () => apiGet<any>('/procurement/suppliers/performance'),
  });

  const suppliers: any[] = (data as any)?.data ?? [];

  if (isLoading) {
    return <Box sx={{ display: 'flex', justifyContent: 'center', py: 8 }}><CircularProgress /></Box>;
  }

  if (suppliers.length === 0) {
    return (
      <Card sx={{ p: 4, textAlign: 'center' }}>
        <Typography color="text.secondary">No supplier data available yet. Create purchase orders to see performance metrics.</Typography>
      </Card>
    );
  }

  return (
    <Grid container spacing={2}>
      {suppliers.map((s: any) => (
        <Grid item xs={12} sm={6} md={4} key={s.supplierId}>
          <Card sx={{ p: 2.5 }}>
            <Stack direction="row" justifyContent="space-between" alignItems="flex-start" sx={{ mb: 1.5 }}>
              <Box>
                <Typography fontWeight={700}>{s.supplierName}</Typography>
                <Typography variant="caption" sx={{ fontFamily: 'monospace', color: '#44C47A' }}>{s.supplierCode}</Typography>
              </Box>
              <Chip label={s.supplierType.replace('_', ' ')} size="small" />
            </Stack>

            <Grid container spacing={1.5}>
              <Grid item xs={6}>
                <Stack direction="row" spacing={0.75} alignItems="center">
                  <LocalShipping sx={{ fontSize: 18, color: 'text.secondary' }} />
                  <Box>
                    <Typography variant="caption" color="text.secondary" display="block">On-Time Delivery</Typography>
                    {s.onTimeDeliveryRate !== null ? (
                      <Typography variant="h6" fontWeight={700} color={kpiColor(s.onTimeDeliveryRate, 80, 60)}>
                        {s.onTimeDeliveryRate}%
                      </Typography>
                    ) : (
                      <Typography variant="body2" color="text.secondary">—</Typography>
                    )}
                  </Box>
                </Stack>
              </Grid>

              <Grid item xs={6}>
                <Stack direction="row" spacing={0.75} alignItems="center">
                  <Scale sx={{ fontSize: 18, color: 'text.secondary' }} />
                  <Box>
                    <Typography variant="caption" color="text.secondary" display="block">Weight Accuracy</Typography>
                    {s.weightAccuracyRate !== null ? (
                      <Typography variant="h6" fontWeight={700} color={kpiColor(s.weightAccuracyRate, 99, 95)}>
                        {s.weightAccuracyRate}%
                      </Typography>
                    ) : (
                      <Typography variant="body2" color="text.secondary">—</Typography>
                    )}
                  </Box>
                </Stack>
              </Grid>

              <Grid item xs={6}>
                <Stack direction="row" spacing={0.75} alignItems="center">
                  <TrendingUp sx={{ fontSize: 18, color: 'text.secondary' }} />
                  <Box>
                    <Typography variant="caption" color="text.secondary" display="block">Avg Lead Time</Typography>
                    <Typography variant="h6" fontWeight={700}>
                      {s.avgLeadTimeDays !== null ? `${s.avgLeadTimeDays}d` : '—'}
                    </Typography>
                  </Box>
                </Stack>
              </Grid>

              <Grid item xs={6}>
                <Stack direction="row" spacing={0.75} alignItems="center">
                  <CurrencyRupee sx={{ fontSize: 18, color: 'text.secondary' }} />
                  <Box>
                    <Typography variant="caption" color="text.secondary" display="block">Total Spend</Typography>
                    <Typography variant="h6" fontWeight={700} noWrap>
                      {fmt(s.totalSpend)}
                    </Typography>
                  </Box>
                </Stack>
              </Grid>
            </Grid>

            <Box sx={{ mt: 1.5, pt: 1, borderTop: '1px solid', borderColor: 'divider' }}>
              <Typography variant="caption" color="text.secondary">{s.totalPOs} purchase order{s.totalPOs !== 1 ? 's' : ''}</Typography>
            </Box>
          </Card>
        </Grid>
      ))}
    </Grid>
  );
}

// ─── Supplier List ────────────────────────────────────────────────────────────

function SupplierList() {
  const { enqueueSnackbar } = useSnackbar();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { hasPermission } = usePermissions();
  const [createOpen, setCreateOpen] = useState(false);
  const [paySupplier, setPaySupplier] = useState<any>(null);

  const { data: suppliers, isLoading } = useQuery({
    queryKey: ['suppliers'],
    queryFn: () => apiGet<any[]>('/procurement/suppliers'),
  });

  const { control, handleSubmit, reset } = useForm({
    defaultValues: { name: '', type: 'METAL_REFINER', gstNumber: '', panNumber: '', phone: '', email: '', city: '', state: '' },
  });

  const payForm = useForm({
    defaultValues: { amount: '' as string | number, mode: 'BANK_TRANSFER', paymentDate: new Date().toISOString().split('T')[0], referenceNo: '', notes: '' },
  });
  const payMutation = useMutation({
    mutationFn: (d: any) => apiPost(`/procurement/suppliers/${paySupplier.id}/payments`, {
      amount: Number(d.amount), mode: d.mode, paymentDate: new Date(d.paymentDate),
      referenceNo: d.referenceNo || undefined, notes: d.notes || undefined,
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['suppliers'] });
      setPaySupplier(null);
      payForm.reset();
      enqueueSnackbar('Payment recorded', { variant: 'success' });
    },
    onError: (e: any) => enqueueSnackbar(e.response?.data?.error ?? 'Failed to record payment', { variant: 'error' }),
  });

  const mutation = useMutation({
    mutationFn: (data: any) => apiPost('/procurement/suppliers', data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['suppliers'] });
      setCreateOpen(false);
      reset();
      enqueueSnackbar('Supplier added', { variant: 'success' });
    },
    onError: (e: any) => enqueueSnackbar(e.response?.data?.error ?? 'Failed', { variant: 'error' }),
  });

  return (
    <>
      <Box sx={{ display: 'flex', justifyContent: 'flex-end', mb: 2 }}>
        <Button variant="contained" startIcon={<Add />} onClick={() => setCreateOpen(true)}>Add Supplier</Button>
      </Box>
      <Card>
        <Box sx={{ overflowX: 'auto' }}>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>Code</TableCell>
              <TableCell>Name</TableCell>
              <TableCell>Type</TableCell>
              <TableCell>GST</TableCell>
              <TableCell>Phone</TableCell>
              <TableCell>City</TableCell>
              <TableCell align="right">Payable</TableCell>
              <TableCell />
            </TableRow>
          </TableHead>
          <TableBody>
            {isLoading ? (
              <TableRow><TableCell colSpan={8} align="center" sx={{ py: 4 }}>Loading...</TableCell></TableRow>
            ) : (suppliers ?? []).map((s: any) => (
              <TableRow key={s.id} hover>
                <TableCell sx={{ fontFamily: 'monospace', fontWeight: 700, color: '#44C47A', fontSize: 12 }}>{s.supplierCode}</TableCell>
                <TableCell sx={{ fontWeight: 600 }}>{s.name}</TableCell>
                <TableCell><Chip label={s.type} size="small" /></TableCell>
                <TableCell sx={{ fontFamily: 'monospace', fontSize: 12 }}>{s.gstNumber ?? '—'}</TableCell>
                <TableCell>{s.phone ?? '—'}</TableCell>
                <TableCell>{s.city ?? '—'}</TableCell>
                {/* Live payable: what we owe this supplier (goods + GST received, less returns and payments). Negative = an advance paid. */}
                <TableCell align="right" sx={{ fontFamily: 'monospace', fontWeight: 700, color: Number(s.currentDue) < 0 ? 'success.main' : 'inherit' }}>
                  {fmt(Number(s.currentDue ?? 0))}
                </TableCell>
                <TableCell align="right" sx={{ whiteSpace: 'nowrap' }}>
                  {hasPermission('journal:create') && (
                    <Button size="small" variant="outlined" sx={{ mr: 1 }} onClick={() => setPaySupplier(s)}>Pay</Button>
                  )}
                  {hasPermission('report:view') && (
                    <Button size="small" onClick={() => navigate(`/finance/supplier-ledger/${s.id}`)}>Statement</Button>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        </Box>
      </Card>

      <Dialog open={createOpen} onClose={() => setCreateOpen(false)} maxWidth="sm" fullWidth>
        <form onSubmit={handleSubmit((d) => mutation.mutate(d))}>
          <DialogTitle fontWeight={700}>Add Supplier</DialogTitle>
          <DialogContent sx={{ pt: 2 }}>
            <Grid container spacing={2}>
              <Grid item xs={8}>
                <Controller name="name" control={control} rules={{ required: true }}
                  render={({ field }) => <TextField {...field} fullWidth label="Company Name" />} />
              </Grid>
              <Grid item xs={4}>
                <Controller name="type" control={control}
                  render={({ field }) => (
                    <TextField {...field} select fullWidth label="Type">
                      {SUPPLIER_TYPES.map((t) => <MenuItem key={t} value={t}>{t}</MenuItem>)}
                    </TextField>
                  )} />
              </Grid>
              <Grid item xs={6}>
                <Controller name="gstNumber" control={control}
                  render={({ field }) => <TextField {...field} fullWidth label="GSTIN" />} />
              </Grid>
              <Grid item xs={6}>
                <Controller name="phone" control={control}
                  render={({ field }) => <TextField {...field} fullWidth label="Phone" />} />
              </Grid>
              <Grid item xs={6}>
                <Controller name="email" control={control}
                  render={({ field }) => <TextField {...field} fullWidth label="Email" type="email" />} />
              </Grid>
              <Grid item xs={6}>
                <Controller name="panNumber" control={control}
                  render={({ field }) => <TextField {...field} fullWidth label="PAN" />} />
              </Grid>
              <Grid item xs={3}>
                <Controller name="city" control={control}
                  render={({ field }) => <TextField {...field} fullWidth label="City" />} />
              </Grid>
              <Grid item xs={3}>
                <Controller name="state" control={control}
                  render={({ field }) => <TextField {...field} fullWidth label="State" helperText="Used for CGST/SGST vs IGST when GSTIN is blank" />} />
              </Grid>
            </Grid>
          </DialogContent>
          <DialogActions sx={{ p: 2.5 }}>
            <Button onClick={() => setCreateOpen(false)}>Cancel</Button>
            <Button type="submit" variant="contained" disabled={mutation.isPending}>Save</Button>
          </DialogActions>
        </form>
      </Dialog>

      {/* Money out to a supplier: Dr Accounts Payable / Cr Cash-or-Bank, reduces the payable above. */}
      <Dialog open={!!paySupplier} onClose={() => setPaySupplier(null)} maxWidth="xs" fullWidth>
        <form onSubmit={payForm.handleSubmit((d) => payMutation.mutate(d))}>
          <DialogTitle fontWeight={700}>Pay Supplier</DialogTitle>
          <DialogContent sx={{ pt: 2 }}>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
              {paySupplier?.name} — currently payable {fmt(Number(paySupplier?.currentDue ?? 0))}
            </Typography>
            <Grid container spacing={2}>
              <Grid item xs={6}>
                <Controller name="amount" control={payForm.control} rules={{ required: true, min: 0.01 }}
                  render={({ field }) => <CurrencyField {...field} label="Amount" autoFocus />} />
              </Grid>
              <Grid item xs={6}>
                <Controller name="mode" control={payForm.control}
                  render={({ field }) => <SelectField {...field} label="Mode" options={[
                    { value: 'CASH', label: 'Cash' }, { value: 'CARD', label: 'Card' },
                    { value: 'UPI', label: 'UPI' }, { value: 'BANK_TRANSFER', label: 'Bank Transfer' },
                    { value: 'CHEQUE', label: 'Cheque' },
                  ]} />} />
              </Grid>
              <Grid item xs={6}>
                <Controller name="paymentDate" control={payForm.control}
                  render={({ field }) => <DateField {...field} label="Date" />} />
              </Grid>
              <Grid item xs={6}>
                <Controller name="referenceNo" control={payForm.control}
                  render={({ field }) => <TextField {...field} fullWidth label="Reference / UTR / Cheque no." />} />
              </Grid>
              <Grid item xs={12}>
                <Controller name="notes" control={payForm.control}
                  render={({ field }) => <TextField {...field} fullWidth label="Notes" multiline minRows={2} />} />
              </Grid>
            </Grid>
          </DialogContent>
          <DialogActions sx={{ p: 2.5 }}>
            <Button onClick={() => setPaySupplier(null)}>Cancel</Button>
            <Button type="submit" variant="contained" disabled={payMutation.isPending}>Record Payment</Button>
          </DialogActions>
        </form>
      </Dialog>
    </>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export function Suppliers() {
  const [tab, setTab] = useState(0);

  return (
    <Box>
      <PageHeader title="Suppliers" subtitle="Manage supplier master records and track vendor performance"
        breadcrumbs={[{ label: 'Procurement', path: '/procurement/orders' }, { label: 'Suppliers' }]} />

      <Tabs value={tab} onChange={(_, v) => setTab(v)} sx={{ mb: 2, borderBottom: 1, borderColor: 'divider' }}>
        <Tab label="Supplier Directory" />
        <Tab label="Vendor Evaluation" />
      </Tabs>

      {tab === 0 && <SupplierList />}
      {tab === 1 && <VendorEvaluation />}
    </Box>
  );
}
