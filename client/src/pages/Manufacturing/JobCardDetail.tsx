import { useState, useEffect } from 'react';
import { useParams } from 'react-router-dom';
import {
  Box, Grid, Card, CardContent, Typography, Chip, Button, Stepper, Step, StepLabel,
  StepContent, Table, TableHead, TableBody, TableRow, TableCell, Alert, Dialog,
  DialogTitle, DialogContent, DialogActions, TextField, MenuItem, Divider, LinearProgress,
} from '@mui/material';
import { CheckCircle, Scale, QrCode } from '@mui/icons-material';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm, Controller } from 'react-hook-form';
import { useSnackbar } from 'notistack';
import { apiGet, apiPost } from '../../api/client';
import { PageHeader } from '../../components/common/PageHeader';
import { StatusChip } from '../../components/common/StatusChip';
import { WeightDisplay } from '../../components/common/WeightDisplay';
import { useJobCardUpdates, useScaleReading } from '../../hooks/useSocket';
import { useUiStore } from '../../store/ui.store';

export function JobCardDetail() {
  const { id } = useParams<{ id: string }>();
  const { enqueueSnackbar } = useSnackbar();
  const qc = useQueryClient();
  const { scaleDevice } = useUiStore();
  const [wipOpen, setWipOpen] = useState(false);
  const [qcOpen, setQcOpen] = useState(false);
  const [scaleWeight, setScaleWeight] = useState<number | null>(null);

  const { data: jc, isLoading } = useQuery({
    queryKey: ['job-card', id],
    queryFn: () => apiGet<any>(`/manufacturing/jobs/${id}`),
  });

  // Live scale reading
  useScaleReading(scaleDevice, (w) => setScaleWeight(w));

  // Live job card updates via WS
  useJobCardUpdates(id!, () => qc.invalidateQueries({ queryKey: ['job-card', id] }));

  const wipForm = useForm({
    defaultValues: { processId: '', issuedWeight: 0, returnedWeight: 0, scrapWeight: 0, scaleReading: 0 },
  });

  const qcForm = useForm({
    defaultValues: { processId: '', result: 'PASSED', stoneCount: 0, stoneSecure: true, notes: '' },
  });

  const wipMutation = useMutation({
    mutationFn: (data: any) => apiPost(`/manufacturing/jobs/${id}/wip`, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['job-card', id] });
      setWipOpen(false);
      wipForm.reset();
      enqueueSnackbar('WIP entry recorded', { variant: 'success' });
    },
    onError: (err: any) => enqueueSnackbar(err.response?.data?.error ?? 'Failed', { variant: 'error' }),
  });

  const advanceMutation = useMutation({
    mutationFn: (processId: string) => apiPost(`/manufacturing/jobs/${id}/advance`, { processId }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['job-card', id] });
      enqueueSnackbar('Process advanced', { variant: 'success' });
    },
  });

  const qcMutation = useMutation({
    mutationFn: (data: any) => apiPost(`/manufacturing/jobs/${id}/qc`, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['job-card', id] });
      setQcOpen(false);
      qcForm.reset();
      enqueueSnackbar('QC checkpoint submitted', { variant: 'success' });
    },
  });

  if (isLoading) return <Typography>Loading job card...</Typography>;
  if (!jc) return <Alert severity="error">Job card not found</Alert>;

  const processes = jc.processes ?? [];
  const activeProcessIdx = processes.findIndex((p: any) => p.status === 'IN_PROGRESS');
  const totalLoss = Number(jc.issuedWeight) > 0
    ? ((Number(jc.issuedWeight) - Number(jc.returnedWeight) - Number(jc.scrapWeight)) / Number(jc.issuedWeight)) * 100
    : 0;

  return (
    <Box>
      <PageHeader
        title={`Job Card: ${jc.jobNumber}`}
        subtitle={`${jc.design?.name} | ${jc.design?.metalKarat} | Batch: ${jc.batchSize} pcs`}
        breadcrumbs={[{ label: 'Manufacturing', path: '/manufacturing' }, { label: 'Jobs', path: '/manufacturing/jobs' }, { label: jc.jobNumber }]}
        actions={[
          { label: 'Record WIP', onClick: () => setWipOpen(true), variant: 'outlined' as const },
          ...(jc.status === 'QC_PENDING' ? [{ label: 'QC Checkpoint', icon: <CheckCircle />, onClick: () => setQcOpen(true) }] : []),
        ]}
      />

      {/* Live Scale */}
      {scaleWeight !== null && (
        <Alert severity="info" sx={{ mb: 2 }}>
          <Scale sx={{ mr: 1, verticalAlign: 'middle' }} />
          Live Scale Reading: <strong>{scaleWeight.toFixed(3)} g</strong> (Device: {scaleDevice})
        </Alert>
      )}

      {/* Summary */}
      <Grid container spacing={2} sx={{ mb: 2 }}>
        {[
          { label: 'Status', value: <StatusChip status={jc.status} size="medium" /> },
          { label: 'Issued Weight', value: `${Number(jc.issuedWeight).toFixed(3)} g` },
          { label: 'Returned Weight', value: `${Number(jc.returnedWeight).toFixed(3)} g` },
          { label: 'Scrap Weight', value: `${Number(jc.scrapWeight).toFixed(3)} g` },
          { label: 'Process Loss', value: `${totalLoss.toFixed(2)}%`, color: totalLoss > 3 ? 'error.main' : 'success.main' },
          { label: 'Priority', value: <Chip label={jc.priority} size="small" color={jc.priority === 'URGENT' ? 'error' : 'default'} /> },
        ].map(({ label, value, color }) => (
          <Grid item xs={6} sm={4} md={2} key={label}>
            <Card>
              <CardContent sx={{ p: 1.5, '&:last-child': { pb: 1.5 } }}>
                <Typography variant="caption" color="text.secondary">{label}</Typography>
                <Typography variant="body2" fontWeight={700} sx={{ color, fontFamily: typeof value === 'string' ? 'monospace' : undefined }}>
                  {value as any}
                </Typography>
              </CardContent>
            </Card>
          </Grid>
        ))}
      </Grid>

      <Grid container spacing={2}>
        {/* Process Stepper */}
        <Grid item xs={12} md={5}>
          <Card>
            <CardContent>
              <Typography variant="subtitle1" fontWeight={700} gutterBottom>Process Routing</Typography>
              <Stepper activeStep={activeProcessIdx} orientation="vertical">
                {processes.map((proc: any) => (
                  <Step key={proc.id} completed={proc.status === 'COMPLETED'}>
                    <StepLabel
                      optional={proc.status === 'IN_PROGRESS' ? <Chip label="ACTIVE" size="small" color="warning" sx={{ fontSize: 10 }} /> : undefined}
                    >
                      <Typography fontWeight={proc.status === 'IN_PROGRESS' ? 700 : 400} fontSize={14}>
                        {proc.processName}
                      </Typography>
                    </StepLabel>
                    <StepContent>
                      <Box sx={{ display: 'flex', gap: 1, mt: 1 }}>
                        {proc.lossPercent != null && (
                          <Chip label={`Loss: ${Number(proc.lossPercent).toFixed(2)}%`} size="small"
                            color={Number(proc.lossPercent) > 3 ? 'error' : 'success'} />
                        )}
                        <Button size="small" variant="contained" onClick={() => advanceMutation.mutate(proc.id)}>
                          Advance →
                        </Button>
                      </Box>
                    </StepContent>
                  </Step>
                ))}
              </Stepper>
            </CardContent>
          </Card>
        </Grid>

        {/* WIP Log */}
        <Grid item xs={12} md={7}>
          <Card>
            <CardContent>
              <Typography variant="subtitle1" fontWeight={700} gutterBottom>WIP Tracking Log</Typography>
              <Box sx={{ overflowX: 'auto' }}>
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>Worker</TableCell>
                    <TableCell>Issued</TableCell>
                    <TableCell>Returned</TableCell>
                    <TableCell>Scrap</TableCell>
                    <TableCell>Loss %</TableCell>
                    <TableCell>Timestamp</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {(jc.wipTracking ?? []).map((wip: any) => (
                    <TableRow key={wip.id} hover>
                      <TableCell>{wip.worker?.name}</TableCell>
                      <TableCell sx={{ fontFamily: 'monospace' }}>{Number(wip.issuedWeight).toFixed(3)}g</TableCell>
                      <TableCell sx={{ fontFamily: 'monospace' }}>{Number(wip.returnedWeight).toFixed(3)}g</TableCell>
                      <TableCell sx={{ fontFamily: 'monospace' }}>{Number(wip.scrapWeight).toFixed(3)}g</TableCell>
                      <TableCell sx={{ fontFamily: 'monospace', color: Number(wip.lossPercent) > 3 ? 'error.main' : 'inherit' }}>
                        {Number(wip.lossPercent).toFixed(2)}%
                      </TableCell>
                      <TableCell sx={{ fontSize: 11 }}>{new Date(wip.timestamp).toLocaleString('en-IN')}</TableCell>
                    </TableRow>
                  ))}
                  {(jc.wipTracking ?? []).length === 0 && (
                    <TableRow><TableCell colSpan={6} align="center" sx={{ py: 2 }}>No WIP entries yet</TableCell></TableRow>
                  )}
                </TableBody>
              </Table>
              </Box>
            </CardContent>
          </Card>
        </Grid>
      </Grid>

      {/* WIP Dialog */}
      <Dialog open={wipOpen} onClose={() => setWipOpen(false)} maxWidth="sm" fullWidth>
        <form onSubmit={wipForm.handleSubmit((d) => wipMutation.mutate({ ...d, workerId: 'current-user' }))}>
          <DialogTitle fontWeight={700}>Record WIP Entry</DialogTitle>
          <DialogContent sx={{ pt: 2 }}>
            {scaleWeight !== null && (
              <Alert severity="success" sx={{ mb: 2 }}>
                Auto-fill from scale: {scaleWeight.toFixed(3)} g
              </Alert>
            )}
            <Grid container spacing={2}>
              <Grid item xs={12}>
                <Controller name="processId" control={wipForm.control} rules={{ required: true }}
                  render={({ field }) => (
                    <TextField {...field} select fullWidth label="Process">
                      {processes.filter((p: any) => p.status !== 'PENDING').map((p: any) => (
                        <MenuItem key={p.id} value={p.id}>{p.processName}</MenuItem>
                      ))}
                    </TextField>
                  )} />
              </Grid>
              <Grid item xs={4}>
                <Controller name="issuedWeight" control={wipForm.control}
                  render={({ field }) => <TextField {...field} fullWidth label="Issued (g)" type="number" inputProps={{ step: 0.001 }} />} />
              </Grid>
              <Grid item xs={4}>
                <Controller name="returnedWeight" control={wipForm.control}
                  render={({ field }) => <TextField {...field} fullWidth label="Returned (g)" type="number" inputProps={{ step: 0.001 }}
                    InputProps={{ endAdornment: scaleWeight && <Button size="small" onClick={() => wipForm.setValue('returnedWeight', scaleWeight)}>←Scale</Button> }} />} />
              </Grid>
              <Grid item xs={4}>
                <Controller name="scrapWeight" control={wipForm.control}
                  render={({ field }) => <TextField {...field} fullWidth label="Scrap (g)" type="number" inputProps={{ step: 0.001 }} />} />
              </Grid>
            </Grid>
          </DialogContent>
          <DialogActions sx={{ p: 2.5 }}>
            <Button onClick={() => setWipOpen(false)}>Cancel</Button>
            <Button type="submit" variant="contained" disabled={wipMutation.isPending}>Submit</Button>
          </DialogActions>
        </form>
      </Dialog>

      {/* QC Dialog */}
      <Dialog open={qcOpen} onClose={() => setQcOpen(false)} maxWidth="sm" fullWidth>
        <form onSubmit={qcForm.handleSubmit((d) => qcMutation.mutate(d))}>
          <DialogTitle fontWeight={700}>QC Checkpoint — Digital Sign-off</DialogTitle>
          <DialogContent sx={{ pt: 2 }}>
            <Alert severity="warning" sx={{ mb: 2 }}>
              This is a binding QC sign-off. Verify all stone settings before proceeding.
            </Alert>
            <Grid container spacing={2}>
              <Grid item xs={12}>
                <Controller name="processId" control={qcForm.control} rules={{ required: true }}
                  render={({ field }) => (
                    <TextField {...field} select fullWidth label="Process Checkpoint">
                      {processes.map((p: any) => <MenuItem key={p.id} value={p.id}>{p.processName}</MenuItem>)}
                    </TextField>
                  )} />
              </Grid>
              <Grid item xs={6}>
                <Controller name="result" control={qcForm.control}
                  render={({ field }) => (
                    <TextField {...field} select fullWidth label="QC Result">
                      <MenuItem value="PASSED">Passed ✓</MenuItem>
                      <MenuItem value="FAILED">Failed ✗</MenuItem>
                      <MenuItem value="CONDITIONAL">Conditional</MenuItem>
                    </TextField>
                  )} />
              </Grid>
              <Grid item xs={6}>
                <Controller name="stoneCount" control={qcForm.control}
                  render={({ field }) => <TextField {...field} fullWidth label="Stone Count (verified)" type="number" />} />
              </Grid>
              <Grid item xs={12}>
                <Controller name="notes" control={qcForm.control}
                  render={({ field }) => <TextField {...field} fullWidth label="Inspection Notes" multiline rows={3} />} />
              </Grid>
            </Grid>
          </DialogContent>
          <DialogActions sx={{ p: 2.5 }}>
            <Button onClick={() => setQcOpen(false)}>Cancel</Button>
            <Button type="submit" variant="contained" color="success" disabled={qcMutation.isPending}>
              Submit QC Sign-off
            </Button>
          </DialogActions>
        </form>
      </Dialog>
    </Box>
  );
}
