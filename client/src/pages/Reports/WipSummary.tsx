import { Box, Grid, Card, CardContent, Typography, Table, TableHead, TableBody, TableRow, TableCell, Chip } from '@mui/material';
import { useQuery } from '@tanstack/react-query';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell } from 'recharts';
import { apiGet } from '../../api/client';
import { PageHeader } from '../../components/common/PageHeader';

const COLORS: Record<string, string> = { PENDING: '#E0E0E0', IN_PROGRESS: '#44C47A', COMPLETED: '#1B5E20' };

export function WipSummary() {
  const { data, isLoading } = useQuery({ queryKey: ['wip-summary'], queryFn: () => apiGet<any>('/reports/wip-summary'), refetchInterval: 30_000 });
  const wip = data ?? {};

  const processData = (wip.wipByProcess ?? []).reduce((acc: any[], curr: any) => {
    const existing = acc.find((a) => a.process === curr.processName);
    if (existing) existing[curr.status] = (existing[curr.status] || 0) + curr._count;
    else acc.push({ process: curr.processName, [curr.status]: curr._count });
    return acc;
  }, []);

  return (
    <Box>
      <PageHeader title="WIP Summary Report" subtitle="Live factory floor work-in-progress by process and priority"
        breadcrumbs={[{ label: 'Reports', path: '/reports/wip' }, { label: 'WIP Summary' }]} />

      <Grid container spacing={2}>
        <Grid item xs={12} md={8}>
          <Card>
            <CardContent>
              <Typography variant="subtitle1" fontWeight={700} gutterBottom>Jobs by Process Stage</Typography>
              <ResponsiveContainer width="100%" height={280}>
                <BarChart data={processData}>
                  <XAxis dataKey="process" tick={{ fontSize: 11 }} />
                  <YAxis tick={{ fontSize: 11 }} />
                  <Tooltip />
                  <Bar dataKey="IN_PROGRESS" fill="#44C47A" name="In Progress" radius={[4,4,0,0]} />
                  <Bar dataKey="COMPLETED" fill="#1B5E20" name="Completed" radius={[4,4,0,0]} />
                  <Bar dataKey="PENDING" fill="#E0E0E0" name="Pending" radius={[4,4,0,0]} />
                </BarChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>
        </Grid>
        <Grid item xs={12} md={4}>
          <Card sx={{ height: '100%' }}>
            <CardContent>
              <Typography variant="subtitle1" fontWeight={700} gutterBottom>Priority Breakdown</Typography>
              <Table size="small">
                <TableHead><TableRow><TableCell>Priority</TableCell><TableCell>Status</TableCell><TableCell align="right">Count</TableCell></TableRow></TableHead>
                <TableBody>
                  {(wip.jobsByPriority ?? []).map((row: any, i: number) => (
                    <TableRow key={i} hover>
                      <TableCell><Chip label={row.priority} size="small" color={row.priority === 'URGENT' ? 'error' : row.priority === 'HIGH' ? 'warning' : 'default'} /></TableCell>
                      <TableCell sx={{ fontSize: 12 }}>{row.status}</TableCell>
                      <TableCell align="right" sx={{ fontWeight: 700 }}>{row._count}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </Grid>
      </Grid>
    </Box>
  );
}
