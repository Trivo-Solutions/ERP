import { useState } from 'react';
import {
  Box, Card, Table, TableHead, TableBody, TableRow, TableCell, Typography, Button,
  Grid, MenuItem, TextField, Chip, Dialog, DialogTitle, DialogContent, DialogActions,
  Drawer, Stack, Divider, Alert, CircularProgress, IconButton,
} from '@mui/material';
import { Add, Close, CheckCircle, Cancel, SwapHoriz } from '@mui/icons-material';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm, Controller, useFieldArray, useWatch } from 'react-hook-form';
import { useSnackbar } from 'notistack';
import { apiGet, apiPost } from '../../api/client';
import { PageHeader, PageActions } from '../../components/common/PageHeader';
import { StatusChip } from '../../components/common/StatusChip';
import { useAuthStore } from '../../store/auth.store';

const MATERIAL_TYPES = ['METAL', 'DIAMOND', 'STONE', 'FINDING', 'CONSUMABLE'];
const PR_STATUSES = ['DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED', 'CONVERTED'];

function fmt(n: number) {
  return '₹' + n.toLocaleString('en-IN', { maximumFractionDigits: 2 });
}

// ─── Create PR Dialog ─────────────────────────────────────────────────────────

function CreatePRDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { enqueueSnackbar } = useSnackbar();
  const qc = useQueryClient();

  const { control, handleSubmit, reset, watch } = useForm({
    defaultValues: {
      department: '',
      notes: '',
      items: [{ materialCode: '', materialName: '', materialType: 'METAL', karat: '', quantity: 1, weight: 0, unit: 'GM', estimatedRate: 0 }],
    },
  });
  const { fields, append, remove } = useFieldArray({ control, name: 'items' });
  const watchedItems = watch('items');

  const total = watchedItems.reduce((sum, i) => sum + (Number(i.weight) * Number(i.estimatedRate)), 0);

  const mutation = useMutation({
    mutationFn: (data: any) => apiPost('/procurement/requisitions', data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['prs'] });
      onClose();
      reset();
      enqueueSnackbar('Purchase Requisition created', { variant: 'success' });
    },
    onError: (err: any) => enqueueSnackbar(err.response?.data?.error ?? 'Failed to create PR', { variant: 'error' }),
  });

  const handleClose = () => { onClose(); reset(); };

  return (
    <Dialog open={open} onClose={handleClose} maxWidth="lg" fullWidth>
      <form onSubmit={handleSubmit((d) => mutation.mutate(d))}>
        <DialogTitle fontWeight={700}>New Purchase Requisition</DialogTitle>
        <DialogContent sx={{ pt: 2 }}>
          <Grid container spacing={2} sx={{ mb: 2 }}>
            <Grid item xs={6}>
              <Controller name="department" control={control} rules={{ required: true }}
                render={({ field, fieldState }) => (
                  <TextField {...field} fullWidth label="Department" error={!!fieldState.error}
                    helperText={fieldState.error && 'Required'} />
                )} />
            </Grid>
            <Grid item xs={6}>
              <Controller name="notes" control={control}
                render={({ field }) => <TextField {...field} fullWidth label="Notes (optional)" />} />
            </Grid>
          </Grid>

          <Typography variant="subtitle2" fontWeight={700} gutterBottom>Line Items</Typography>
          {fields.map((field, idx) => (
            <Grid container spacing={1} key={field.id} sx={{ mb: 1 }} alignItems="center">
              <Grid item xs={1.5}>
                <Controller name={`items.${idx}.materialCode`} control={control}
                  render={({ field }) => <TextField {...field} fullWidth size="small" label="Code" />} />
              </Grid>
              <Grid item xs={2.5}>
                <Controller name={`items.${idx}.materialName`} control={control}
                  render={({ field }) => <TextField {...field} fullWidth size="small" label="Material Name" />} />
              </Grid>
              <Grid item xs={1.5}>
                <Controller name={`items.${idx}.materialType`} control={control}
                  render={({ field }) => (
                    <TextField {...field} select fullWidth size="small" label="Type">
                      {MATERIAL_TYPES.map((t) => <MenuItem key={t} value={t}>{t}</MenuItem>)}
                    </TextField>
                  )} />
              </Grid>
              <Grid item xs={1}>
                <Controller name={`items.${idx}.karat`} control={control}
                  render={({ field }) => <TextField {...field} fullWidth size="small" label="Karat" />} />
              </Grid>
              <Grid item xs={1}>
                <Controller name={`items.${idx}.weight`} control={control}
                  render={({ field }) => <TextField {...field} fullWidth size="small" label="Weight (g)" type="number" inputProps={{ step: 0.001 }} />} />
              </Grid>
              <Grid item xs={1}>
                <Controller name={`items.${idx}.unit`} control={control}
                  render={({ field }) => (
                    <TextField {...field} select fullWidth size="small" label="Unit">
                      {['GM', 'KG', 'CT', 'PC'].map((u) => <MenuItem key={u} value={u}>{u}</MenuItem>)}
                    </TextField>
                  )} />
              </Grid>
              <Grid item xs={1.5}>
                <Controller name={`items.${idx}.estimatedRate`} control={control}
                  render={({ field }) => <TextField {...field} fullWidth size="small" label="Est. Rate (₹)" type="number" />} />
              </Grid>
              <Grid item xs={1.5}>
                <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1, fontFamily: 'monospace' }}>
                  {fmt(Number(watchedItems[idx]?.weight ?? 0) * Number(watchedItems[idx]?.estimatedRate ?? 0))}
                </Typography>
              </Grid>
              <Grid item xs={0.5}>
                <IconButton size="small" color="error" onClick={() => remove(idx)}><Close fontSize="small" /></IconButton>
              </Grid>
            </Grid>
          ))}
          <Button size="small" startIcon={<Add />} onClick={() =>
            append({ materialCode: '', materialName: '', materialType: 'METAL', karat: '', quantity: 1, weight: 0, unit: 'GM', estimatedRate: 0 })
          }>Add Line Item</Button>

          <Box sx={{ mt: 2, p: 1.5, bgcolor: 'action.hover', borderRadius: 1 }}>
            <Typography variant="subtitle2">Total Estimated Amount: <strong>{fmt(total)}</strong></Typography>
          </Box>
        </DialogContent>
        <DialogActions sx={{ p: 2.5 }}>
          <Button onClick={handleClose}>Cancel</Button>
          <Button type="submit" variant="contained" disabled={mutation.isPending}>Create Requisition</Button>
        </DialogActions>
      </form>
    </Dialog>
  );
}

// ─── Comment Dialog ───────────────────────────────────────────────────────────

function CommentDialog({ open, title, onConfirm, onClose, required = false }: {
  open: boolean; title: string; onConfirm: (comment: string) => void; onClose: () => void; required?: boolean;
}) {
  const [comment, setComment] = useState('');
  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle fontWeight={700}>{title}</DialogTitle>
      <DialogContent>
        <TextField fullWidth multiline rows={3} label={required ? 'Comments (required)' : 'Comments (optional)'}
          value={comment} onChange={(e) => setComment(e.target.value)} sx={{ mt: 1 }} />
      </DialogContent>
      <DialogActions sx={{ p: 2 }}>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="contained" disabled={required && !comment.trim()} onClick={() => { onConfirm(comment); setComment(''); }}>
          Confirm
        </Button>
      </DialogActions>
    </Dialog>
  );
}

// ─── PR Detail Drawer ─────────────────────────────────────────────────────────

function PRDrawer({ prId, onClose }: { prId: string; onClose: () => void }) {
  const { enqueueSnackbar } = useSnackbar();
  const qc = useQueryClient();
  const user = useAuthStore((s) => s.user);
  const hasPermission = useAuthStore((s) => s.hasPermission);
  const [commentDialog, setCommentDialog] = useState<null | 'approve' | 'reject'>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['pr', prId],
    queryFn: () => apiGet<any>(`/procurement/requisitions/${prId}`),
    enabled: !!prId,
  });
  const pr = (data as any)?.data ?? (data as any);

  const mutate = (url: string, body: object = {}) =>
    apiPost(url, body).then(() => {
      qc.invalidateQueries({ queryKey: ['prs'] });
      qc.invalidateQueries({ queryKey: ['pr', prId] });
    });

  const submitMutation = useMutation({
    mutationFn: () => mutate(`/procurement/requisitions/${prId}/submit`),
    onSuccess: () => enqueueSnackbar('Submitted for approval', { variant: 'success' }),
    onError: (e: any) => enqueueSnackbar(e.response?.data?.error ?? 'Failed', { variant: 'error' }),
  });

  const approveMutation = useMutation({
    mutationFn: (comments: string) => mutate(`/procurement/requisitions/${prId}/approve`, { comments }),
    onSuccess: () => { setCommentDialog(null); enqueueSnackbar('Requisition approved', { variant: 'success' }); },
    onError: (e: any) => enqueueSnackbar(e.response?.data?.error ?? 'Failed', { variant: 'error' }),
  });

  const rejectMutation = useMutation({
    mutationFn: (comments: string) => mutate(`/procurement/requisitions/${prId}/reject`, { comments }),
    onSuccess: () => { setCommentDialog(null); enqueueSnackbar('Requisition rejected', { variant: 'success' }); },
    onError: (e: any) => enqueueSnackbar(e.response?.data?.error ?? 'Failed', { variant: 'error' }),
  });

  const convertMutation = useMutation({
    mutationFn: () => mutate(`/procurement/requisitions/${prId}/convert`),
    onSuccess: () => enqueueSnackbar('Converted to Purchase Order', { variant: 'success' }),
    onError: (e: any) => enqueueSnackbar(e.response?.data?.error ?? 'Failed', { variant: 'error' }),
  });

  const canApprove = hasPermission('po:approve');
  const canCreate = hasPermission('po:create');

  return (
    <Drawer anchor="right" open={!!prId} onClose={onClose} PaperProps={{ sx: { width: 640 } }}>
      <Box sx={{ p: 3, height: '100%', overflow: 'auto' }}>
        <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 2 }}>
          <Typography variant="h6" fontWeight={700}>Requisition Detail</Typography>
          <IconButton onClick={onClose}><Close /></IconButton>
        </Stack>

        {isLoading && <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}><CircularProgress /></Box>}

        {pr && (
          <>
            <Grid container spacing={1.5} sx={{ mb: 2 }}>
              <Grid item xs={6}><Typography variant="caption" color="text.secondary">PR Number</Typography>
                <Typography fontWeight={700} sx={{ fontFamily: 'monospace', color: '#44C47A' }}>{pr.prNumber}</Typography></Grid>
              <Grid item xs={6}><Typography variant="caption" color="text.secondary">Status</Typography>
                <Box><StatusChip status={pr.status} /></Box></Grid>
              <Grid item xs={6}><Typography variant="caption" color="text.secondary">Department</Typography>
                <Typography>{pr.department}</Typography></Grid>
              <Grid item xs={6}><Typography variant="caption" color="text.secondary">Requested By</Typography>
                <Typography>{pr.requestedBy?.name}</Typography></Grid>
              <Grid item xs={6}><Typography variant="caption" color="text.secondary">Total Estimated</Typography>
                <Typography fontWeight={700}>{fmt(Number(pr.totalEstimatedAmount))}</Typography></Grid>
              <Grid item xs={6}><Typography variant="caption" color="text.secondary">Date</Typography>
                <Typography>{new Date(pr.createdAt).toLocaleDateString('en-IN')}</Typography></Grid>
              {pr.notes && <Grid item xs={12}><Typography variant="caption" color="text.secondary">Notes</Typography>
                <Typography>{pr.notes}</Typography></Grid>}
            </Grid>

            <Divider sx={{ my: 2 }} />
            <Typography variant="subtitle2" fontWeight={700} gutterBottom>Line Items</Typography>
            <Box sx={{ overflowX: 'auto' }}>
            <Table size="small" sx={{ mb: 2 }}>
              <TableHead>
                <TableRow>
                  <TableCell>Material</TableCell>
                  <TableCell>Type</TableCell>
                  <TableCell align="right">Weight</TableCell>
                  <TableCell align="right">Est. Rate</TableCell>
                  <TableCell align="right">Total</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {(pr.items ?? []).map((item: any) => (
                  <TableRow key={item.id}>
                    <TableCell>
                      <Typography variant="body2" fontWeight={600}>{item.materialName}</Typography>
                      <Typography variant="caption" color="text.secondary">{item.materialCode} {item.karat && `· ${item.karat}`}</Typography>
                    </TableCell>
                    <TableCell><Chip label={item.materialType} size="small" /></TableCell>
                    <TableCell align="right" sx={{ fontFamily: 'monospace' }}>{Number(item.weight).toFixed(3)} {item.unit}</TableCell>
                    <TableCell align="right" sx={{ fontFamily: 'monospace' }}>₹{Number(item.estimatedRate).toLocaleString('en-IN')}</TableCell>
                    <TableCell align="right" sx={{ fontFamily: 'monospace', fontWeight: 700 }}>{fmt(Number(item.totalEstimatedAmount))}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            </Box>

            {(pr.approvalHistory ?? []).length > 0 && (
              <>
                <Divider sx={{ my: 2 }} />
                <Typography variant="subtitle2" fontWeight={700} gutterBottom>Approval History</Typography>
                <Stack spacing={1}>
                  {pr.approvalHistory.map((h: any) => (
                    <Box key={h.id} sx={{ p: 1.5, bgcolor: 'action.hover', borderRadius: 1 }}>
                      <Stack direction="row" justifyContent="space-between">
                        <Typography variant="body2" fontWeight={600}>{h.action}</Typography>
                        <Typography variant="caption" color="text.secondary">{new Date(h.createdAt).toLocaleString('en-IN')}</Typography>
                      </Stack>
                      <Typography variant="caption" color="text.secondary">by {h.performedBy?.name}</Typography>
                      {h.comments && <Typography variant="body2" sx={{ mt: 0.5, fontStyle: 'italic' }}>"{h.comments}"</Typography>}
                    </Box>
                  ))}
                </Stack>
              </>
            )}

            <Divider sx={{ my: 2 }} />
            <Stack direction="row" spacing={1} flexWrap="wrap">
              {pr.status === 'DRAFT' && canCreate && (
                <Button variant="contained" startIcon={<CheckCircle />}
                  disabled={submitMutation.isPending}
                  onClick={() => submitMutation.mutate()}>Submit for Approval</Button>
              )}
              {pr.status === 'SUBMITTED' && canApprove && (
                <>
                  <Button variant="contained" color="success" startIcon={<CheckCircle />}
                    onClick={() => setCommentDialog('approve')}>Approve</Button>
                  <Button variant="outlined" color="error" startIcon={<Cancel />}
                    onClick={() => setCommentDialog('reject')}>Reject</Button>
                </>
              )}
              {pr.status === 'APPROVED' && canCreate && (
                <Button variant="contained" color="secondary" startIcon={<SwapHoriz />}
                  disabled={convertMutation.isPending}
                  onClick={() => convertMutation.mutate()}>Convert to PO</Button>
              )}
            </Stack>
          </>
        )}
      </Box>

      <CommentDialog open={commentDialog === 'approve'} title="Approve Requisition"
        onClose={() => setCommentDialog(null)} onConfirm={(c) => approveMutation.mutate(c)} />
      <CommentDialog open={commentDialog === 'reject'} title="Reject Requisition" required
        onClose={() => setCommentDialog(null)} onConfirm={(c) => rejectMutation.mutate(c)} />
    </Drawer>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export function PurchaseRequisitions() {
  const hasPermission = useAuthStore((s) => s.hasPermission);
  const [createOpen, setCreateOpen] = useState(false);
  const [statusFilter, setStatusFilter] = useState('');
  const [selectedPRId, setSelectedPRId] = useState('');

  const { data, isLoading } = useQuery({
    queryKey: ['prs', statusFilter],
    queryFn: () => apiGet<any>('/procurement/requisitions', { status: statusFilter || undefined }),
  });

  const prs: any[] = (data as any)?.prs ?? [];

  return (
    <Box>
      <PageHeader
        title="Purchase Requisitions" />

      <Card sx={{ mb: 2, p: 1.5 }}>
        <Grid container spacing={2} alignItems="center">
          <Grid item xs={4}>
            <TextField select fullWidth size="small" label="Status" value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}>
              <MenuItem value="">All</MenuItem>
              {PR_STATUSES.map((s) => <MenuItem key={s} value={s}>{s}</MenuItem>)}
            </TextField>
          </Grid>
          <Grid item>
            <Typography variant="caption" color="text.secondary">{(data as any)?.total ?? 0} requisitions</Typography>
          </Grid>
          <Grid item sx={{ ml: 'auto', alignSelf: 'center' }}>
            <PageActions actions={hasPermission('po:create') ? [{ label: 'New Requisition', icon: <Add />, onClick: () => setCreateOpen(true) }] : []} />
          </Grid>
        </Grid>
      </Card>

      <Card>
        <Box sx={{ overflowX: 'auto' }}>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>PR Number</TableCell>
              <TableCell>Department</TableCell>
              <TableCell>Requested By</TableCell>
              <TableCell align="right">Total Est. Amount</TableCell>
              <TableCell>Status</TableCell>
              <TableCell>Date</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {isLoading ? (
              <TableRow><TableCell colSpan={6} align="center" sx={{ py: 4 }}>Loading...</TableCell></TableRow>
            ) : prs.map((pr: any) => (
              <TableRow key={pr.id} hover sx={{ cursor: 'pointer' }} onClick={() => setSelectedPRId(pr.id)}>
                <TableCell sx={{ fontFamily: 'monospace', fontSize: 12, fontWeight: 700, color: '#44C47A' }}>{pr.prNumber}</TableCell>
                <TableCell>{pr.department}</TableCell>
                <TableCell>{pr.requestedBy?.name}</TableCell>
                <TableCell align="right" sx={{ fontFamily: 'monospace' }}>{fmt(Number(pr.totalEstimatedAmount))}</TableCell>
                <TableCell><StatusChip status={pr.status} /></TableCell>
                <TableCell sx={{ fontSize: 12 }}>{new Date(pr.createdAt).toLocaleDateString('en-IN')}</TableCell>
              </TableRow>
            ))}
            {!isLoading && prs.length === 0 && (
              <TableRow><TableCell colSpan={6} align="center" sx={{ py: 4 }}>No purchase requisitions</TableCell></TableRow>
            )}
          </TableBody>
        </Table>
        </Box>
      </Card>

      <CreatePRDialog open={createOpen} onClose={() => setCreateOpen(false)} />
      {selectedPRId && <PRDrawer prId={selectedPRId} onClose={() => setSelectedPRId('')} />}
    </Box>
  );
}
