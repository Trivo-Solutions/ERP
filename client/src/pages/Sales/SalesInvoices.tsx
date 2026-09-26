import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Box, Card, Table, TableHead, TableBody, TableRow, TableCell, Typography, Chip, Button,
  Grid, MenuItem, TextField, Drawer, Stack, Divider, IconButton, CircularProgress, Checkbox,
} from '@mui/material';
import { Add, Close, Payment as PaymentIcon, Print, Undo } from '@mui/icons-material';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm, Controller } from 'react-hook-form';
import { useSnackbar } from 'notistack';
import { apiGet, apiPost } from '../../api/client';
import { PageHeader } from '../../components/common/PageHeader';
import { StatusChip } from '../../components/common/StatusChip';
import { printInvoice } from '../../utils/printInvoice';

function fmt(n: number) {
  return '₹' + Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });
}

// ─── Invoice Detail Drawer (with Record Payment) ───────────────────────────────

function RecordPaymentForm({ invoiceId, balanceDue }: { invoiceId: string; balanceDue: number }) {
  const { enqueueSnackbar } = useSnackbar();
  const qc = useQueryClient();
  const { control, handleSubmit, reset } = useForm({
    defaultValues: {
      paymentDate: new Date().toISOString().split('T')[0],
      amount: balanceDue,
      mode: 'CASH',
      referenceNo: '',
    },
  });

  const mutation = useMutation({
    mutationFn: (data: any) => apiPost(`/sales/invoices/${invoiceId}/payment`, {
      ...data, paymentDate: new Date(data.paymentDate), amount: Number(data.amount),
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['invoice-detail', invoiceId] });
      qc.invalidateQueries({ queryKey: ['sales-invoices'] });
      reset();
      enqueueSnackbar('Payment recorded', { variant: 'success' });
    },
    onError: (e: any) => enqueueSnackbar(e.response?.data?.error ?? 'Failed to record payment', { variant: 'error' }),
  });

  return (
    <form onSubmit={handleSubmit((d) => mutation.mutate(d))}>
      <Stack direction="row" spacing={1} alignItems="flex-start">
        <Controller name="paymentDate" control={control}
          render={({ field }) => (
            <TextField {...field} size="small" type="date" label="Date" InputLabelProps={{ shrink: true }} sx={{ width: 140 }} />
          )} />
        <Controller name="amount" control={control} rules={{ required: true, min: 0.01 }}
          render={({ field, fieldState }) => (
            <TextField {...field} size="small" type="number" label="Amount" error={!!fieldState.error}
              inputProps={{ step: 0.01, min: 0 }} sx={{ width: 130 }} />
          )} />
        <Controller name="mode" control={control}
          render={({ field }) => (
            <TextField {...field} select size="small" label="Mode" sx={{ width: 130 }}>
              <MenuItem value="CASH">Cash</MenuItem>
              <MenuItem value="CARD">Card</MenuItem>
              <MenuItem value="UPI">UPI</MenuItem>
              <MenuItem value="BANK_TRANSFER">Bank Transfer</MenuItem>
              <MenuItem value="CHEQUE">Cheque</MenuItem>
            </TextField>
          )} />
        <Controller name="referenceNo" control={control}
          render={({ field }) => <TextField {...field} size="small" label="Reference #" sx={{ width: 140 }} />} />
        <Button type="submit" variant="contained" size="small" startIcon={<PaymentIcon />}
          disabled={mutation.isPending} sx={{ height: 40 }}>
          Record
        </Button>
      </Stack>
    </form>
  );
}

// D1: return one or more tagged lines from this invoice. Only tagged lines are selectable (a
// free-text line has no physical piece to take back — the server rejects it too, this just keeps
// the clerk from picking one). Already-returned lines are excluded from selection entirely.
function ReturnItemsForm({ invoiceId, items, alreadyReturnedIds }: {
  invoiceId: string; items: any[]; alreadyReturnedIds: Set<string>;
}) {
  const { enqueueSnackbar } = useSnackbar();
  const qc = useQueryClient();
  const [selected, setSelected] = useState<string[]>([]);
  const [reason, setReason] = useState('');

  const returnable = items.filter((i) => i.tagId && !alreadyReturnedIds.has(i.id));

  const toggle = (id: string) => {
    setSelected((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  };

  const mutation = useMutation({
    mutationFn: () => apiPost('/sales/returns', {
      invoiceId,
      items: selected.map((invoiceItemId) => ({ invoiceItemId })),
      reason: reason || undefined,
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['invoice-detail', invoiceId] });
      qc.invalidateQueries({ queryKey: ['sales-invoices'] });
      qc.invalidateQueries({ queryKey: ['invoice-returns', invoiceId] });
      setSelected([]);
      setReason('');
      enqueueSnackbar('Return recorded — tag(s) back in stock', { variant: 'success' });
    },
    onError: (e: any) => enqueueSnackbar(e.response?.data?.error ?? 'Failed to record return', { variant: 'error' }),
  });

  if (returnable.length === 0) return null;

  return (
    <Box>
      <Stack spacing={1}>
        {returnable.map((item) => (
          <Stack key={item.id} direction="row" alignItems="center" spacing={1}>
            <Checkbox size="small" checked={selected.includes(item.id)} onChange={() => toggle(item.id)} />
            <Typography variant="body2" sx={{ fontFamily: 'monospace', flex: 1 }}>{item.productCode}</Typography>
            <Typography variant="body2" color="text.secondary">{item.description}</Typography>
            <Typography variant="body2" sx={{ fontFamily: 'monospace' }}>{fmt(Number(item.totalPrice))}</Typography>
          </Stack>
        ))}
        <Stack direction="row" spacing={1} alignItems="flex-start" sx={{ pt: 1 }}>
          <TextField size="small" label="Reason (optional)" value={reason}
            onChange={(e) => setReason(e.target.value)} sx={{ flex: 1 }} />
          <Button variant="contained" color="warning" size="small" startIcon={<Undo />}
            disabled={selected.length === 0 || mutation.isPending}
            onClick={() => mutation.mutate()} sx={{ height: 40 }}>
            Return Selected
          </Button>
        </Stack>
      </Stack>
    </Box>
  );
}

function InvoiceDrawer({ invoiceId, onClose }: { invoiceId: string; onClose: () => void }) {
  const { data, isLoading } = useQuery({
    queryKey: ['invoice-detail', invoiceId],
    queryFn: () => apiGet<any>(`/sales/invoices/${invoiceId}`),
    enabled: !!invoiceId,
  });
  const invoice = data;

  const { data: returnsData } = useQuery({
    queryKey: ['invoice-returns', invoiceId],
    queryFn: () => apiGet<any[]>('/sales/returns', { invoiceId }),
    enabled: !!invoiceId,
  });
  const returns: any[] = returnsData ?? [];
  const returnedItemIds = new Set(returns.flatMap((r) => r.items.map((i: any) => i.invoiceItemId)));

  return (
    <Drawer anchor="right" open={!!invoiceId} onClose={onClose} PaperProps={{ sx: { width: 640 } }}>
      <Box sx={{ p: 3, height: '100%', overflow: 'auto' }}>
        <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 2 }}>
          <Typography variant="h6" fontWeight={700}>Sales Invoice</Typography>
          <Stack direction="row" spacing={0.5} alignItems="center">
            {invoice && (
              <Button size="small" startIcon={<Print />} onClick={() => printInvoice(invoice)}>
                Print
              </Button>
            )}
            <IconButton onClick={onClose}><Close /></IconButton>
          </Stack>
        </Stack>

        {isLoading && <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}><CircularProgress /></Box>}

        {invoice && (
          <>
            <Grid container spacing={1.5} sx={{ mb: 2 }}>
              <Grid item xs={6}>
                <Typography variant="caption" color="text.secondary">Invoice Number</Typography>
                <Typography fontWeight={900} fontFamily="monospace" color="#44C47A">{invoice.invoiceNumber}</Typography>
              </Grid>
              <Grid item xs={6}>
                <Typography variant="caption" color="text.secondary">Status</Typography>
                <Box><StatusChip status={invoice.status} /></Box>
              </Grid>
              <Grid item xs={6}>
                <Typography variant="caption" color="text.secondary">Client</Typography>
                <Typography fontWeight={700}>{invoice.client?.name}</Typography>
              </Grid>
              <Grid item xs={3}>
                <Typography variant="caption" color="text.secondary">Type</Typography>
                <Typography>{invoice.invoiceType}</Typography>
              </Grid>
              <Grid item xs={3}>
                <Typography variant="caption" color="text.secondary">Date</Typography>
                <Typography>{new Date(invoice.invoiceDate).toLocaleDateString('en-IN')}</Typography>
              </Grid>
              <Grid item xs={6}>
                <Typography variant="caption" color="text.secondary">Sales Executive</Typography>
                <Typography>{invoice.salesPerson?.name ?? '—'}</Typography>
              </Grid>
              <Grid item xs={6}>
                <Typography variant="caption" color="text.secondary">Terms</Typography>
                <Typography>{invoice.terms ?? '—'}</Typography>
              </Grid>
            </Grid>

            <Divider sx={{ my: 2 }} />
            <Typography variant="subtitle2" fontWeight={700} sx={{ mb: 1 }}>Items</Typography>
            <Table size="small" sx={{ mb: 2 }}>
              <TableHead>
                <TableRow>
                  <TableCell>Tag / Code</TableCell>
                  <TableCell>Description</TableCell>
                  <TableCell>Category</TableCell>
                  <TableCell align="right">Wt (g)</TableCell>
                  <TableCell align="right">Total</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {(invoice.items ?? []).map((item: any) => (
                  <TableRow key={item.id}>
                    <TableCell sx={{ fontFamily: 'monospace', fontSize: 11, color: item.tagId ? '#44C47A' : 'inherit' }}>
                      {item.productCode}
                      {returnedItemIds.has(item.id) && (
                        <Chip label="Returned" size="small" color="warning" sx={{ ml: 0.5, height: 16, fontSize: 9 }} />
                      )}
                    </TableCell>
                    <TableCell>{item.description}</TableCell>
                    <TableCell>{item.category?.name ?? '—'}</TableCell>
                    <TableCell align="right" sx={{ fontFamily: 'monospace' }}>{Number(item.netGoldWeight).toFixed(3)}</TableCell>
                    <TableCell align="right" sx={{ fontFamily: 'monospace' }}>{fmt(Number(item.totalPrice))}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>

            <ReturnItemsForm invoiceId={invoice.id} items={invoice.items ?? []} alreadyReturnedIds={returnedItemIds} />

            {returns.length > 0 && (
              <Box sx={{ mt: 2, mb: 2 }}>
                <Typography variant="subtitle2" fontWeight={700} sx={{ mb: 1 }}>Returns</Typography>
                <Table size="small">
                  <TableBody>
                    {returns.map((r: any) => (
                      <TableRow key={r.id}>
                        <TableCell sx={{ fontFamily: 'monospace', fontSize: 12 }}>{r.returnNumber}</TableCell>
                        <TableCell sx={{ fontSize: 12 }}>{new Date(r.returnDate).toLocaleDateString('en-IN')}</TableCell>
                        <TableCell sx={{ fontSize: 12 }}>{r.reason || '—'}</TableCell>
                        <TableCell align="right" sx={{ fontFamily: 'monospace', color: 'warning.main' }}>
                          {fmt(Number(r.totalAmount))}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </Box>
            )}

            {invoice.taxDetails && (
              <Box sx={{ mb: 2 }}>
                <Typography variant="subtitle2" fontWeight={700} sx={{ mb: 1 }}>GST</Typography>
                <Stack spacing={0.5} sx={{ fontSize: 13 }}>
                  <Stack direction="row" justifyContent="space-between">
                    <Typography variant="body2" color="text.secondary">Place of Supply</Typography>
                    <Typography variant="body2">{invoice.taxDetails.placeOfSupply || '—'}</Typography>
                  </Stack>
                  <Stack direction="row" justifyContent="space-between">
                    <Typography variant="body2" color="text.secondary">CGST + SGST</Typography>
                    <Typography variant="body2" sx={{ fontFamily: 'monospace' }}>
                      {fmt(Number(invoice.taxDetails.cgst) + Number(invoice.taxDetails.sgst))}
                    </Typography>
                  </Stack>
                  <Stack direction="row" justifyContent="space-between">
                    <Typography variant="body2" color="text.secondary">IGST</Typography>
                    <Typography variant="body2" sx={{ fontFamily: 'monospace' }}>{fmt(Number(invoice.taxDetails.igst))}</Typography>
                  </Stack>
                </Stack>
              </Box>
            )}

            <Divider sx={{ my: 2 }} />
            <Stack spacing={0.5} sx={{ mb: 2 }}>
              <Stack direction="row" justifyContent="space-between">
                <Typography color="text.secondary">Total</Typography>
                <Typography fontWeight={700} sx={{ fontFamily: 'monospace' }}>{fmt(Number(invoice.totalAmount))}</Typography>
              </Stack>
              <Stack direction="row" justifyContent="space-between">
                <Typography color="text.secondary">Paid</Typography>
                <Typography sx={{ fontFamily: 'monospace', color: 'success.main' }}>{fmt(Number(invoice.paidAmount))}</Typography>
              </Stack>
              <Stack direction="row" justifyContent="space-between">
                <Typography color="text.secondary">Balance Due</Typography>
                <Typography fontWeight={700} sx={{ fontFamily: 'monospace', color: Number(invoice.balanceDue) > 0 ? 'error.main' : 'success.main' }}>
                  {fmt(Number(invoice.balanceDue))}
                </Typography>
              </Stack>
            </Stack>

            {(invoice.payments ?? []).length > 0 && (
              <Box sx={{ mb: 2 }}>
                <Typography variant="subtitle2" fontWeight={700} sx={{ mb: 1 }}>Payments</Typography>
                <Table size="small">
                  <TableBody>
                    {invoice.payments.map((p: any) => (
                      <TableRow key={p.id}>
                        <TableCell sx={{ fontSize: 12 }}>{new Date(p.paymentDate).toLocaleDateString('en-IN')}</TableCell>
                        <TableCell><Chip label={p.mode} size="small" /></TableCell>
                        <TableCell align="right" sx={{ fontFamily: 'monospace' }}>{fmt(Number(p.amount))}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </Box>
            )}

            {Number(invoice.balanceDue) > 0 && (
              <>
                <Divider sx={{ my: 2 }} />
                <Typography variant="subtitle2" fontWeight={700} sx={{ mb: 1 }}>Record Payment</Typography>
                <RecordPaymentForm invoiceId={invoice.id} balanceDue={Number(invoice.balanceDue)} />
              </>
            )}
          </>
        )}
      </Box>
    </Drawer>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export function SalesInvoices() {
  const navigate = useNavigate();
  const [selectedInvoiceId, setSelectedInvoiceId] = useState('');

  const { data, isLoading } = useQuery({ queryKey: ['sales-invoices'], queryFn: () => apiGet<any[]>('/sales/invoices') });

  return (
    <Box>
      <PageHeader title="Sales Invoices"
        actions={[{ label: 'New Sale', icon: <Add />, onClick: () => navigate('/sales/invoices/new') }]} />
      <Card>
        <Box sx={{ overflowX: 'auto' }}>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>Invoice #</TableCell><TableCell>Client</TableCell><TableCell>Date</TableCell>
              <TableCell>Type</TableCell><TableCell>Currency</TableCell>
              <TableCell align="right">Total</TableCell><TableCell align="right">Paid</TableCell>
              <TableCell align="right">Balance</TableCell><TableCell>Status</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {isLoading ? <TableRow><TableCell colSpan={9} align="center" sx={{ py: 4 }}>Loading...</TableCell></TableRow>
              : (data ?? []).map((inv: any) => (
                <TableRow key={inv.id} hover sx={{ cursor: 'pointer' }} onClick={() => setSelectedInvoiceId(inv.id)}>
                  <TableCell sx={{ fontFamily: 'monospace', fontWeight: 700, color: '#44C47A', fontSize: 12 }}>{inv.invoiceNumber}</TableCell>
                  <TableCell sx={{ fontWeight: 600 }}>{inv.client?.name}</TableCell>
                  <TableCell sx={{ fontSize: 12 }}>{new Date(inv.invoiceDate).toLocaleDateString('en-IN')}</TableCell>
                  <TableCell><Chip label={inv.invoiceType} size="small" /></TableCell>
                  <TableCell><Chip label={inv.currency} size="small" color={inv.currency !== 'INR' ? 'info' : 'default'} /></TableCell>
                  <TableCell align="right" sx={{ fontFamily: 'monospace', fontWeight: 700 }}>{inv.currency === 'INR' ? '₹' : '$'}{Number(inv.totalAmount).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</TableCell>
                  <TableCell align="right" sx={{ fontFamily: 'monospace', color: 'success.main' }}>{Number(inv.paidAmount).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</TableCell>
                  <TableCell align="right" sx={{ fontFamily: 'monospace', color: Number(inv.balanceDue) > 0 ? 'error.main' : 'success.main', fontWeight: 700 }}>
                    {Number(inv.balanceDue).toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                  </TableCell>
                  <TableCell><StatusChip status={inv.status} /></TableCell>
                </TableRow>
              ))}
            {!isLoading && (data ?? []).length === 0 && (
              <TableRow><TableCell colSpan={9} align="center" sx={{ py: 4 }}>No sales invoices yet</TableCell></TableRow>
            )}
          </TableBody>
        </Table>
        </Box>
      </Card>

      {selectedInvoiceId && <InvoiceDrawer invoiceId={selectedInvoiceId} onClose={() => setSelectedInvoiceId('')} />}
    </Box>
  );
}
