import { useState } from 'react';
import { Box, Card, Table, TableHead, TableBody, TableRow, TableCell, Typography, Button, Grid, Chip, Dialog, DialogTitle, DialogContent, DialogActions, TextField, MenuItem, Alert } from '@mui/material';
import { Add } from '@mui/icons-material';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm, Controller, useFieldArray } from 'react-hook-form';
import { useSnackbar } from 'notistack';
import { apiGet, apiPost, apiPatch } from '../../api/client';
import { PageHeader } from '../../components/common/PageHeader';
import { StatusChip } from '../../components/common/StatusChip';

const ORDER_STATUSES = ['PENDING', 'CONFIRMED', 'IN_PRODUCTION', 'QC_CHECK', 'READY', 'DELIVERED', 'CANCELLED'];

export function SalesOrders() {
  const { enqueueSnackbar } = useSnackbar();
  const qc = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [statusFilter, setStatusFilter] = useState('');

  const { data, isLoading } = useQuery({
    queryKey: ['sales-orders', statusFilter],
    queryFn: () => apiGet<any>('/orders', { status: statusFilter || undefined }),
  });

  const { data: clients } = useQuery({ queryKey: ['clients'], queryFn: () => apiGet<any[]>('/orders/clients') });
  const { data: designs } = useQuery({ queryKey: ['approved-designs'], queryFn: () => apiGet<any>('/designs', { status: 'APPROVED' }) });

  const { control, handleSubmit, reset } = useForm({
    defaultValues: {
      clientId: '', orderDate: new Date().toISOString().split('T')[0], deliveryDate: '', priority: 'NORMAL',
      advanceAmount: 0, advanceType: 'CASH', specialInstructions: '',
      items: [{ designId: '', quantity: 1, unitPrice: 0, customizations: {} }],
    },
  });
  const { fields, append, remove } = useFieldArray({ control, name: 'items' });

  const mutation = useMutation({
    mutationFn: (data: any) => apiPost('/orders', { ...data, orderDate: new Date(data.orderDate), deliveryDate: data.deliveryDate ? new Date(data.deliveryDate) : undefined }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['sales-orders'] }); setCreateOpen(false); reset(); enqueueSnackbar('Sales order created & materials auto-reserved', { variant: 'success' }); },
    onError: (err: any) => enqueueSnackbar(err.response?.data?.error ?? 'Failed', { variant: 'error' }),
  });

  const orders = (data as any)?.orders ?? [];

  return (
    <Box>
      <PageHeader title="Sales Orders" subtitle="Made-to-order bookings with advance payment & auto material reservation"
        breadcrumbs={[{ label: 'Orders', path: '/orders' }, { label: 'Sales Orders' }]}
        actions={[{ label: 'New Order', icon: <Add />, onClick: () => setCreateOpen(true) }]} />

      <Card sx={{ mb: 2, p: 1.5 }}>
        <Grid container spacing={2} alignItems="center">
          <Grid item xs={4}><TextField select fullWidth size="small" label="Status" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}><MenuItem value="">All</MenuItem>{ORDER_STATUSES.map((s) => <MenuItem key={s} value={s}>{s}</MenuItem>)}</TextField></Grid>
          <Grid item><Typography variant="caption" color="text.secondary">{(data as any)?.total ?? 0} orders</Typography></Grid>
        </Grid>
      </Card>

      <Card>
        <Box sx={{ overflowX: 'auto' }}>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>Order #</TableCell><TableCell>Client</TableCell><TableCell>Date</TableCell>
              <TableCell>Delivery</TableCell><TableCell align="right">Value (₹)</TableCell>
              <TableCell>Advance</TableCell><TableCell>Priority</TableCell><TableCell>Status</TableCell><TableCell>Jobs</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {isLoading ? <TableRow><TableCell colSpan={9} align="center" sx={{ py: 4 }}>Loading...</TableCell></TableRow>
              : orders.map((o: any) => (
                <TableRow key={o.id} hover>
                  <TableCell sx={{ fontFamily: 'monospace', fontSize: 12, fontWeight: 700, color: '#44C47A' }}>{o.orderNumber}</TableCell>
                  <TableCell sx={{ fontWeight: 600 }}>{o.client?.name}</TableCell>
                  <TableCell sx={{ fontSize: 12 }}>{new Date(o.orderDate).toLocaleDateString('en-IN')}</TableCell>
                  <TableCell sx={{ fontSize: 12 }}>{o.deliveryDate ? new Date(o.deliveryDate).toLocaleDateString('en-IN') : '—'}</TableCell>
                  <TableCell align="right" sx={{ fontFamily: 'monospace' }}>₹{Number(o.totalEstimated ?? 0).toLocaleString('en-IN')}</TableCell>
                  <TableCell sx={{ fontFamily: 'monospace', fontSize: 12, color: Number(o.advanceAmount) > 0 ? 'success.main' : 'text.secondary' }}>
                    {Number(o.advanceAmount) > 0 ? `₹${Number(o.advanceAmount).toLocaleString('en-IN')}` : '—'}
                  </TableCell>
                  <TableCell><Chip label={o.priority} size="small" color={o.priority === 'URGENT' ? 'error' : o.priority === 'HIGH' ? 'warning' : 'default'} /></TableCell>
                  <TableCell><StatusChip status={o.status} /></TableCell>
                  <TableCell align="center">{o._count?.jobCards ?? 0}</TableCell>
                </TableRow>
              ))}
          </TableBody>
        </Table>
        </Box>
      </Card>

      <Dialog open={createOpen} onClose={() => setCreateOpen(false)} maxWidth="md" fullWidth>
        <form onSubmit={handleSubmit((d) => mutation.mutate(d))}>
          <DialogTitle fontWeight={700}>New Sales Order</DialogTitle>
          <DialogContent sx={{ pt: 2 }}>
            <Alert severity="info" sx={{ mb: 2 }}>Materials will be automatically reserved upon order creation.</Alert>
            <Grid container spacing={2} sx={{ mb: 2 }}>
              <Grid item xs={6}><Controller name="clientId" control={control} rules={{ required: true }} render={({ field }) => <TextField {...field} select fullWidth label="Client">{(clients ?? []).map((c: any) => <MenuItem key={c.id} value={c.id}>{c.clientCode} — {c.name}</MenuItem>)}</TextField>} /></Grid>
              <Grid item xs={3}><Controller name="orderDate" control={control} render={({ field }) => <TextField {...field} fullWidth label="Order Date" type="date" InputLabelProps={{ shrink: true }} />} /></Grid>
              <Grid item xs={3}><Controller name="deliveryDate" control={control} render={({ field }) => <TextField {...field} fullWidth label="Delivery Date" type="date" InputLabelProps={{ shrink: true }} />} /></Grid>
              <Grid item xs={3}><Controller name="priority" control={control} render={({ field }) => <TextField {...field} select fullWidth label="Priority"><MenuItem value="NORMAL">Normal</MenuItem><MenuItem value="HIGH">High</MenuItem><MenuItem value="URGENT">Urgent</MenuItem></TextField>} /></Grid>
              <Grid item xs={3}><Controller name="advanceAmount" control={control} render={({ field }) => <TextField {...field} fullWidth label="Advance Amount (₹)" type="number" />} /></Grid>
              <Grid item xs={3}><Controller name="advanceType" control={control} render={({ field }) => <TextField {...field} select fullWidth label="Advance Mode"><MenuItem value="CASH">Cash</MenuItem><MenuItem value="BANK">Bank Transfer</MenuItem><MenuItem value="METAL">Metal Exchange</MenuItem></TextField>} /></Grid>
              <Grid item xs={3}><Controller name="specialInstructions" control={control} render={({ field }) => <TextField {...field} fullWidth label="Special Instructions" />} /></Grid>
            </Grid>

            <Typography variant="subtitle2" fontWeight={700} gutterBottom>Order Items</Typography>
            {fields.map((f, idx) => (
              <Grid container spacing={2} key={f.id} sx={{ mb: 1 }} alignItems="center">
                <Grid item xs={5}><Controller name={`items.${idx}.designId`} control={control} rules={{ required: true }} render={({ field }) => <TextField {...field} select fullWidth size="small" label="Design">{((designs as any)?.designs ?? []).map((d: any) => <MenuItem key={d.id} value={d.id}>{d.designCode} — {d.name}</MenuItem>)}</TextField>} /></Grid>
                <Grid item xs={2}><Controller name={`items.${idx}.quantity`} control={control} render={({ field }) => <TextField {...field} fullWidth size="small" label="Qty" type="number" inputProps={{ min: 1 }} />} /></Grid>
                <Grid item xs={3}><Controller name={`items.${idx}.unitPrice`} control={control} render={({ field }) => <TextField {...field} fullWidth size="small" label="Unit Price (₹)" type="number" />} /></Grid>
                <Grid item xs={2}><Button size="small" color="error" onClick={() => remove(idx)}>✕</Button></Grid>
              </Grid>
            ))}
            <Button size="small" startIcon={<Add />} onClick={() => append({ designId: '', quantity: 1, unitPrice: 0, customizations: {} })}>Add Item</Button>
          </DialogContent>
          <DialogActions sx={{ p: 2.5 }}><Button onClick={() => setCreateOpen(false)}>Cancel</Button><Button type="submit" variant="contained" disabled={mutation.isPending}>Create Order</Button></DialogActions>
        </form>
      </Dialog>
    </Box>
  );
}
