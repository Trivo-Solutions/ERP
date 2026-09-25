import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Box, Card, Grid, Typography, Chip, Button, Table, TableHead, TableBody,
  TableRow, TableCell, Dialog, DialogTitle, DialogContent, DialogActions,
  TextField, MenuItem, Alert, Divider, LinearProgress, IconButton, Tooltip,
} from '@mui/material';
import {
  Verified, CheckCircle, Cancel, Warning, OpenInNew, HowToReg,
} from '@mui/icons-material';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm, Controller } from 'react-hook-form';
import { useSnackbar } from 'notistack';
import { apiGet, apiPost } from '../../api/client';
import { PageHeader } from '../../components/common/PageHeader';
import { KpiCard } from '../../components/common/KpiCard';
import { WeightDisplay } from '../../components/common/WeightDisplay';

const QC_CHECKLIST = [
  { key: 'stoneCount',    label: 'Stone count matches BOM specification' },
  { key: 'stoneSecure',   label: 'All stones are securely set (prong / bezel check)' },
  { key: 'noRoughEdges',  label: 'No rough edges or sharp burrs on the metal' },
  { key: 'surfaceFinish', label: 'Surface finish uniform — no visible scratches or pitting' },
  { key: 'weightCheck',   label: 'Net weight within tolerance range' },
  { key: 'sizeCheck',     label: 'Ring size / dimensions match order specification' },
];

interface QcFormData {
  processId: string;
  result: 'PASSED' | 'FAILED' | 'CONDITIONAL';
  stoneCount: number;
  stoneSecure: boolean;
  notes: string;
  checklistData: Record<string, boolean>;
}

export function QcCheckpoints() {
  const navigate = useNavigate();
  const { enqueueSnackbar } = useSnackbar();
  const qc = useQueryClient();
  const [selectedJob, setSelectedJob] = useState<any>(null);
  const [checklist, setChecklist] = useState<Record<string, boolean>>({});

  // All jobs waiting for QC
  const { data: pendingData, isLoading: pendingLoading } = useQuery({
    queryKey: ['qc-pending'],
    queryFn: () => apiGet<any>('/manufacturing/jobs', { status: 'QC_PENDING', limit: 50 }),
    refetchInterval: 15_000,
  });

  // Recently passed QC today
  const { data: passedData } = useQuery({
    queryKey: ['qc-passed-today'],
    queryFn: () => apiGet<any>('/manufacturing/jobs', { status: 'QC_PASSED', limit: 20 }),
    refetchInterval: 30_000,
  });

  const { control, handleSubmit, watch, reset, formState: { errors } } = useForm<QcFormData>({
    defaultValues: {
      processId: '',
      result: 'PASSED',
      stoneCount: 0,
      stoneSecure: true,
      notes: '',
      checklistData: {},
    },
  });

  const resultWatch = watch('result');

  const qcMutation = useMutation({
    mutationFn: (data: QcFormData) =>
      apiPost(`/manufacturing/jobs/${selectedJob.id}/qc`, {
        processId: data.processId,
        result: data.result,
        stoneCount: Number(data.stoneCount),
        stoneSecure: data.stoneSecure,
        notes: data.notes,
        checklistData: checklist,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['qc-pending'] });
      qc.invalidateQueries({ queryKey: ['qc-passed-today'] });
      setSelectedJob(null);
      setChecklist({});
      reset();
      enqueueSnackbar('QC checkpoint recorded and signed', { variant: 'success' });
    },
    onError: (err: any) =>
      enqueueSnackbar(err.response?.data?.error ?? 'QC submission failed', { variant: 'error' }),
  });

  const pendingJobs: any[]  = (pendingData as any)?.jobCards ?? [];
  const passedJobs: any[]   = (passedData  as any)?.jobCards ?? [];

  const checklistComplete = QC_CHECKLIST.every((item) => checklist[item.key] !== undefined);
  const allPassed         = QC_CHECKLIST.every((item) => checklist[item.key] === true);

  // When checklist is all-pass, auto-set result to PASSED; if any fail → FAILED
  const derivedResult = allPassed ? 'PASSED' : Object.keys(checklist).length > 0 ? 'CONDITIONAL' : null;

  const openDialog = (job: any) => {
    setSelectedJob(job);
    setChecklist({});
    reset({
      processId: job.processes?.find((p: any) => p.status === 'COMPLETED')?.id
        ?? job.processes?.[job.processes.length - 1]?.id
        ?? '',
      result: 'PASSED',
      stoneCount: 0,
      stoneSecure: true,
      notes: '',
    });
  };

  return (
    <Box>
      <PageHeader
        title="QC Checkpoints"
        subtitle="Digital sign-off gate — a piece cannot proceed to final polish until QC is cleared"
        breadcrumbs={[
          { label: 'Manufacturing', path: '/manufacturing' },
          { label: 'QC Checkpoints' },
        ]}
      />

      {/* KPIs */}
      <Grid container spacing={2} sx={{ mb: 3 }}>
        <Grid item xs={6} sm={3}>
          <KpiCard
            title="Awaiting QC"
            value={pendingJobs.length}
            icon={<Warning />}
            color={pendingJobs.length > 0 ? '#E65100' : '#1B5E20'}
            subtitle={pendingJobs.length > 0 ? 'Need immediate inspection' : 'All clear'}
          />
        </Grid>
        <Grid item xs={6} sm={3}>
          <KpiCard
            title="Passed Today"
            value={passedJobs.length}
            icon={<CheckCircle />}
            color="#1B5E20"
          />
        </Grid>
        <Grid item xs={6} sm={3}>
          <KpiCard
            title="Urgent Pending"
            value={pendingJobs.filter((j) => j.priority === 'URGENT').length}
            icon={<Verified />}
            color="#B00020"
          />
        </Grid>
        <Grid item xs={6} sm={3}>
          <KpiCard
            title="High Priority"
            value={pendingJobs.filter((j) => j.priority === 'HIGH').length}
            icon={<HowToReg />}
            color="#44C47A"
          />
        </Grid>
      </Grid>

      <Grid container spacing={2}>
        {/* ── Pending QC ─────────────────────────────────────────────── */}
        <Grid item xs={12} md={8}>
          <Card>
            <Box sx={{ p: 2, borderBottom: 1, borderColor: 'divider', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <Typography variant="subtitle1" fontWeight={700}>
                Pending QC Sign-Off
              </Typography>
              {pendingLoading && <LinearProgress sx={{ width: 120, borderRadius: 2 }} />}
            </Box>

            {pendingJobs.length === 0 && !pendingLoading ? (
              <Box sx={{ p: 5, textAlign: 'center' }}>
                <CheckCircle sx={{ fontSize: 48, color: 'success.main', mb: 1 }} />
                <Typography color="text.secondary">No job cards waiting for QC — all clear!</Typography>
              </Box>
            ) : (
              <Box sx={{ overflowX: 'auto' }}>
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>Job #</TableCell>
                    <TableCell>Design</TableCell>
                    <TableCell>Karat</TableCell>
                    <TableCell align="center">Batch</TableCell>
                    <TableCell align="right">Issued Wt</TableCell>
                    <TableCell>Priority</TableCell>
                    <TableCell>Order</TableCell>
                    <TableCell align="center">Action</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {pendingJobs.map((job) => (
                    <TableRow
                      key={job.id}
                      hover
                      sx={{ bgcolor: job.priority === 'URGENT' ? '#FFF5F5' : 'inherit' }}
                    >
                      <TableCell>
                        <Typography sx={{ fontFamily: 'monospace', fontSize: 12, fontWeight: 700, color: '#44C47A' }}>
                          {job.jobNumber}
                        </Typography>
                      </TableCell>
                      <TableCell sx={{ fontWeight: 600, fontSize: 13 }}>{job.design?.name}</TableCell>
                      <TableCell>
                        <Chip label={job.design?.metalKarat} size="small"
                          sx={{ bgcolor: '#FFF8E7', color: '#44C47A', fontWeight: 700 }} />
                      </TableCell>
                      <TableCell align="center">{job.batchSize}</TableCell>
                      <TableCell align="right" sx={{ fontFamily: 'monospace', fontSize: 12 }}>
                        {Number(job.issuedWeight).toFixed(3)} g
                      </TableCell>
                      <TableCell>
                        <Chip
                          label={job.priority}
                          size="small"
                          color={job.priority === 'URGENT' ? 'error' : job.priority === 'HIGH' ? 'warning' : 'default'}
                        />
                      </TableCell>
                      <TableCell sx={{ fontSize: 12 }}>
                        {job.order?.orderNumber ?? '—'}
                      </TableCell>
                      <TableCell align="center">
                        <Box sx={{ display: 'flex', gap: 0.5, justifyContent: 'center' }}>
                          <Tooltip title="Open QC Sign-Off">
                            <Button
                              size="small"
                              variant="contained"
                              startIcon={<Verified />}
                              onClick={() => openDialog(job)}
                              sx={{ fontSize: 11 }}
                            >
                              Inspect
                            </Button>
                          </Tooltip>
                          <Tooltip title="View Job Card">
                            <IconButton size="small" onClick={() => navigate(`/manufacturing/jobs/${job.id}`)}>
                              <OpenInNew fontSize="small" />
                            </IconButton>
                          </Tooltip>
                        </Box>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              </Box>
            )}
          </Card>
        </Grid>

        {/* ── Passed Today ────────────────────────────────────────────── */}
        <Grid item xs={12} md={4}>
          <Card sx={{ height: '100%' }}>
            <Box sx={{ p: 2, borderBottom: 1, borderColor: 'divider' }}>
              <Typography variant="subtitle1" fontWeight={700}>QC Passed — Recent</Typography>
            </Box>
            {passedJobs.length === 0 ? (
              <Box sx={{ p: 3, textAlign: 'center' }}>
                <Typography variant="caption" color="text.secondary">No recently passed jobs</Typography>
              </Box>
            ) : (
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>Job #</TableCell>
                    <TableCell>Design</TableCell>
                    <TableCell align="right">Net Wt</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {passedJobs.slice(0, 12).map((job) => (
                    <TableRow key={job.id} hover sx={{ cursor: 'pointer' }}
                      onClick={() => navigate(`/manufacturing/jobs/${job.id}`)}>
                      <TableCell sx={{ fontFamily: 'monospace', fontSize: 12, color: '#1B5E20', fontWeight: 700 }}>
                        {job.jobNumber}
                      </TableCell>
                      <TableCell sx={{ fontSize: 12 }}>{job.design?.name}</TableCell>
                      <TableCell align="right" sx={{ fontFamily: 'monospace', fontSize: 12 }}>
                        {job.netWeight ? `${Number(job.netWeight).toFixed(3)} g` : '—'}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </Card>
        </Grid>
      </Grid>

      {/* ── QC Sign-Off Dialog ────────────────────────────────────────── */}
      <Dialog
        open={!!selectedJob}
        onClose={() => { setSelectedJob(null); setChecklist({}); reset(); }}
        maxWidth="sm"
        fullWidth
        PaperProps={{ sx: { borderRadius: 3 } }}
      >
        <form onSubmit={handleSubmit((d) => qcMutation.mutate(d))}>
          <DialogTitle sx={{ fontWeight: 700, borderBottom: 1, borderColor: 'divider', pb: 1.5 }}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
              <Verified sx={{ color: '#44C47A' }} />
              QC Sign-Off — {selectedJob?.jobNumber}
            </Box>
            <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 0.5 }}>
              {selectedJob?.design?.name} &nbsp;|&nbsp; {selectedJob?.design?.metalKarat} &nbsp;|&nbsp; Batch: {selectedJob?.batchSize}
            </Typography>
          </DialogTitle>

          <DialogContent sx={{ pt: 2.5 }}>
            {/* Checklist */}
            <Typography variant="subtitle2" fontWeight={700} sx={{ mb: 1.5 }}>
              Inspection Checklist
              <Typography component="span" variant="caption" color="text.secondary" sx={{ ml: 1 }}>
                (check each item before signing off)
              </Typography>
            </Typography>

            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1, mb: 2 }}>
              {QC_CHECKLIST.map((item) => (
                <Box
                  key={item.key}
                  sx={{
                    display: 'flex', alignItems: 'center', gap: 1.5,
                    p: 1.5, borderRadius: 2, border: 1,
                    borderColor: checklist[item.key] === true
                      ? 'success.light'
                      : checklist[item.key] === false
                        ? 'error.light'
                        : 'divider',
                    bgcolor: checklist[item.key] === true
                      ? '#F0FFF4'
                      : checklist[item.key] === false
                        ? '#FFF5F5'
                        : '#FAFAFA',
                    transition: 'all 0.15s',
                  }}
                >
                  <Typography variant="body2" sx={{ flex: 1, fontSize: 13 }}>
                    {item.label}
                  </Typography>
                  <Box sx={{ display: 'flex', gap: 0.5 }}>
                    <IconButton
                      size="small"
                      onClick={() => setChecklist((p) => ({ ...p, [item.key]: true }))}
                      sx={{
                        color: checklist[item.key] === true ? 'success.main' : 'text.disabled',
                        bgcolor: checklist[item.key] === true ? 'success.50' : 'transparent',
                      }}
                    >
                      <CheckCircle fontSize="small" />
                    </IconButton>
                    <IconButton
                      size="small"
                      onClick={() => setChecklist((p) => ({ ...p, [item.key]: false }))}
                      sx={{
                        color: checklist[item.key] === false ? 'error.main' : 'text.disabled',
                        bgcolor: checklist[item.key] === false ? 'error.50' : 'transparent',
                      }}
                    >
                      <Cancel fontSize="small" />
                    </IconButton>
                  </Box>
                </Box>
              ))}
            </Box>

            {/* Progress */}
            <Box sx={{ mb: 2 }}>
              <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 0.5 }}>
                <Typography variant="caption" color="text.secondary">Checklist progress</Typography>
                <Typography variant="caption" color="text.secondary">
                  {Object.keys(checklist).length} / {QC_CHECKLIST.length}
                </Typography>
              </Box>
              <LinearProgress
                variant="determinate"
                value={(Object.keys(checklist).length / QC_CHECKLIST.length) * 100}
                color={allPassed ? 'success' : 'warning'}
                sx={{ height: 6, borderRadius: 3 }}
              />
            </Box>

            <Divider sx={{ my: 2 }} />

            <Grid container spacing={2}>
              <Grid item xs={6}>
                <Controller
                  name="stoneCount"
                  control={control}
                  render={({ field }) => (
                    <TextField
                      {...field}
                      fullWidth
                      label="Stone Count (physically verified)"
                      type="number"
                      inputProps={{ min: 0 }}
                      size="small"
                    />
                  )}
                />
              </Grid>
              <Grid item xs={6}>
                <Controller
                  name="result"
                  control={control}
                  rules={{ required: true }}
                  render={({ field }) => (
                    <TextField {...field} select fullWidth label="QC Result" size="small"
                      sx={{
                        '& .MuiOutlinedInput-root': {
                          borderColor: field.value === 'PASSED'
                            ? 'success.main'
                            : field.value === 'FAILED'
                              ? 'error.main'
                              : 'warning.main',
                        },
                      }}
                    >
                      <MenuItem value="PASSED">
                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                          <CheckCircle fontSize="small" color="success" />
                          Passed ✓
                        </Box>
                      </MenuItem>
                      <MenuItem value="CONDITIONAL">
                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                          <Warning fontSize="small" color="warning" />
                          Conditional — minor rework needed
                        </Box>
                      </MenuItem>
                      <MenuItem value="FAILED">
                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                          <Cancel fontSize="small" color="error" />
                          Failed — send to repair
                        </Box>
                      </MenuItem>
                    </TextField>
                  )}
                />
              </Grid>
              <Grid item xs={12}>
                <Controller
                  name="notes"
                  control={control}
                  render={({ field }) => (
                    <TextField
                      {...field}
                      fullWidth
                      label="Inspection Notes / Defects Found"
                      multiline
                      rows={3}
                      size="small"
                      placeholder="Describe any defects, observations, or conditional requirements..."
                    />
                  )}
                />
              </Grid>
            </Grid>

            {/* Result alerts */}
            {resultWatch === 'FAILED' && (
              <Alert severity="error" sx={{ mt: 2, borderRadius: 2 }}>
                <strong>Job card will be marked REJECTED.</strong> A Repair Job will need to be created separately from the Quality → Repairs section.
              </Alert>
            )}
            {resultWatch === 'CONDITIONAL' && (
              <Alert severity="warning" sx={{ mt: 2, borderRadius: 2 }}>
                Piece proceeds but requires minor rework. Document requirements clearly in the notes field above.
              </Alert>
            )}
            {resultWatch === 'PASSED' && checklistComplete && allPassed && (
              <Alert severity="success" sx={{ mt: 2, borderRadius: 2 }}>
                All checklist items verified. Ready to advance to Final Polish.
              </Alert>
            )}
          </DialogContent>

          <DialogActions sx={{ p: 2.5, borderTop: 1, borderColor: 'divider', gap: 1 }}>
            <Button
              onClick={() => { setSelectedJob(null); setChecklist({}); reset(); }}
              color="inherit"
            >
              Cancel
            </Button>
            <Button
              type="submit"
              variant="contained"
              disabled={qcMutation.isPending || !checklistComplete}
              startIcon={<HowToReg />}
              color={resultWatch === 'PASSED' ? 'success' : resultWatch === 'FAILED' ? 'error' : 'warning'}
              sx={{ fontWeight: 700 }}
            >
              {qcMutation.isPending ? 'Submitting…' : 'Sign Off & Submit'}
            </Button>
          </DialogActions>
        </form>
      </Dialog>
    </Box>
  );
}
