import { useState } from 'react';
import { Box, Card, Grid, TextField, MenuItem, Table, TableHead, TableBody, TableRow, TableCell, Typography, Chip, Button, Dialog, DialogTitle, DialogContent, DialogActions, IconButton } from '@mui/material';
import { Add, Visibility, QrCode } from '@mui/icons-material';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm, Controller } from 'react-hook-form';
import { useNavigate } from 'react-router-dom';
import { useSnackbar } from 'notistack';
import { apiGet, apiPost } from '../../api/client';
import { PageHeader } from '../../components/common/PageHeader';
import { StatusChip } from '../../components/common/StatusChip';
import { WeightDisplay } from '../../components/common/WeightDisplay';

export function JobCards() {
  const navigate = useNavigate();
  const { enqueueSnackbar } = useSnackbar();
  const qc = useQueryClient();
  const [statusFilter, setStatusFilter] = useState('');
  const [createOpen, setCreateOpen] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ['job-cards', statusFilter],
    queryFn: () => apiGet<any>('/manufacturing/jobs', { status: statusFilter || undefined }),
    refetchInterval: 15_000,
  });

  const { data: designs } = useQuery({
    queryKey: ['designs-list'],
    queryFn: () => apiGet<any>('/designs', { status: 'APPROVED' }),
  });

  const { control, handleSubmit, reset } = useForm({
    defaultValues: { designId: '', batchSize: 1, issuedWeight: 0, priority: 'NORMAL', jobType: 'PRODUCTION', notes: '' },
  });

  const createMutation = useMutation({
    mutationFn: (data: any) => apiPost('/manufacturing/jobs', data),
    onSuccess: (jc: any) => {
      qc.invalidateQueries({ queryKey: ['job-cards'] });
      setCreateOpen(false);
      reset();
      enqueueSnackbar(`Job Card ${jc.jobNumber} created`, { variant: 'success' });
      navigate(`/manufacturing/jobs/${jc.id}`);
    },
    onError: (err: any) => enqueueSnackbar(err.response?.data?.error ?? 'Failed', { variant: 'error' }),
  });

  const jobs = (data as any)?.jobCards ?? [];

  return (
    <Box>
      <PageHeader
        title="Job Cards"
        subtitle="Serialized digital job cards for every production unit"
        breadcrumbs={[{ label: 'Manufacturing', path: '/manufacturing' }, { label: 'Job Cards' }]}
        actions={[{ label: 'Create Job Card', icon: <Add />, onClick: () => setCreateOpen(true) }]}
      />

      <Card sx={{ mb: 2, p: 1.5 }}>
        <Grid container spacing={2} alignItems="center">
          <Grid item xs={6} sm={3}>
            <TextField select fullWidth size="small" label="Status" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
              <MenuItem value="">All</MenuItem>
              {['CREATED', 'IN_PROGRESS', 'QC_PENDING', 'QC_PASSED', 'COMPLETED', 'REJECTED'].map((s) => (
                <MenuItem key={s} value={s}>{s}</MenuItem>
              ))}
            </TextField>
          </Grid>
          <Grid item>
            <Typography variant="caption" color="text.secondary">{(data as any)?.total ?? 0} job cards</Typography>
          </Grid>
        </Grid>
      </Card>

      <Card>
        <Box sx={{ overflowX: 'auto' }}>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>Job #</TableCell>
              <TableCell>Design</TableCell>
              <TableCell>Batch</TableCell>
              <TableCell>Type</TableCell>
              <TableCell>Current Process</TableCell>
              <TableCell>Issued Wt</TableCell>
              <TableCell>Loss</TableCell>
              <TableCell>Priority</TableCell>
              <TableCell>Status</TableCell>
              <TableCell>Created</TableCell>
              <TableCell></TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {isLoading ? (
              <TableRow><TableCell colSpan={11} align="center" sx={{ py: 4 }}>Loading...</TableCell></TableRow>
            ) : jobs.map((jc: any) => {
              const loss = Number(jc.issuedWeight) > 0
                ? ((Number(jc.issuedWeight) - Number(jc.returnedWeight) - Number(jc.scrapWeight)) / Number(jc.issuedWeight)) * 100
                : 0;
              return (
                <TableRow key={jc.id} hover>
                  <TableCell>
                    <Typography sx={{ fontFamily: 'monospace', fontSize: 12, fontWeight: 700, color: '#44C47A' }}>{jc.jobNumber}</Typography>
                  </TableCell>
                  <TableCell>
                    <Typography sx={{ fontSize: 13, fontWeight: 600 }}>{jc.design?.name}</Typography>
                    <Typography variant="caption" color="text.secondary">{jc.design?.metalKarat}</Typography>
                  </TableCell>
                  <TableCell align="center">{jc.batchSize}</TableCell>
                  <TableCell><Chip label={jc.jobType} size="small" /></TableCell>
                  <TableCell>
                    <Chip label={jc.currentProcess ?? '—'} size="small" color="primary" variant="outlined" />
                  </TableCell>
                  <TableCell sx={{ fontFamily: 'monospace' }}>{Number(jc.issuedWeight).toFixed(3)}g</TableCell>
                  <TableCell sx={{ fontFamily: 'monospace', color: loss > 3 ? 'error.main' : 'inherit' }}>
                    {loss.toFixed(2)}%
                  </TableCell>
                  <TableCell>
                    <Chip label={jc.priority} size="small"
                      color={jc.priority === 'URGENT' ? 'error' : jc.priority === 'HIGH' ? 'warning' : 'default'} />
                  </TableCell>
                  <TableCell><StatusChip status={jc.status} /></TableCell>
                  <TableCell sx={{ fontSize: 11 }}>{new Date(jc.createdAt).toLocaleDateString('en-IN')}</TableCell>
                  <TableCell>
                    <IconButton size="small" onClick={() => navigate(`/manufacturing/jobs/${jc.id}`)}>
                      <Visibility fontSize="small" />
                    </IconButton>
                  </TableCell>
                </TableRow>
              );
            })}
            {!isLoading && jobs.length === 0 && (
              <TableRow><TableCell colSpan={11} align="center" sx={{ py: 4 }}>No job cards found</TableCell></TableRow>
            )}
          </TableBody>
        </Table>
        </Box>
      </Card>

      {/* Create Dialog */}
      <Dialog open={createOpen} onClose={() => setCreateOpen(false)} maxWidth="sm" fullWidth>
        <form onSubmit={handleSubmit((d) => createMutation.mutate(d))}>
          <DialogTitle fontWeight={700}>Create Job Card</DialogTitle>
          <DialogContent sx={{ pt: 2 }}>
            <Grid container spacing={2}>
              <Grid item xs={12}>
                <Controller name="designId" control={control} rules={{ required: true }}
                  render={({ field }) => (
                    <TextField {...field} select fullWidth label="Design (Approved Only)">
                      {((designs as any)?.designs ?? []).map((d: any) => (
                        <MenuItem key={d.id} value={d.id}>{d.designCode} — {d.name} ({d.metalKarat})</MenuItem>
                      ))}
                    </TextField>
                  )} />
              </Grid>
              <Grid item xs={6}>
                <Controller name="batchSize" control={control}
                  render={({ field }) => <TextField {...field} fullWidth label="Batch Size (pcs)" type="number" inputProps={{ min: 1 }} />} />
              </Grid>
              <Grid item xs={6}>
                <Controller name="issuedWeight" control={control} rules={{ required: true }}
                  render={({ field }) => <TextField {...field} fullWidth label="Issued Metal Weight (g)" type="number" inputProps={{ step: 0.001 }} />} />
              </Grid>
              <Grid item xs={6}>
                <Controller name="jobType" control={control}
                  render={({ field }) => (
                    <TextField {...field} select fullWidth label="Job Type">
                      <MenuItem value="PRODUCTION">Production</MenuItem>
                      <MenuItem value="SAMPLE">Sample</MenuItem>
                      <MenuItem value="REPAIR">Repair</MenuItem>
                    </TextField>
                  )} />
              </Grid>
              <Grid item xs={6}>
                <Controller name="priority" control={control}
                  render={({ field }) => (
                    <TextField {...field} select fullWidth label="Priority">
                      <MenuItem value="LOW">Low</MenuItem>
                      <MenuItem value="NORMAL">Normal</MenuItem>
                      <MenuItem value="HIGH">High</MenuItem>
                      <MenuItem value="URGENT">Urgent</MenuItem>
                    </TextField>
                  )} />
              </Grid>
              <Grid item xs={12}>
                <Controller name="notes" control={control}
                  render={({ field }) => <TextField {...field} fullWidth label="Notes" multiline rows={2} />} />
              </Grid>
            </Grid>
          </DialogContent>
          <DialogActions sx={{ p: 2.5 }}>
            <Button onClick={() => setCreateOpen(false)}>Cancel</Button>
            <Button type="submit" variant="contained" disabled={createMutation.isPending}>
              {createMutation.isPending ? 'Creating...' : 'Create Job Card'}
            </Button>
          </DialogActions>
        </form>
      </Dialog>
    </Box>
  );
}
