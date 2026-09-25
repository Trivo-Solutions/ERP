import { useState } from 'react';
import {
  Box, Card, Table, TableHead, TableBody, TableRow, TableCell, Typography, Button,
  Chip, Alert, Grid, MenuItem, TextField, Dialog, DialogTitle, DialogContent,
  DialogActions, Drawer, Stack, Divider, IconButton, Checkbox, CircularProgress,
  Autocomplete,
} from '@mui/material';
import { Add, Warning, Close, Undo, Receipt } from '@mui/icons-material';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm, Controller, useFieldArray } from 'react-hook-form';
import { useSnackbar } from 'notistack';
import { differenceInDays } from 'date-fns';
import { apiGet, apiPost } from '../../api/client';
import { PageHeader } from '../../components/common/PageHeader';
import { StatusChip } from '../../components/common/StatusChip';

function fmt(n: number) {
  return '₹' + Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 });
}

// ─── Create Memo Dialog (with tag selector) ───────────────────────────────────

function CreateMemoDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { enqueueSnackbar } = useSnackbar();
  const qc = useQueryClient();
  const [tagSearch, setTagSearch] = useState('');
  const [selectedTags, setSelectedTags] = useState<any[]>([]);

  const { data: clients } = useQuery({
    queryKey: ['clients-list'],
    queryFn: () => apiGet<any>('/orders/clients'),
    enabled: open,
  });
  const clientList: any[] = (clients as any)?.clients ?? (clients as any)?.data ?? clients ?? [];

  const { data: tagResults } = useQuery({
    queryKey: ['tag-search-memo', tagSearch],
    queryFn: () => apiGet<any>('/tagging/tags/search', { q: tagSearch, status: 'IN_STOCK' }),
    enabled: tagSearch.length >= 1,
  });
  const searchOptions: any[] = (tagResults as any)?.data ?? tagResults ?? [];

  const { control, handleSubmit, reset, watch } = useForm({
    defaultValues: {
      clientId: '',
      sentDate: new Date().toISOString().split('T')[0],
      returnDeadline: '',
      notes: '',
    },
  });

  const mutation = useMutation({
    mutationFn: (data: any) => apiPost('/sales/memos', {
      ...data,
      sentDate: new Date(data.sentDate),
      returnDeadline: new Date(data.returnDeadline),
      items: selectedTags.map((tag) => ({
        productCode: tag.tagNumber,
        description: tag.name,
        huid: tag.huid ?? undefined,
        karat: tag.metalKarat ?? undefined,
        pieces: 1,
        grossWeight: Number(tag.grossWeight),
        netGoldWeight: Number(tag.netWeight),
        stoneWeight: Number(tag.stoneWeight ?? 0),
        estimatedValue: Number(tag.sellingPrice),
        tagId: tag.id,
      })),
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['memos'] });
      onClose();
      reset();
      setSelectedTags([]);
      enqueueSnackbar('Approval memo created', { variant: 'success' });
    },
    onError: (e: any) => enqueueSnackbar(e.response?.data?.error ?? 'Failed', { variant: 'error' }),
  });

  const handleClose = () => { onClose(); reset(); setSelectedTags([]); };

  return (
    <Dialog open={open} onClose={handleClose} maxWidth="md" fullWidth>
      <form onSubmit={handleSubmit((d) => mutation.mutate(d))}>
        <DialogTitle fontWeight={700}>Send on Approval</DialogTitle>
        <DialogContent sx={{ pt: 2 }}>
          <Grid container spacing={2}>
            <Grid item xs={6}>
              <Controller name="clientId" control={control} rules={{ required: true }}
                render={({ field, fieldState }) => (
                  <TextField {...field} select fullWidth label="Client *" error={!!fieldState.error}>
                    {clientList.map((c: any) => (
                      <MenuItem key={c.id} value={c.id}>{c.clientCode} — {c.name}</MenuItem>
                    ))}
                  </TextField>
                )} />
            </Grid>
            <Grid item xs={3}>
              <Controller name="sentDate" control={control}
                render={({ field }) => (
                  <TextField {...field} fullWidth label="Sent Date" type="date" InputLabelProps={{ shrink: true }} />
                )} />
            </Grid>
            <Grid item xs={3}>
              <Controller name="returnDeadline" control={control} rules={{ required: true }}
                render={({ field, fieldState }) => (
                  <TextField {...field} fullWidth label="Return Deadline *" type="date"
                    InputLabelProps={{ shrink: true }} error={!!fieldState.error} />
                )} />
            </Grid>
            <Grid item xs={12}>
              <Controller name="notes" control={control}
                render={({ field }) => <TextField {...field} fullWidth label="Notes" />} />
            </Grid>

            <Grid item xs={12}>
              <Autocomplete
                options={searchOptions.filter((o) => !selectedTags.find((t) => t.id === o.id))}
                getOptionLabel={(o) => `${o.tagNumber} — ${o.name} (${fmt(Number(o.sellingPrice))})`}
                filterOptions={(x) => x}
                onInputChange={(_, v) => setTagSearch(v)}
                onChange={(_, val) => { if (val) { setSelectedTags((p) => [...p, val]); setTagSearch(''); } }}
                renderInput={(params) => (
                  <TextField {...params} label="Add tags on approval (search by tag number or name)" />
                )}
                noOptionsText={tagSearch.length < 1 ? 'Type to search IN_STOCK tags' : 'No tags found'}
              />
            </Grid>

            {selectedTags.length > 0 && (
              <Grid item xs={12}>
                <Box sx={{ overflowX: 'auto' }}>
                <Table size="small">
                  <TableHead>
                    <TableRow>
                      <TableCell>Tag</TableCell><TableCell>Name</TableCell>
                      <TableCell>Karat</TableCell><TableCell align="right">Wt (g)</TableCell>
                      <TableCell align="right">Value</TableCell><TableCell />
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {selectedTags.map((tag) => (
                      <TableRow key={tag.id}>
                        <TableCell sx={{ fontFamily: 'monospace', fontSize: 11, color: '#44C47A' }}>{tag.tagNumber}</TableCell>
                        <TableCell>{tag.name}</TableCell>
                        <TableCell>{tag.metalKarat || '—'}</TableCell>
                        <TableCell align="right" sx={{ fontFamily: 'monospace' }}>{Number(tag.grossWeight).toFixed(3)}</TableCell>
                        <TableCell align="right" sx={{ fontFamily: 'monospace' }}>{fmt(Number(tag.sellingPrice))}</TableCell>
                        <TableCell>
                          <IconButton size="small" color="error"
                            onClick={() => setSelectedTags((p) => p.filter((t) => t.id !== tag.id))}>
                            <Close fontSize="small" />
                          </IconButton>
                        </TableCell>
                      </TableRow>
                    ))}
                    <TableRow>
                      <TableCell colSpan={4} align="right" sx={{ fontWeight: 700 }}>Total</TableCell>
                      <TableCell align="right" sx={{ fontFamily: 'monospace', fontWeight: 700 }}>
                        {fmt(selectedTags.reduce((s, t) => s + Number(t.sellingPrice), 0))}
                      </TableCell>
                      <TableCell />
                    </TableRow>
                  </TableBody>
                </Table>
                </Box>
              </Grid>
            )}
          </Grid>
        </DialogContent>
        <DialogActions sx={{ p: 2.5 }}>
          <Button onClick={handleClose}>Cancel</Button>
          <Button type="submit" variant="contained"
            disabled={mutation.isPending || selectedTags.length === 0}>
            Send on Approval
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  );
}

// ─── Convert to Invoice Dialog ────────────────────────────────────────────────

function ConvertDialog({ memo, open, onClose }: { memo: any; open: boolean; onClose: () => void }) {
  const { enqueueSnackbar } = useSnackbar();
  const qc = useQueryClient();

  // Build editable rows for items still OUT (with a tag)
  const outItems = (memo?.items ?? []).filter((i: any) => i.status === 'OUT' && i.tagId);

  const { control, handleSubmit } = useForm({
    defaultValues: {
      items: outItems.map((i: any) => ({
        tagId: i.tagId,
        sellingPrice: Number(i.estimatedValue),
        description: i.description,
      })),
    },
  });
  const { fields } = useFieldArray({ control, name: 'items' });

  const mutation = useMutation({
    mutationFn: (data: any) => apiPost(`/sales/memos/${memo.id}/convert`, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['memos'] });
      onClose();
      enqueueSnackbar('Converted to invoice successfully', { variant: 'success' });
    },
    onError: (e: any) => enqueueSnackbar(e.response?.data?.error ?? 'Failed', { variant: 'error' }),
  });

  return (
    <Dialog open={open} onClose={onClose} maxWidth="md" fullWidth>
      <form onSubmit={handleSubmit((d) => mutation.mutate(d))}>
        <DialogTitle fontWeight={700}>Convert to Invoice — {memo?.memoNumber}</DialogTitle>
        <DialogContent sx={{ pt: 2 }}>
          <Alert severity="info" sx={{ mb: 2 }}>
            Edit the selling price for each item before converting. GST (3%) will be applied automatically.
          </Alert>
          <Box sx={{ overflowX: 'auto' }}>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Tag</TableCell>
                <TableCell>Description</TableCell>
                <TableCell>Karat</TableCell>
                <TableCell align="right">Wt (g)</TableCell>
                <TableCell align="right" sx={{ minWidth: 140 }}>Selling Price (₹)</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {fields.map((field, idx) => {
                const memoItem = outItems[idx];
                return (
                  <TableRow key={field.id}>
                    <TableCell sx={{ fontFamily: 'monospace', fontSize: 11, color: '#44C47A' }}>
                      {memoItem?.tag?.tagNumber ?? memoItem?.productCode}
                    </TableCell>
                    <TableCell>{memoItem?.description}</TableCell>
                    <TableCell>{memoItem?.karat || '—'}</TableCell>
                    <TableCell align="right" sx={{ fontFamily: 'monospace' }}>
                      {Number(memoItem?.grossWeight ?? 0).toFixed(3)}
                    </TableCell>
                    <TableCell align="right">
                      <Controller name={`items.${idx}.sellingPrice`} control={control}
                        render={({ field: f }) => (
                          <TextField {...f} size="small" type="number"
                            inputProps={{ step: 0.01, min: 0, style: { textAlign: 'right', width: 120 } }} />
                        )} />
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
          </Box>
        </DialogContent>
        <DialogActions sx={{ p: 2.5 }}>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="contained" startIcon={<Receipt />} disabled={mutation.isPending}>
            Create Invoice
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  );
}

// ─── Memo Detail Drawer ───────────────────────────────────────────────────────

function MemoDrawer({ memoId, onClose }: { memoId: string; onClose: () => void }) {
  const { enqueueSnackbar } = useSnackbar();
  const qc = useQueryClient();
  const [returnSelected, setReturnSelected] = useState<string[]>([]);
  const [convertOpen, setConvertOpen] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ['memo-detail', memoId],
    queryFn: () => apiGet<any>(`/sales/memos?status=`),
    select: (d: any) => (d?.data ?? d ?? []).find((m: any) => m.id === memoId),
    enabled: !!memoId,
  });
  const memo = data;

  const returnMut = useMutation({
    mutationFn: () => apiPost(`/sales/memos/${memoId}/return`, { tagIds: returnSelected }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['memos'] });
      qc.invalidateQueries({ queryKey: ['memo-detail', memoId] });
      setReturnSelected([]);
      enqueueSnackbar('Items returned', { variant: 'success' });
    },
    onError: (e: any) => enqueueSnackbar(e.response?.data?.error ?? 'Failed', { variant: 'error' }),
  });

  const outItems = (memo?.items ?? []).filter((i: any) => i.status === 'OUT');
  const canReturn = returnSelected.length > 0;
  const canConvert = outItems.some((i: any) => i.tagId);

  return (
    <Drawer anchor="right" open={!!memoId} onClose={onClose} PaperProps={{ sx: { width: 640 } }}>
      <Box sx={{ p: 3, height: '100%', overflow: 'auto' }}>
        <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 2 }}>
          <Typography variant="h6" fontWeight={700}>Approval Memo</Typography>
          <IconButton onClick={onClose}><Close /></IconButton>
        </Stack>

        {isLoading && <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}><CircularProgress /></Box>}

        {memo && (
          <>
            <Grid container spacing={1.5} sx={{ mb: 2 }}>
              <Grid item xs={6}>
                <Typography variant="caption" color="text.secondary">Memo Number</Typography>
                <Typography fontWeight={900} fontFamily="monospace" color="#44C47A">{memo.memoNumber}</Typography>
              </Grid>
              <Grid item xs={6}>
                <Typography variant="caption" color="text.secondary">Status</Typography>
                <Box><StatusChip status={memo.status} /></Box>
              </Grid>
              <Grid item xs={6}>
                <Typography variant="caption" color="text.secondary">Client</Typography>
                <Typography fontWeight={700}>{memo.client?.name}</Typography>
              </Grid>
              <Grid item xs={3}>
                <Typography variant="caption" color="text.secondary">Sent Date</Typography>
                <Typography>{new Date(memo.sentDate).toLocaleDateString('en-IN')}</Typography>
              </Grid>
              <Grid item xs={3}>
                <Typography variant="caption" color="text.secondary">Return Deadline</Typography>
                <Typography color={new Date(memo.returnDeadline) < new Date() ? 'error.main' : 'inherit'}>
                  {new Date(memo.returnDeadline).toLocaleDateString('en-IN')}
                </Typography>
              </Grid>
              <Grid item xs={6}>
                <Typography variant="caption" color="text.secondary">Total Value</Typography>
                <Typography fontWeight={700}>{fmt(Number(memo.totalValue))}</Typography>
              </Grid>
            </Grid>

            <Divider sx={{ my: 2 }} />
            <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 1 }}>
              <Typography variant="subtitle2" fontWeight={700}>Items</Typography>
              {canReturn && (
                <Button size="small" variant="outlined" color="warning" startIcon={<Undo />}
                  disabled={returnMut.isPending} onClick={() => returnMut.mutate()}>
                  Return {returnSelected.length} selected
                </Button>
              )}
            </Stack>

            <Box sx={{ overflowX: 'auto' }}>
            <Table size="small" sx={{ mb: 2 }}>
              <TableHead>
                <TableRow>
                  <TableCell padding="checkbox" />
                  <TableCell>Tag</TableCell>
                  <TableCell>Description</TableCell>
                  <TableCell align="right">Value</TableCell>
                  <TableCell>Status</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {(memo.items ?? []).map((item: any) => (
                  <TableRow key={item.id} sx={item.status !== 'OUT' ? { opacity: 0.5 } : {}}>
                    <TableCell padding="checkbox">
                      {item.tagId && item.status === 'OUT' && (
                        <Checkbox size="small"
                          checked={returnSelected.includes(item.tagId)}
                          onChange={(e) => setReturnSelected((p) =>
                            e.target.checked ? [...p, item.tagId] : p.filter((id) => id !== item.tagId)
                          )} />
                      )}
                    </TableCell>
                    <TableCell sx={{ fontFamily: 'monospace', fontSize: 11, color: '#44C47A' }}>
                      {item.productCode}
                    </TableCell>
                    <TableCell>{item.description}</TableCell>
                    <TableCell align="right" sx={{ fontFamily: 'monospace' }}>
                      {fmt(Number(item.estimatedValue))}
                    </TableCell>
                    <TableCell><StatusChip status={item.status} /></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            </Box>

            {memo.status === 'OUT' && canConvert && (
              <Button variant="contained" color="success" startIcon={<Receipt />}
                onClick={() => setConvertOpen(true)}>
                Convert to Invoice
              </Button>
            )}
          </>
        )}
      </Box>

      {memo && convertOpen && (
        <ConvertDialog memo={memo} open={convertOpen} onClose={() => setConvertOpen(false)} />
      )}
    </Drawer>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export function MemoOutPage() {
  const qc = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [selectedMemoId, setSelectedMemoId] = useState('');

  const { data: rawData, isLoading } = useQuery({
    queryKey: ['memos'],
    queryFn: () => apiGet<any[]>('/sales/memos'),
  });
  const memos: any[] = (rawData as any)?.data ?? rawData ?? [];

  const alertMutation = useMutation({
    mutationFn: () => apiPost('/sales/memos/check-alerts', {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['memos'] }),
  });

  const overdue = memos.filter((m: any) => new Date(m.returnDeadline) < new Date() && m.status === 'OUT');

  return (
    <Box>
      <PageHeader title="Approval Memos" subtitle="Send jewelry pieces on approval — track returns and convert to invoices"
        breadcrumbs={[{ label: 'Sales', path: '/sales/memos' }, { label: 'Approval Memos' }]}
        actions={[
          { label: 'Check Aging Alerts', onClick: () => alertMutation.mutate(), variant: 'outlined' as const },
          { label: 'Send on Approval', icon: <Add />, onClick: () => setCreateOpen(true) },
        ]} />

      {overdue.length > 0 && (
        <Alert severity="error" sx={{ mb: 2 }} icon={<Warning />}>
          <strong>{overdue.length} memo(s)</strong> past their return deadline — immediate follow-up required.
        </Alert>
      )}

      <Card>
        <Box sx={{ overflowX: 'auto' }}>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>Memo #</TableCell>
              <TableCell>Client</TableCell>
              <TableCell>Sent Date</TableCell>
              <TableCell>Return Deadline</TableCell>
              <TableCell>Days Aging</TableCell>
              <TableCell align="right">Value (₹)</TableCell>
              <TableCell align="center">Items</TableCell>
              <TableCell>Status</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {isLoading ? (
              <TableRow><TableCell colSpan={8} align="center" sx={{ py: 4 }}>Loading...</TableCell></TableRow>
            ) : memos.map((m: any) => {
              const daysLeft = differenceInDays(new Date(m.returnDeadline), new Date());
              const isOverdue = daysLeft < 0 && m.status === 'OUT';
              return (
                <TableRow key={m.id} hover sx={{ bgcolor: isOverdue ? '#FFF3F3' : 'inherit', cursor: 'pointer' }}
                  onClick={() => setSelectedMemoId(m.id)}>
                  <TableCell sx={{ fontFamily: 'monospace', fontWeight: 700, color: '#44C47A', fontSize: 12 }}>
                    {m.memoNumber}
                  </TableCell>
                  <TableCell sx={{ fontWeight: 600 }}>{m.client?.name}</TableCell>
                  <TableCell sx={{ fontSize: 12 }}>{new Date(m.sentDate).toLocaleDateString('en-IN')}</TableCell>
                  <TableCell sx={{ fontSize: 12, color: isOverdue ? 'error.main' : 'inherit', fontWeight: isOverdue ? 700 : 400 }}>
                    {new Date(m.returnDeadline).toLocaleDateString('en-IN')}
                  </TableCell>
                  <TableCell>
                    <Chip
                      label={isOverdue ? `${Math.abs(daysLeft)}d OVERDUE` : `${daysLeft}d left`}
                      size="small" sx={{ fontWeight: 700 }}
                      color={isOverdue ? 'error' : daysLeft <= 3 ? 'warning' : 'success'} />
                  </TableCell>
                  <TableCell align="right" sx={{ fontFamily: 'monospace', fontWeight: 700 }}>
                    {fmt(Number(m.totalValue))}
                  </TableCell>
                  <TableCell align="center">{m.items?.length ?? 0}</TableCell>
                  <TableCell><StatusChip status={m.status} /></TableCell>
                </TableRow>
              );
            })}
            {!isLoading && memos.length === 0 && (
              <TableRow><TableCell colSpan={8} align="center" sx={{ py: 4 }}>No approval memos</TableCell></TableRow>
            )}
          </TableBody>
        </Table>
        </Box>
      </Card>

      <CreateMemoDialog open={createOpen} onClose={() => setCreateOpen(false)} />
      {selectedMemoId && <MemoDrawer memoId={selectedMemoId} onClose={() => setSelectedMemoId('')} />}
    </Box>
  );
}
