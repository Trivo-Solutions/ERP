import { useState } from 'react';
import {
  Box, Card, Table, TableHead, TableBody, TableRow, TableCell, Typography, Button, Grid, Chip,
  Dialog, DialogTitle, DialogContent, DialogActions, TextField, MenuItem, Autocomplete, IconButton, Tooltip,
} from '@mui/material';
import { Add, LocalShipping, Receipt } from '@mui/icons-material';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm, Controller } from 'react-hook-form';
import { useSnackbar } from 'notistack';
import { apiGet, apiPost, apiPatch } from '../../api/client';
import { PageHeader } from '../../components/common/PageHeader';
import { StatusChip } from '../../components/common/StatusChip';
import { useAuthStore } from '../../store/auth.store';

export function RepairJobs() {
  const { enqueueSnackbar } = useSnackbar();
  const qc = useQueryClient();
  const hasPermission = useAuthStore((s) => s.hasPermission);
  const canCreate = hasPermission('repair:create');
  const canEditCost = hasPermission('repair:edit');
  const canManage = hasPermission('repair:manage'); // deliver / status transitions
  const canBill = hasPermission('invoice:create');
  const [createOpen, setCreateOpen] = useState(false);
  const [costRepair, setCostRepair] = useState<{ id: string; repairCost: number | null } | null>(null);
  const [tagSearch, setTagSearch] = useState('');

  const { data, isLoading } = useQuery({ queryKey: ['repair-jobs'], queryFn: () => apiGet<any[]>('/quality/repairs') });
  const { data: clients } = useQuery({ queryKey: ['clients'], queryFn: () => apiGet<any[]>('/orders/clients') });

  const { control, handleSubmit, reset } = useForm({
    defaultValues: { repairType: 'CUSTOMER_REPAIR', returnReason: '', clientName: '', clientId: null as any, tagQuery: null as any, estimatedDays: 3, notes: '' },
  });
  const costForm = useForm({ defaultValues: { repairCost: 0 } });

  const { data: tagResults } = useQuery({
    queryKey: ['tag-search-repair', tagSearch],
    queryFn: () => apiGet<any[]>('/tagging/tags/search', { q: tagSearch, status: 'ALL' }),
    enabled: createOpen,
  });

  const mutation = useMutation({
    mutationFn: (d: any) => apiPost('/quality/repairs', { ...d, clientId: d.clientId?.id, tagId: d.tagQuery?.id }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['repair-jobs'] }); setCreateOpen(false); reset(); enqueueSnackbar('Repair job created', { variant: 'success' }); },
  });

  const costMutation = useMutation({
    mutationFn: (d: any) => apiPatch(`/quality/repairs/${costRepair!.id}`, { repairCost: Number(d.repairCost) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['repair-jobs'] }); setCostRepair(null); enqueueSnackbar('Repair cost updated', { variant: 'success' }); },
  });

  const deliverMutation = useMutation({
    mutationFn: (id: string) => apiPatch(`/quality/repairs/${id}/status`, { status: 'DELIVERED' }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['repair-jobs'] }); enqueueSnackbar('Marked delivered', { variant: 'success' }); },
  });

  const billMutation = useMutation({
    mutationFn: (id: string) => apiPost(`/quality/repairs/${id}/bill`, {}),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['repair-jobs'] }); enqueueSnackbar('Repair billed', { variant: 'success' }); },
    onError: (e: any) => enqueueSnackbar(e?.response?.data?.message ?? 'Could not bill repair', { variant: 'error' }),
  });

  return (
    <Box>
      <PageHeader title="Repair Jobs"
        actions={canCreate ? [{ label: 'New Repair', icon: <Add />, onClick: () => setCreateOpen(true) }] : []} />
      <Card>
        <Box sx={{ overflowX: 'auto' }}>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>Repair #</TableCell><TableCell>Type</TableCell>
              <TableCell>Reason</TableCell><TableCell>Client</TableCell><TableCell>Tag</TableCell>
              <TableCell align="right">Cost</TableCell><TableCell>Status</TableCell>
              <TableCell align="right">Actions</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {isLoading ? <TableRow><TableCell colSpan={8} align="center" sx={{ py: 4 }}>Loading...</TableCell></TableRow>
              : (data ?? []).map((r: any) => (
                <TableRow key={r.id} hover>
                  <TableCell sx={{ fontFamily: 'monospace', fontWeight: 700, color: '#44C47A', fontSize: 12 }}>{r.repairNumber}</TableCell>
                  <TableCell><Chip label={r.repairType} size="small" color={r.repairType === 'QC_FAILURE' ? 'error' : 'warning'} /></TableCell>
                  <TableCell sx={{ fontSize: 12, maxWidth: 200 }}>{r.returnReason}</TableCell>
                  <TableCell>{r.client ? `${r.client.clientCode} — ${r.client.name}` : (r.clientName ?? '—')}</TableCell>
                  <TableCell sx={{ fontFamily: 'monospace', fontSize: 11 }}>{r.tag?.tagNumber ?? '—'}</TableCell>
                  <TableCell align="right" sx={{ fontFamily: 'monospace' }}>
                    {canEditCost ? (
                      <Tooltip title="Set / edit repair cost">
                        <span style={{ cursor: 'pointer' }} onClick={() => { setCostRepair({ id: r.id, repairCost: r.repairCost }); costForm.reset({ repairCost: Number(r.repairCost ?? 0) }); }}>
                          {r.repairCost != null ? `₹${Number(r.repairCost).toLocaleString('en-IN')}` : 'Set cost'}
                        </span>
                      </Tooltip>
                    ) : (
                      r.repairCost != null ? `₹${Number(r.repairCost).toLocaleString('en-IN')}` : '—'
                    )}
                  </TableCell>
                  <TableCell><StatusChip status={r.status} /></TableCell>
                  <TableCell align="right">
                    {r.status !== 'DELIVERED' && canManage && (
                      <Tooltip title="Mark delivered">
                        <IconButton size="small" onClick={() => deliverMutation.mutate(r.id)}>
                          <LocalShipping fontSize="small" />
                        </IconButton>
                      </Tooltip>
                    )}
                    {r.invoice && r.invoice.status !== 'VOID' ? (
                      <Chip label={r.invoice.invoiceNumber} size="small" color="success" variant="outlined" />
                    ) : canBill ? (
                      <Tooltip title={
                        r.invoice ? `Previous invoice ${r.invoice.invoiceNumber} was voided — bill again`
                          : (r.clientId ? 'Bill customer' : 'Needs a client to bill')
                      }>
                        <span>
                          {r.invoice && (
                            <Chip label={`${r.invoice.invoiceNumber} (voided)`} size="small" color="default" variant="outlined" sx={{ mr: 0.5 }} />
                          )}
                          <IconButton size="small" disabled={!r.clientId || !r.repairCost} onClick={() => billMutation.mutate(r.id)}>
                            <Receipt fontSize="small" />
                          </IconButton>
                        </span>
                      </Tooltip>
                    ) : null}
                  </TableCell>
                </TableRow>
              ))}
          </TableBody>
        </Table>
        </Box>
      </Card>

      <Dialog open={createOpen} onClose={() => setCreateOpen(false)} maxWidth="sm" fullWidth>
        <form onSubmit={handleSubmit((d) => mutation.mutate(d))}>
          <DialogTitle fontWeight={700}>Create Repair Job</DialogTitle>
          <DialogContent sx={{ pt: 2 }}>
            <Grid container spacing={2}>
              <Grid item xs={6}>
                <Controller name="repairType" control={control} render={({ field }) => (
                  <TextField {...field} select fullWidth label="Repair Type">
                    <MenuItem value="CUSTOMER_REPAIR">Customer Repair</MenuItem>
                    <MenuItem value="QC_FAILURE">QC Failure</MenuItem>
                    <MenuItem value="CLIENT_RETURN">Client Return</MenuItem>
                    <MenuItem value="WARRANTY">Warranty</MenuItem>
                  </TextField>
                )} />
              </Grid>
              <Grid item xs={6}>
                <Controller name="estimatedDays" control={control} render={({ field }) => <TextField {...field} fullWidth label="Est. Repair Days" type="number" />} />
              </Grid>
              <Grid item xs={12}>
                <Controller name="clientId" control={control} render={({ field }) => (
                  <Autocomplete
                    options={clients ?? []}
                    getOptionLabel={(c: any) => `${c.clientCode} — ${c.name}`}
                    isOptionEqualToValue={(a: any, b: any) => a.id === b.id}
                    value={field.value}
                    onChange={(_, v) => field.onChange(v)}
                    renderInput={(params) => <TextField {...params} label="Client (optional — for billing)" />}
                  />
                )} />
              </Grid>
              <Grid item xs={12}>
                <Controller name="clientName" control={control} render={({ field }) => <TextField {...field} fullWidth label="Client Name (if no client account / QC rework)" />} />
              </Grid>
              <Grid item xs={12}>
                <Controller name="tagQuery" control={control} render={({ field }) => (
                  <Autocomplete
                    options={tagResults ?? []}
                    getOptionLabel={(t: any) => `${t.tagNumber} — ${t.name}`}
                    isOptionEqualToValue={(a: any, b: any) => a.id === b.id}
                    value={field.value}
                    onChange={(_, v) => field.onChange(v)}
                    onInputChange={(_, v) => setTagSearch(v)}
                    renderInput={(params) => <TextField {...params} label="Piece / Tag (optional) — search by tag #, name, or HUID" />}
                  />
                )} />
              </Grid>
              <Grid item xs={12}><Controller name="returnReason" control={control} rules={{ required: true }} render={({ field }) => <TextField {...field} fullWidth label="Return / Failure Reason" multiline rows={2} />} /></Grid>
              <Grid item xs={12}><Controller name="notes" control={control} render={({ field }) => <TextField {...field} fullWidth label="Notes" multiline rows={2} />} /></Grid>
            </Grid>
          </DialogContent>
          <DialogActions sx={{ p: 2.5 }}><Button onClick={() => setCreateOpen(false)}>Cancel</Button><Button type="submit" variant="contained" disabled={mutation.isPending}>Create</Button></DialogActions>
        </form>
      </Dialog>

      <Dialog open={!!costRepair} onClose={() => setCostRepair(null)} maxWidth="xs" fullWidth>
        <form onSubmit={costForm.handleSubmit((d) => costMutation.mutate(d))}>
          <DialogTitle fontWeight={700}>Repair Cost</DialogTitle>
          <DialogContent sx={{ pt: 2 }}>
            <Controller name="repairCost" control={costForm.control} rules={{ required: true, min: 0 }}
              render={({ field }) => <TextField {...field} fullWidth label="Repair Cost (₹)" type="number" autoFocus />} />
          </DialogContent>
          <DialogActions sx={{ p: 2.5 }}>
            <Button onClick={() => setCostRepair(null)}>Cancel</Button>
            <Button type="submit" variant="contained" disabled={costMutation.isPending}>Save</Button>
          </DialogActions>
        </form>
      </Dialog>
    </Box>
  );
}
