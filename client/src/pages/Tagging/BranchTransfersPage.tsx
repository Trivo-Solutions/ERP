import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Box, Card, Table, TableHead, TableBody, TableRow, TableCell, Typography, Button,
  Grid, MenuItem, TextField, Drawer, Stack, Divider, IconButton, Chip, CircularProgress,
} from '@mui/material';
import { Add, Close, Send, CheckCircle, Cancel, MoveDown } from '@mui/icons-material';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useSnackbar } from 'notistack';
import { apiGet, apiPost } from '../../api/client';
import { PageHeader, PageActions } from '../../components/common/PageHeader';
import { StatusChip } from '../../components/common/StatusChip';
import { useAuthStore } from '../../store/auth.store';

const TRANSFER_STATUSES = ['DRAFT', 'PENDING_APPROVAL', 'DISPATCHED', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CANCELLED'];

// ─── Transfer Detail Drawer ───────────────────────────────────────────────────

function TransferDrawer({ transferId, onClose }: { transferId: string; onClose: () => void }) {
  const { enqueueSnackbar } = useSnackbar();
  const qc = useQueryClient();
  const navigate = useNavigate();
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
              {(tr.status === 'DISPATCHED' || tr.status === 'PARTIALLY_RECEIVED') && (
                <Button variant="contained" color="secondary" startIcon={<MoveDown />}
                  onClick={() => navigate(`/tagging/receives/${transferId}`)}>
                  Verify & Receive
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
  const navigate = useNavigate();
  const [statusFilter, setStatusFilter] = useState('');
  const [selectedId, setSelectedId] = useState('');

  const { data, isLoading } = useQuery({
    queryKey: ['branch-transfers', statusFilter],
    queryFn: () => apiGet<any>('/tagging/transfers', { status: statusFilter || undefined }),
  });
  const transfers: any[] = (data as any)?.transfers ?? [];

  return (
    <Box>
      <PageHeader title="Branch Transfers" />

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
          <Grid item sx={{ ml: 'auto', alignSelf: 'center' }}>
            <PageActions actions={[{ label: 'New Transfer', icon: <Add />, onClick: () => navigate('/tagging/transfers/new') }]} />
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

      {selectedId && <TransferDrawer transferId={selectedId} onClose={() => setSelectedId('')} />}
    </Box>
  );
}
