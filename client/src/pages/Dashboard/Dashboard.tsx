import { Grid, Card, CardContent, Typography, Box, Chip, Table, TableBody, TableCell, TableHead, TableRow, CircularProgress, Alert } from '@mui/material';
import { useQuery } from '@tanstack/react-query';
import {
  Assignment, Factory, Verified, LocalShipping,
  TrendingUp, Warning, Inventory, Scale,
} from '@mui/icons-material';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, PieChart, Pie, Cell } from 'recharts';
import { apiGet } from '../../api/client';
import { KpiCard } from '../../components/common/KpiCard';
import { PageHeader } from '../../components/common/PageHeader';
import { StatusChip } from '../../components/common/StatusChip';

const COLORS = ['#44C47A', '#009688', '#B00020', '#0277BD', '#1B5E20'];

export function Dashboard() {
  const { data, isLoading, error } = useQuery({
    queryKey: ['dashboard'],
    queryFn: () => apiGet<any>('/reports/dashboard'),
    refetchInterval: 60_000,
  });

  const { data: wipData } = useQuery({
    queryKey: ['wip-summary'],
    queryFn: () => apiGet<any>('/reports/wip-summary'),
    refetchInterval: 30_000,
  });

  if (error) return <Alert severity="error">Failed to load dashboard</Alert>;

  const kpis = data?.kpis ?? {};
  const metal = data?.metalStock ?? {};
  const invoices = data?.recentInvoices ?? [];

  const wipByProcess = (wipData?.wipByProcess ?? []).reduce((acc: any[], curr: any) => {
    const existing = acc.find((a) => a.process === curr.processName);
    if (existing) { existing[curr.status] = curr._count; }
    else acc.push({ process: curr.processName, [curr.status]: curr._count });
    return acc;
  }, []);

  const priorityData = (wipData?.jobsByPriority ?? []).map((d: any) => ({
    name: d.priority, value: d._count,
  }));

  return (
    <Box>
      <PageHeader
        title="Factory Operations Dashboard"
        subtitle={`Live overview — ${new Date().toLocaleDateString('en-IN', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}`}
      />

      {/* KPI Row */}
      <Grid container spacing={2} sx={{ mb: 3 }}>
        <Grid item xs={12} sm={6} md={3}>
          <KpiCard title="Active Orders" value={isLoading ? '…' : kpis.activeOrders ?? 0}
            icon={<Assignment fontSize="large" />} color="#44C47A" loading={isLoading} />
        </Grid>
        <Grid item xs={12} sm={6} md={3}>
          <KpiCard title="In Production" value={isLoading ? '…' : kpis.inProduction ?? 0}
            icon={<Factory fontSize="large" />} color="#0277BD" loading={isLoading} />
        </Grid>
        <Grid item xs={12} sm={6} md={3}>
          <KpiCard title="QC Pending" value={isLoading ? '…' : kpis.qcPending ?? 0}
            icon={<Verified fontSize="large" />} color="#E65100" loading={isLoading} />
        </Grid>
        <Grid item xs={12} sm={6} md={3}>
          <KpiCard title="Ready to Deliver" value={isLoading ? '…' : kpis.readyDelivery ?? 0}
            icon={<LocalShipping fontSize="large" />} color="#1B5E20" loading={isLoading} />
        </Grid>
      </Grid>

      {/* Secondary KPIs */}
      <Grid container spacing={2} sx={{ mb: 3 }}>
        <Grid item xs={12} sm={4}>
          <KpiCard
            title="Metal in Vault"
            value={`${Number(metal.availableGrams ?? 0).toFixed(2)} g`}
            icon={<Scale fontSize="large" />}
            color="#44C47A"
            subtitle="Total available gold + silver"
          />
        </Grid>
        <Grid item xs={12} sm={4}>
          <KpiCard
            title="Today's GRNs"
            value={kpis.todayGRNs ?? 0}
            icon={<Inventory fontSize="large" />}
            color="#009688"
          />
        </Grid>
        <Grid item xs={12} sm={4}>
          <KpiCard
            title="Overdue Memos"
            value={kpis.overdueMemoes ?? 0}
            icon={<Warning fontSize="large" />}
            color={kpis.overdueMemoes > 0 ? '#B00020' : '#1B5E20'}
            subtitle={kpis.overdueMemoes > 0 ? 'Requires immediate attention' : 'All memos on time'}
          />
        </Grid>
      </Grid>

      {/* Charts Row */}
      <Grid container spacing={2} sx={{ mb: 3 }}>
        <Grid item xs={12} md={8}>
          <Card>
            <CardContent>
              <Typography variant="subtitle1" fontWeight={700} gutterBottom>
                WIP by Process Stage
              </Typography>
              {wipByProcess.length === 0 ? (
                <Box sx={{ display: 'flex', justifyContent: 'center', p: 4 }}>
                  <Typography color="text.secondary">No active jobs</Typography>
                </Box>
              ) : (
                <ResponsiveContainer width="100%" height={220}>
                  <BarChart data={wipByProcess}>
                    <XAxis dataKey="process" tick={{ fontSize: 11 }} />
                    <YAxis tick={{ fontSize: 11 }} />
                    <Tooltip />
                    <Bar dataKey="IN_PROGRESS" fill="#44C47A" name="In Progress" radius={[4,4,0,0]} />
                    <Bar dataKey="COMPLETED" fill="#009688" name="Completed" radius={[4,4,0,0]} />
                    <Bar dataKey="PENDING" fill="#E0E0E0" name="Pending" radius={[4,4,0,0]} />
                  </BarChart>
                </ResponsiveContainer>
              )}
            </CardContent>
          </Card>
        </Grid>

        <Grid item xs={12} md={4}>
          <Card sx={{ height: '100%' }}>
            <CardContent>
              <Typography variant="subtitle1" fontWeight={700} gutterBottom>
                Jobs by Priority
              </Typography>
              {priorityData.length === 0 ? (
                <Box sx={{ display: 'flex', justifyContent: 'center', p: 4 }}>
                  <Typography color="text.secondary">No data</Typography>
                </Box>
              ) : (
                <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                  <ResponsiveContainer width="100%" height={160}>
                    <PieChart>
                      <Pie data={priorityData} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={70}>
                        {priorityData.map((_: any, index: number) => (
                          <Cell key={index} fill={COLORS[index % COLORS.length]} />
                        ))}
                      </Pie>
                      <Tooltip />
                    </PieChart>
                  </ResponsiveContainer>
                  <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, justifyContent: 'center' }}>
                    {priorityData.map((d: any, i: number) => (
                      <Chip key={d.name} label={`${d.name}: ${d.value}`} size="small"
                        sx={{ bgcolor: COLORS[i % COLORS.length], color: '#FFF', fontWeight: 600, fontSize: 11 }} />
                    ))}
                  </Box>
                </Box>
              )}
            </CardContent>
          </Card>
        </Grid>
      </Grid>

      {/* Recent Invoices */}
      <Card>
        <CardContent>
          <Typography variant="subtitle1" fontWeight={700} gutterBottom>
            Today's Invoices
          </Typography>
          {invoices.length === 0 ? (
            <Typography color="text.secondary" sx={{ py: 2, textAlign: 'center' }}>
              No invoices issued today
            </Typography>
          ) : (
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>Invoice #</TableCell>
                  <TableCell>Client</TableCell>
                  <TableCell align="right">Amount</TableCell>
                  <TableCell>Status</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {invoices.map((inv: any) => (
                  <TableRow key={inv.invoiceNumber} hover>
                    <TableCell sx={{ fontFamily: 'monospace', fontWeight: 600 }}>{inv.invoiceNumber}</TableCell>
                    <TableCell>{inv.client?.name}</TableCell>
                    <TableCell align="right" sx={{ fontWeight: 600 }}>
                      ₹{Number(inv.totalAmount).toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                    </TableCell>
                    <TableCell><StatusChip status={inv.status} /></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </Box>
  );
}
