import { useState } from 'react';
import {
  Box, Card, Table, TableHead, TableBody, TableRow, TableCell, Typography, Button,
  Grid, MenuItem, TextField, Dialog, DialogTitle, DialogContent, DialogActions,
  Drawer, Stack, Divider, IconButton, Chip, CircularProgress, Alert,
  Autocomplete,
} from '@mui/material';
import { Add, Close, Send, CheckCircle, Cancel, MoveDown } from '@mui/icons-material';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm, Controller } from 'react-hook-form';
import { useSnackbar } from 'notistack';
import { apiGet, apiPost } from '../../api/client';
import { PageHeader } from '../../components/common/PageHeader';
import { StatusChip } from '../../components/common/StatusChip';
import { useAuthStore } from '../../store/auth.store';

const TRANSFER_STATUSES = ['DRAFT', 'PENDING_APPROVAL', 'DISPATCHED', 'RECEIVED', 'CANCELLED'];

// ─── Create Transfer Dialog ───────────────────────────────────────────────────

function CreateTransferDialog({ open, onClose, branches }: {
  open: boolean; onClose: () => void; branches: any[];
}) {
  const { enqueueSnackbar } = useSnackbar();
  const qc = useQueryClient();
  const [selectedTags, setSelectedTags] = useState<any[]>([]);
  const [tagSearch, setTagSearch] = useState('');

  const { control, handleSubmit, reset, watch } = useForm({
    defaultValues: { fromBranchId: '', toBranchId: '', notes: '' },
  });
  const fromBranchId = watch('fromBranchId');

  const { data: tagResults } = useQuery({
    queryKey: ['tag-search', tagSearch, fromBranchId],
    queryFn: () => apiGet<any>('/tagging/tags/search', { q: tagSearch, branchId: fromBranchId, status: 'IN_STOCK' }),
    enabled: tagSearch.length >= 1 && !!fromBranchId,
  });
  const searchOptions: any[] = (tagResults as any)?.data ?? (tagResults as any) ?? [];

  const mutation = useMutation({
    mutationFn: (data: any) => apiPost('/tagging/transfers', {
      ...data,
      tagIds: selectedTags.map((t) => t.id),
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['branch-transfers'] });
      onClose();
      reset();
      setSelectedTags([]);
      enqueueSnackbar('Transfer created', { variant: 'success' });
    },
    onError: (e: any) => enqueueSnackbar(e.response?.data?.error ?? 'Failed', { variant: 'error' }),
  });

  const handleClose = () => { onClose(); reset(); setSelectedTags([]); };

  return (
    <Dialog open={open} onClose={handleClose} maxWidth="md" fullWidth>
      <form onSubmit={handleSubmit((d) => mutation.mutate(d))}>
        <DialogTitle fontWeight={700}>New Branch Transfer</DialogTitle>
        <DialogContent sx={{ pt: 2 }}>
          <Grid container spacing={2}>
            <Grid item xs={6}>
              <Controller name="fromBranchId" control={control} rules={{ required: true }}
                render={({ field, fieldState }) => (
                  <TextField {...field} select fullWidth label="From Branch *" error={!!fieldState.error}>
                    {branches.map((b: any) => <MenuItem key={b.id} value={b.id}>{b.name}</MenuItem>)}
                  </TextField>
                )} />
            </Grid>
            <Grid item xs={6}>
              <Controller name="toBranchId" control={control} rules={{ required: true }}
                render={({ field, fieldState }) => (
                  <TextField {...field} select fullWidth label="To Branch *" error={!!fieldState.error}>
                    {branches.filter((b) => b.id !== fromBranchId).map((b: any) => (
                      <MenuItem key={b.id} value={b.id}>{b.name}</MenuItem>
                    ))}
                  </TextField>
                )} />
            </Grid>

            <Grid item xs={12}>
              <Autocomplete
                disabled={!fromBranchId}
                options={searchOptions.filter((o) => !selectedTags.find((t) => t.id === o.id))}
                getOptionLabel={(o) => `${o.tagNumber} — ${o.name}`}
                filterOptions={(x) => x}
                onInputChange={(_, v) => setTagSearch(v)}
                onChange={(_, val) => { if (val) { setSelectedTags((p) => [...p, val]); setTagSearch(''); } }}
                renderInput={(params) => (
                  <TextField {...params} label={fromBranchId ? 'Search tags at source branch...' : 'Select source branch first'}
                    placeholder="Type tag number or name" />
                )}
                noOptionsText={tagSearch.length < 1 ? 'Type to search' : 'No IN_STOCK tags found'}
              />
            </Grid>

            {selectedTags.length > 0 && (
              <Grid item xs={12}>
                <Typography variant="caption" color="text.secondary" gutterBottom>
                  Selected tags ({selectedTags.length}):
                </Typography>
                <Stack direction="row" flexWrap="wrap" gap={0.75} sx={{ mt: 0.5 }}>
                  {selectedTags.map((tag) => (
                    <Chip key={tag.id} label={`${tag.tagNumber} — ${tag.name}`} size="small"
                      onDelete={() => setSelectedTags((p) => p.filter((t) => t.id !== tag.id))} />
                  ))}
                </Stack>
              </Grid>
            )}

            <Grid item xs={12}>
              <Controller name="notes" control={control}
                render={({ field }) => <TextField {...field} fullWidth label="Notes" />} />
            </Grid>
          </Grid>
        </DialogContent>
        <DialogActions sx={{ p: 2.5 }}>
          <Button onClick={handleClose}>Cancel</Button>
          <Button type="submit" variant="contained" disabled={mutation.isPending || selectedTags.length === 0}>
            Create Transfer
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  );
}

// ─── Transfer Detail Drawer ───────────────────────────────────────────────────

function TransferDrawer({ transferId, onClose }: { transferId: string; onClose: () => void }) {
  const { enqueueSnackbar } = useSnackbar();
  const qc = useQueryClient();
  const hasPermission = useAuthStore((s) => s.hasPermission);

  const { data, isLoading } = useQuery({
    queryKey: ['branch-transfer', transferId],
    queryFn: () => apiGet<any>(`/tagging/transfers/${transferId}`),
    enabled: !!transferId,
  });
  const tr = (data as any)?.data ?? data;

  const act = (url: string) =>
    apiPost(url, {}).then(() => {
      qc.invalidateQueries({ queryKey: ['branch-transfers'] });
      qc.invalidateQueries({ queryKey: ['branch-transfer', transferId] });
    });

  const submitMut = useMutation({
    mutationFn: () => act(`/tagging/transfers/${transferId}/submit`),
    onSuccess: () => enqueueSnackbar('Submitted for approval', { variant: 'success' }),
    onError: (e: any) => enqueueSnackbar(e.response?.data?.error ?? 'Failed', { variant: 'error' }),
  });
  const approveMut = useMutation({
    mutationFn: () => act(`/tagging/transfers/${transferId}/approve`),
    onSuccess: () => enqueueSnackbar('Transfer approved & dispatched', { variant: 'success' }),
    onError: (e: any) => enqueueSnackbar(e.response?.data?.error ?? 'Failed', { variant: 'error' }),
  });
  const receiveMut = useMutation({
    mutationFn: () => act(`/tagging/transfers/${transferId}/receive`),
    onSuccess: () => enqueueSnackbar('Transfer received', { variant: 'success' }),
    onError: (e: any) => enqueueSnackbar(e.response?.data?.error ?? 'Failed', { variant: 'error' }),
  });
  const cancelMut = useMutation({
    mutationFn: () => act(`/tagging/transfers/${transferId}/cancel`),
    onSuccess: () => enqueueSnackbar('Transfer cancelled', { variant: 'success' }),
    onError: (e: any) => enqueueSnackbar(e.response?.data?.error ?? 'Failed', { variant: 'error' }),
  });

  return (
    <Drawer anchor="right" open={!!transferId} onClose={onClose} PaperProps={{ sx: { width: 600 } }}>
      <Box sx={{ p: 3, height: '100%', overflow: 'auto' }}>
        <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 2 }}>
          <Typography variant="h6" fontWeight={700}>Branch Transfer</Typography>
          <IconButton onClick={onClose}><Close /></IconButton>
        </Stack>

        {isLoading && <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}><CircularProgress /></Box>}

        {tr && (
          <>
            <Grid container spacing={1.5} sx={{ mb: 2 }}>
              <Grid item xs={12}>
                <Stack direction="row" justifyContent="space-between" alignItems="center">
                  <Typography fontWeight={900} fontFamily="monospace" color="#44C47A" variant="h6">
                    {tr.transferNumber}
                  </Typography>
                  <StatusChip status={tr.status} />
                </Stack>
              </Grid>
              <Grid item xs={6}>
                <Typography variant="caption" color="text.secondary">From</Typography>
                <Typography fontWeight={700}>{tr.fromBranch?.name}</Typography>
              </Grid>
              <Grid item xs={6}>
                <Typography variant="caption" color="text.secondary">To</Typography>
                <Typography fontWeight={700}>{tr.toBranch?.name}</Typography>
              </Grid>
              <Grid item xs={6}>
                <Typography variant="caption" color="text.secondary">Requested By</Typography>
                <Typography>{tr.requestedBy?.name}</Typography>
              </Grid>
              <Grid item xs={6}>
                <Typography variant="caption" color="text.secondary">Date</Typography>
                <Typography>{new Date(tr.createdAt).toLocaleDateString('en-IN')}</Typography>
              </Grid>
              {tr.approvedBy && (
                <Grid item xs={6}>
                  <Typography variant="caption" color="text.secondary">Approved By</Typography>
                  <Typography>{tr.approvedBy?.name}</Typography>
                </Grid>
              )}
              {tr.receivedAt && (
                <Grid item xs={6}>
                  <Typography variant="caption" color="text.secondary">Received At</Typography>
                  <Typography>{new Date(tr.receivedAt).toLocaleDateString('en-IN')}</Typography>
                </Grid>
              )}
              {tr.notes && (
                <Grid item xs={12}>
                  <Typography variant="caption" color="text.secondary">Notes</Typography>
                  <Typography>{tr.notes}</Typography>
                </Grid>
              )}
            </Grid>

            <Divider sx={{ my: 2 }} />
            <Typography variant="subtitle2" fontWeight={700} gutterBottom>
              Items ({(tr.items ?? []).length})
            </Typography>
            <Box sx={{ overflowX: 'auto' }}>
            <Table size="small" sx={{ mb: 2 }}>
              <TableHead>
                <TableRow>
                  <TableCell>Tag</TableCell>
                  <TableCell>Name</TableCell>
                  <TableCell>Metal</TableCell>
                  <TableCell align="right">Gross Wt</TableCell>
                  <TableCell align="right">Price</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {(tr.items ?? []).map((item: any) => (
                  <TableRow key={item.id}>
                    <TableCell sx={{ fontFamily: 'monospace', fontSize: 11, fontWeight: 700, color: '#44C47A' }}>
                      {item.tag?.tagNumber}
                    </TableCell>
                    <TableCell>{item.tag?.name}</TableCell>
                    <TableCell>{item.tag?.metalKarat}</TableCell>
                    <TableCell align="right" sx={{ fontFamily: 'monospace' }}>
                      {Number(item.tag?.grossWeight ?? 0).toFixed(3)} g
                    </TableCell>
                    <TableCell align="right" sx={{ fontFamily: 'monospace' }}>
                      ₹{Number(item.tag?.sellingPrice ?? 0).toLocaleString('en-IN')}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            </Box>

            <Divider sx={{ my: 2 }} />
            <Stack direction="row" spacing={1} flexWrap="wrap">
              {tr.status === 'DRAFT' && (
                <>
                  <Button variant="contained" startIcon={<Send />}
                    disabled={submitMut.isPending} onClick={() => submitMut.mutate()}>
                    Submit for Approval
                  </Button>
                  <Button variant="outlined" color="error" startIcon={<Cancel />}
                    disabled={cancelMut.isPending} onClick={() => cancelMut.mutate()}>
                    Cancel
                  </Button>
                </>
              )}
              {tr.status === 'PENDING_APPROVAL' && hasPermission('branch:approve') && (
                <>
                  <Button variant="contained" color="success" startIcon={<CheckCircle />}
                    disabled={approveMut.isPending} onClick={() => approveMut.mutate()}>
                    Approve & Dispatch
                  </Button>
                  <Button variant="outlined" color="error" startIcon={<Cancel />}
                    disabled={cancelMut.isPending} onClick={() => cancelMut.mutate()}>
                    Cancel
                  </Button>
                </>
              )}
              {tr.status === 'DISPATCHED' && (
                <Button variant="contained" color="secondary" startIcon={<MoveDown />}
                  disabled={receiveMut.isPending} onClick={() => receiveMut.mutate()}>
                  Mark Received
                </Button>
              )}
            </Stack>
          </>
        )}
      </Box>
    </Drawer>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export function BranchTransfersPage() {
  const [createOpen, setCreateOpen] = useState(false);
  const [statusFilter, setStatusFilter] = useState('');
  const [selectedId, setSelectedId] = useState('');

  const { data: branchData } = useQuery({
    queryKey: ['branches'],
    queryFn: () => apiGet<any>('/tagging/branches'),
  });
  const branches: any[] = (branchData as any)?.data ?? branchData ?? [];

  const { data, isLoading } = useQuery({
    queryKey: ['branch-transfers', statusFilter],
    queryFn: () => apiGet<any>('/tagging/transfers', { status: statusFilter || undefined }),
  });
  const transfers: any[] = (data as any)?.transfers ?? [];

  return (
    <Box>
      <PageHeader title="Branch Transfers" subtitle="Move tagged inventory between branches with approval"
        breadcrumbs={[{ label: 'Jewelry Tagging', path: '/tagging/tags' }, { label: 'Transfers' }]}
        actions={[{ label: 'New Transfer', icon: <Add />, onClick: () => setCreateOpen(true) }]} />

      <Card sx={{ mb: 2, p: 1.5 }}>
        <Grid container spacing={2} alignItems="center">
          <Grid item xs={3}>
            <TextField select fullWidth size="small" label="Status" value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}>
              <MenuItem value="">All</MenuItem>
              {TRANSFER_STATUSES.map((s) => <MenuItem key={s} value={s}>{s}</MenuItem>)}
            </TextField>
          </Grid>
          <Grid item>
            <Typography variant="caption" color="text.secondary">{(data as any)?.total ?? 0} transfers</Typography>
          </Grid>
        </Grid>
      </Card>

      <Card>
        <Box sx={{ overflowX: 'auto' }}>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>Transfer #</TableCell>
              <TableCell>From Branch</TableCell>
              <TableCell>To Branch</TableCell>
              <TableCell align="center">Items</TableCell>
              <TableCell>Requested By</TableCell>
              <TableCell>Status</TableCell>
              <TableCell>Date</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {isLoading ? (
              <TableRow><TableCell colSpan={7} align="center" sx={{ py: 4 }}>Loading...</TableCell></TableRow>
            ) : transfers.map((tr: any) => (
              <TableRow key={tr.id} hover sx={{ cursor: 'pointer' }} onClick={() => setSelectedId(tr.id)}>
                <TableCell sx={{ fontFamily: 'monospace', fontWeight: 700, color: '#44C47A', fontSize: 12 }}>
                  {tr.transferNumber}
                </TableCell>
                <TableCell>{tr.fromBranch?.name}</TableCell>
                <TableCell>{tr.toBranch?.name}</TableCell>
                <TableCell align="center">
                  <Chip label={tr._count?.items ?? 0} size="small" />
                </TableCell>
                <TableCell>{tr.requestedBy?.name}</TableCell>
                <TableCell><StatusChip status={tr.status} /></TableCell>
                <TableCell sx={{ fontSize: 11 }}>{new Date(tr.createdAt).toLocaleDateString('en-IN')}</TableCell>
              </TableRow>
            ))}
            {!isLoading && transfers.length === 0 && (
              <TableRow><TableCell colSpan={7} align="center" sx={{ py: 4 }}>No transfers yet</TableCell></TableRow>
            )}
          </TableBody>
        </Table>
        </Box>
      </Card>

      <CreateTransferDialog open={createOpen} onClose={() => setCreateOpen(false)} branches={branches} />
      {selectedId && <TransferDrawer transferId={selectedId} onClose={() => setSelectedId('')} />}
    </Box>
  );
}
