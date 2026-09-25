import { useState } from 'react';
import { Box, Button, Grid, Chip, Dialog, DialogTitle, DialogContent, DialogActions, TextField, Typography, IconButton, Tooltip, Checkbox, FormControlLabel } from '@mui/material';
import { Add, Payments, Receipt, Badge } from '@mui/icons-material';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm, Controller } from 'react-hook-form';
import { useSnackbar } from 'notistack';
import { useNavigate } from 'react-router-dom';
import { apiGet, apiPost } from '../../api/client';
import { PageHeader } from '../../components/common/PageHeader';
import { DataTable } from '../../components/common/DataTable';
import { SelectField } from '../../components/fields/SelectField';
import { DateField } from '../../components/fields/DateField';
import { CurrencyField } from '../../components/fields/CurrencyField';
import { ClientKycDialog } from '../../components/common/ClientKycDialog';

export function Clients() {
  const { enqueueSnackbar } = useSnackbar();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [createOpen, setCreateOpen] = useState(false);
  const [paymentClient, setPaymentClient] = useState<{ id: string; name: string } | null>(null);
  const [kycClient, setKycClient] = useState<any>(null);
  const { data, isLoading } = useQuery({ queryKey: ['clients'], queryFn: () => apiGet<any[]>('/orders/clients') });
  const { control, handleSubmit, reset } = useForm({ defaultValues: { name: '', type: 'WHOLESALE', gstNumber: '', panNumber: '', form60Received: false, phone: '', email: '', address: '', city: '', district: '', state: '', pincode: '', creditLimit: 0, pricingTier: 'STANDARD' } });
  const paymentForm = useForm({ defaultValues: { amount: 0, mode: 'CASH', paymentDate: new Date().toISOString().slice(0, 10), referenceNo: '', notes: '' } });

  const mutation = useMutation({
    mutationFn: (data: any) => apiPost('/orders/clients', data),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['clients'] }); setCreateOpen(false); reset(); enqueueSnackbar('Client added', { variant: 'success' }); },
  });

  // F2: an on-account payment — an advance, or a payment against the client's general
  // outstanding balance rather than one specific invoice.
  const paymentMutation = useMutation({
    mutationFn: (data: any) => apiPost(`/sales/clients/${paymentClient!.id}/payments`, { ...data, paymentDate: new Date(data.paymentDate) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['clients'] });
      setPaymentClient(null);
      paymentForm.reset();
      enqueueSnackbar('Payment recorded', { variant: 'success' });
    },
  });

  return (
    <Box>
      <PageHeader title="Client Master" subtitle="B2B clients, wholesale buyers & export customers"
        breadcrumbs={[{ label: 'Orders', path: '/orders' }, { label: 'Clients' }]}
        actions={[{ label: 'Add Client', icon: <Add />, onClick: () => setCreateOpen(true) }]} />
      <DataTable
        tableId="orders-clients"
        rows={data ?? []}
        isLoading={isLoading}
        getRowId={(c: any) => c.id}
        emptyLabel="No clients yet"
        columns={[
          { key: 'clientCode', label: 'Code', render: (c: any) => <Typography fontFamily="monospace" fontWeight={700} color="secondary.main" fontSize={12}>{c.clientCode}</Typography> },
          { key: 'name', label: 'Name', render: (c: any) => <Typography fontWeight={600}>{c.name}</Typography> },
          { key: 'type', label: 'Type', render: (c: any) => <Chip label={c.type} size="small" /> },
          { key: 'gstNumber', label: 'GSTIN', render: (c: any) => <Typography fontFamily="monospace" fontSize={12}>{c.gstNumber ?? '—'}</Typography> },
          { key: 'panNumber', label: 'PAN', render: (c: any) => (
              <Typography fontFamily="monospace" fontSize={12}>
                {c.panNumber ?? (c.form60Received ? 'Form 60' : '—')}
              </Typography>
            ) },
          { key: 'phone', label: 'Phone', render: (c: any) => c.phone ?? '—' },
          { key: 'city', label: 'City', render: (c: any) => c.city ?? '—' },
          {
            key: 'creditLimit', label: 'Credit Limit', align: 'right',
            filterValue: (c: any) => String(c.creditLimit ?? ''),
            render: (c: any) => <Box sx={{ fontFamily: 'monospace' }}>{c.creditLimit ? `₹${Number(c.creditLimit).toLocaleString('en-IN')}` : '—'}</Box>,
          },
          {
            key: 'currentBalance', label: 'Balance', align: 'right',
            filterValue: (c: any) => String(c.currentBalance ?? ''),
            render: (c: any) => (
              <Box sx={{ fontFamily: 'monospace', color: Number(c.currentBalance) > 0 ? 'error.main' : 'success.main' }}>
                ₹{Number(c.currentBalance).toLocaleString('en-IN')}
              </Box>
            ),
          },
          {
            key: 'actions', label: 'Actions', align: 'right', hideable: false, filterable: false,
            render: (c: any) => (
              <>
                <Tooltip title="PAN / Form 60">
                  <IconButton size="small" onClick={() => setKycClient(c)}>
                    <Badge fontSize="small" />
                  </IconButton>
                </Tooltip>
                <Tooltip title="Record on-account payment">
                  <IconButton size="small" onClick={() => setPaymentClient({ id: c.id, name: c.name })}>
                    <Payments fontSize="small" />
                  </IconButton>
                </Tooltip>
                <Tooltip title="Statement / ledger">
                  <IconButton size="small" onClick={() => navigate(`/finance/client-ledger/${c.id}`)}>
                    <Receipt fontSize="small" />
                  </IconButton>
                </Tooltip>
              </>
            ),
          },
        ]}
      />

      <ClientKycDialog client={kycClient} onClose={() => setKycClient(null)} />

      <Dialog open={createOpen} onClose={() => setCreateOpen(false)} maxWidth="sm" fullWidth>
        <form onSubmit={handleSubmit((d) => mutation.mutate(d))}>
          <DialogTitle fontWeight={700}>Add Client</DialogTitle>
          <DialogContent sx={{ pt: 2 }}>
            <Grid container spacing={2}>
              <Grid item xs={8}><Controller name="name" control={control} rules={{ required: true }} render={({ field }) => <TextField {...field} fullWidth label="Company / Client Name" />} /></Grid>
              <Grid item xs={4}><Controller name="type" control={control} render={({ field }) => <SelectField {...field} label="Type"
                options={[{ value: 'RETAIL', label: 'Retail' }, { value: 'WHOLESALE', label: 'Wholesale' }, { value: 'EXPORT', label: 'Export' }, { value: 'MANUFACTURER', label: 'Manufacturer' }]} />} /></Grid>
              <Grid item xs={6}><Controller name="gstNumber" control={control} render={({ field }) => <TextField {...field} fullWidth label="GSTIN" />} /></Grid>
              <Grid item xs={6}><Controller name="panNumber" control={control}
                rules={{ pattern: { value: /^[A-Za-z]{5}[0-9]{4}[A-Za-z]$/, message: 'PAN looks like ABCDE1234F' } }}
                render={({ field, fieldState }) => <TextField {...field} fullWidth label="PAN" inputProps={{ maxLength: 10, style: { textTransform: 'uppercase' } }}
                  error={!!fieldState.error} helperText={fieldState.error?.message ?? 'Needed on a sale above ₹2,00,000'} />} /></Grid>
              <Grid item xs={6}><Controller name="form60Received" control={control}
                render={({ field }) => <FormControlLabel sx={{ mt: 1 }} control={<Checkbox checked={field.value} onChange={(e) => field.onChange(e.target.checked)} />} label="Form 60 received (no PAN)" />} /></Grid>
              <Grid item xs={6}><Controller name="phone" control={control} render={({ field }) => <TextField {...field} fullWidth label="Phone" />} /></Grid>
              <Grid item xs={6}><Controller name="email" control={control} render={({ field }) => <TextField {...field} fullWidth label="Email" type="email" />} /></Grid>
              <Grid item xs={6}><Controller name="address" control={control} render={({ field }) => <TextField {...field} fullWidth label="Door No / Address" />} /></Grid>
              <Grid item xs={3}><Controller name="city" control={control} render={({ field }) => <TextField {...field} fullWidth label="City" />} /></Grid>
              <Grid item xs={3}><Controller name="district" control={control} render={({ field }) => <TextField {...field} fullWidth label="District" />} /></Grid>
              <Grid item xs={3}><Controller name="state" control={control} render={({ field }) => <TextField {...field} fullWidth label="State" />} /></Grid>
              <Grid item xs={3}><Controller name="pincode" control={control} render={({ field }) => <TextField {...field} fullWidth label="Pincode" />} /></Grid>
              <Grid item xs={6}><Controller name="creditLimit" control={control} render={({ field }) => <CurrencyField {...field} label="Credit Limit" />} /></Grid>
              <Grid item xs={6}><Controller name="pricingTier" control={control} render={({ field }) => <SelectField {...field} label="Pricing Tier"
                options={[{ value: 'STANDARD', label: 'Standard' }, { value: 'PREFERRED', label: 'Preferred' }, { value: 'PREMIUM', label: 'Premium' }]} />} /></Grid>
            </Grid>
          </DialogContent>
          <DialogActions sx={{ p: 2.5 }}><Button onClick={() => setCreateOpen(false)}>Cancel</Button><Button type="submit" variant="contained" disabled={mutation.isPending}>Save Client</Button></DialogActions>
        </form>
      </Dialog>

      {/* F2: on-account payment — an advance, or a payment against the client's general
          outstanding balance rather than one specific invoice (that's the invoice detail
          drawer's "Record Payment" instead). */}
      <Dialog open={!!paymentClient} onClose={() => setPaymentClient(null)} maxWidth="xs" fullWidth>
        <form onSubmit={paymentForm.handleSubmit((d) => paymentMutation.mutate(d))}>
          <DialogTitle fontWeight={700}>Record Payment</DialogTitle>
          <DialogContent sx={{ pt: 2 }}>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>{paymentClient?.name}</Typography>
            <Grid container spacing={2}>
              <Grid item xs={6}>
                <Controller name="amount" control={paymentForm.control} rules={{ required: true, min: 0.01 }}
                  render={({ field }) => <CurrencyField {...field} label="Amount" />} />
              </Grid>
              <Grid item xs={6}>
                <Controller name="mode" control={paymentForm.control}
                  render={({ field }) => <SelectField {...field} label="Mode" options={[
                    { value: 'CASH', label: 'Cash' }, { value: 'CARD', label: 'Card' },
                    { value: 'UPI', label: 'UPI' }, { value: 'BANK_TRANSFER', label: 'Bank Transfer' },
                    { value: 'CHEQUE', label: 'Cheque' },
                  ]} />} />
              </Grid>
              <Grid item xs={6}>
                <Controller name="paymentDate" control={paymentForm.control}
                  render={({ field }) => <DateField {...field} label="Date" />} />
              </Grid>
              <Grid item xs={6}>
                <Controller name="referenceNo" control={paymentForm.control}
                  render={({ field }) => <TextField {...field} fullWidth label="Reference No." />} />
              </Grid>
              <Grid item xs={12}>
                <Controller name="notes" control={paymentForm.control}
                  render={({ field }) => <TextField {...field} fullWidth label="Notes" multiline minRows={2} />} />
              </Grid>
            </Grid>
          </DialogContent>
          <DialogActions sx={{ p: 2.5 }}>
            <Button onClick={() => setPaymentClient(null)}>Cancel</Button>
            <Button type="submit" variant="contained" disabled={paymentMutation.isPending}>Record Payment</Button>
          </DialogActions>
        </form>
      </Dialog>
    </Box>
  );
}
