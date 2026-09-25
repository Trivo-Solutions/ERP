import { Box, Grid, Card, CardContent, Typography, Chip, LinearProgress, Table, TableHead, TableBody, TableRow, TableCell, Alert, Stack } from '@mui/material';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { apiGet } from '../../api/client';
import { KpiCard } from '../../components/common/KpiCard';
import { PageHeader } from '../../components/common/PageHeader';
import { StatusChip } from '../../components/common/StatusChip';
import { useSocket } from '../../hooks/useSocket';
import { Factory, QueuePlayNext, Verified, PriorityHigh } from '@mui/icons-material';

const PROCESS_ORDER = ['MELTING', 'CASTING', 'FILING', 'PRE_POLISH', 'SETTING', 'POLISH', 'RHODIUM'];
const PROCESS_COLOR: Record<string, string> = {
  MELTING: '#FF6B35', CASTING: '#F7C59F', FILING: '#EFEFD0',
  PRE_POLISH: '#004E89', SETTING: '#1A936F', POLISH: '#88D498', RHODIUM: '#C6DABF',
};

export function FactoryFloor() {
  const { subscribe } = useSocket();
  const [liveUpdates, setLiveUpdates] = useState<any[]>([]);

  const { data, isLoading, refetch } = useQuery({
    queryKey: ['factory-floor'],
    queryFn: () => apiGet<any>('/manufacturing/floor'),
    refetchInterval: 30_000,
  });

  const { data: jobs } = useQuery({
    queryKey: ['active-jobs'],
    queryFn: () => apiGet<any>('/manufacturing/jobs', { status: 'IN_PROGRESS', limit: 10 }),
    refetchInterval: 15_000,
  });

  useEffect(() => {
    return subscribe('factory:update', (update: any) => {
      setLiveUpdates((prev) => [update, ...prev.slice(0, 9)]);
      refetch();
    });
  }, [subscribe, refetch]);

  const floor = data ?? {};
  const processSummary = floor.processSummary ?? [];

  const processCounts = PROCESS_ORDER.map((name) => {
    const inProgress = processSummary.find((p: any) => p.processName === name && p.status === 'IN_PROGRESS')?._count ?? 0;
    const completed = processSummary.find((p: any) => p.processName === name && p.status === 'COMPLETED')?._count ?? 0;
    return { name, inProgress, completed };
  });

  const maxCount = Math.max(...processCounts.map((p) => p.inProgress + p.completed), 1);

  return (
    <Box>
      <PageHeader title="Factory Floor — Live WIP" subtitle="Real-time production tracking across all process stations" />

      {/* KPIs */}
      <Grid container spacing={2} sx={{ mb: 3 }}>
        <Grid item xs={6} sm={3}>
          <KpiCard title="In Production" value={floor.inProgress ?? 0} icon={<Factory />} color="#44C47A" loading={isLoading} />
        </Grid>
        <Grid item xs={6} sm={3}>
          <KpiCard title="QC Pending" value={floor.qcPending ?? 0} icon={<Verified />} color="#E65100" loading={isLoading} />
        </Grid>
        <Grid item xs={6} sm={3}>
          <KpiCard title="Today Completed" value={floor.completed ?? 0} icon={<QueuePlayNext />} color="#1B5E20" loading={isLoading} />
        </Grid>
        <Grid item xs={6} sm={3}>
          <KpiCard title="Urgent Jobs" value={floor.urgent ?? 0} icon={<PriorityHigh />}
            color={floor.urgent > 0 ? '#B00020' : '#1B5E20'} loading={isLoading} />
        </Grid>
      </Grid>

      <Grid container spacing={2}>
        {/* Process Pipeline */}
        <Grid item xs={12} md={7}>
          <Card>
            <CardContent>
              <Typography variant="subtitle1" fontWeight={700} gutterBottom>
                Production Pipeline
              </Typography>
              <Stack spacing={1.5}>
                {processCounts.map((proc) => (
                  <Box key={proc.name}>
                    <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 0.5 }}>
                      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                        <Box sx={{ width: 10, height: 10, borderRadius: '50%', bgcolor: PROCESS_COLOR[proc.name] }} />
                        <Typography variant="body2" fontWeight={600} sx={{ fontSize: 13 }}>
                          {proc.name}
                        </Typography>
                      </Box>
                      <Box sx={{ display: 'flex', gap: 1 }}>
                        {proc.inProgress > 0 && (
                          <Chip label={`${proc.inProgress} active`} size="small"
                            sx={{ bgcolor: '#FFF8E7', color: '#44C47A', fontWeight: 700, fontSize: 11, height: 20 }} />
                        )}
                        {proc.completed > 0 && (
                          <Chip label={`${proc.completed} done`} size="small"
                            sx={{ bgcolor: '#E8F5E9', color: '#1B5E20', fontWeight: 700, fontSize: 11, height: 20 }} />
                        )}
                      </Box>
                    </Box>
                    <LinearProgress
                      variant="determinate"
                      value={((proc.inProgress + proc.completed) / maxCount) * 100}
                      sx={{
                        height: 8, borderRadius: 4,
                        bgcolor: '#F5F5F5',
                        '& .MuiLinearProgress-bar': { bgcolor: PROCESS_COLOR[proc.name], borderRadius: 4 },
                      }}
                    />
                  </Box>
                ))}
              </Stack>
            </CardContent>
          </Card>
        </Grid>

        {/* Active Jobs */}
        <Grid item xs={12} md={5}>
          <Card sx={{ height: '100%' }}>
            <CardContent>
              <Typography variant="subtitle1" fontWeight={700} gutterBottom>
                Active Job Cards
              </Typography>
              {liveUpdates.length > 0 && (
                <Alert severity="info" sx={{ mb: 1, py: 0.5, fontSize: 12 }}>
                  Live update received — {liveUpdates[0]?.type}
                </Alert>
              )}
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>Job #</TableCell>
                    <TableCell>Design</TableCell>
                    <TableCell>Process</TableCell>
                    <TableCell>Priority</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {((jobs as any)?.jobCards ?? []).map((jc: any) => (
                    <TableRow key={jc.id} hover>
                      <TableCell sx={{ fontFamily: 'monospace', fontSize: 12, fontWeight: 700 }}>{jc.jobNumber}</TableCell>
                      <TableCell sx={{ fontSize: 12 }}>{jc.design?.name}</TableCell>
                      <TableCell>
                        <Chip label={jc.currentProcess ?? '?'} size="small"
                          sx={{ fontSize: 10, bgcolor: PROCESS_COLOR[jc.currentProcess] ?? '#E0E0E0', height: 20 }} />
                      </TableCell>
                      <TableCell>
                        <Chip
                          label={jc.priority}
                          size="small"
                          color={jc.priority === 'URGENT' ? 'error' : jc.priority === 'HIGH' ? 'warning' : 'default'}
                          sx={{ fontSize: 10, height: 20 }}
                        />
                      </TableCell>
                    </TableRow>
                  ))}
                  {((jobs as any)?.jobCards ?? []).length === 0 && (
                    <TableRow>
                      <TableCell colSpan={4} align="center" sx={{ py: 3, color: 'text.secondary' }}>
                        No active jobs
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </Grid>
      </Grid>
    </Box>
  );
}
