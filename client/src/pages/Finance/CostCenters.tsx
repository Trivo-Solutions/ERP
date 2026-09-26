import {
  Box, Card, CardContent, Grid, Typography, Table, TableHead, TableBody,
  TableRow, TableCell, Chip, LinearProgress,
} from '@mui/material';
import { useQuery } from '@tanstack/react-query';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell } from 'recharts';
import { apiGet } from '../../api/client';
import { PageHeader } from '../../components/common/PageHeader';

const DEPT_COLORS: Record<string, string> = {
  CAD_ROOM: '#7B1FA2', CASTING: '#E65100', POLISHING: '#0277BD',
  SETTING: '#1B5E20', RHODIUM: '#00838F', ADMIN: '#555', SALES: '#44C47A',
};

const INR = (v: number) =>
  v.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function CostCenters() {
  const { data: centers, isLoading } = useQuery({
    queryKey: ['cost-centers-list'],
    queryFn: () => apiGet<any[]>('/finance/cost-centers'),
  });

  const { data: profitability } = useQuery({
    queryKey: ['cost-center-pnl'],
    queryFn: () => apiGet<any[]>('/finance/reports/cost-centers'),
  });

  const pnlMap = new Map((profitability ?? []).map((c: any) => [c.id, c]));
  const chartData = (profitability ?? []).map((c: any) => ({
    name: c.name.replace(' Department', '').replace(' Room', ''),
    revenue: c.revenue,
    expenses: c.expenses,
    profit: c.profit,
  }));

  const totalRevenue  = (profitability ?? []).reduce((s: number, c: any) => s + c.revenue, 0);
  const totalExpenses = (profitability ?? []).reduce((s: number, c: any) => s + c.expenses, 0);
  const totalProfit   = totalRevenue - totalExpenses;

  return (
    <Box>
      <PageHeader
        title="Cost Centers"
      />

      {/* Totals */}
      <Grid container spacing={2} sx={{ mb: 3 }}>
        {[
          { label: 'Total Revenue', value: totalRevenue, color: '#1B5E20' },
          { label: 'Total Expenses', value: totalExpenses, color: '#B00020' },
          { label: totalProfit >= 0 ? 'Net Profit' : 'Net Loss', value: Math.abs(totalProfit), color: totalProfit >= 0 ? '#1B5E20' : '#B00020' },
        ].map((s) => (
          <Grid item xs={12} sm={4} key={s.label}>
            <Card>
              <CardContent sx={{ p: 2 }}>
                <Typography variant="caption" color="text.secondary" sx={{ textTransform: 'uppercase', letterSpacing: '0.08em', fontSize: 10 }}>
                  {s.label}
                </Typography>
                <Typography variant="h5" fontWeight={700} color={s.color} sx={{ fontFamily: 'monospace', mt: 0.5 }}>
                  ₹ {INR(s.value)}
                </Typography>
              </CardContent>
            </Card>
          </Grid>
        ))}
      </Grid>

      <Grid container spacing={2}>
        {/* Chart */}
        <Grid item xs={12} md={7}>
          <Card>
            <CardContent>
              <Typography variant="subtitle1" fontWeight={700} gutterBottom>
                Revenue vs Expenses by Department
              </Typography>
              {chartData.length === 0 ? (
                <Box sx={{ py: 4, textAlign: 'center' }}>
                  <Typography color="text.secondary" variant="body2">
                    Post journal entries against cost centers to see profitability data here.
                  </Typography>
                </Box>
              ) : (
                <ResponsiveContainer width="100%" height={260}>
                  <BarChart data={chartData} layout="vertical">
                    <XAxis type="number" tick={{ fontSize: 11 }}
                      tickFormatter={(v) => `₹${(v / 1000).toFixed(0)}k`} />
                    <YAxis type="category" dataKey="name" tick={{ fontSize: 11 }} width={90} />
                    <Tooltip formatter={(v: any) => `₹ ${INR(Number(v))}`} />
                    <Bar dataKey="revenue" name="Revenue" fill="#1B5E20" radius={[0, 4, 4, 0]} />
                    <Bar dataKey="expenses" name="Expenses" fill="#B00020" radius={[0, 4, 4, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              )}
            </CardContent>
          </Card>
        </Grid>

        {/* Table */}
        <Grid item xs={12} md={5}>
          <Card>
            <CardContent sx={{ p: 0 }}>
              <Box sx={{ p: 2, borderBottom: 1, borderColor: 'divider' }}>
                <Typography variant="subtitle1" fontWeight={700}>Department Breakdown</Typography>
              </Box>
              {isLoading ? (
                <LinearProgress />
              ) : (
                <Table size="small">
                  <TableHead>
                    <TableRow>
                      <TableCell>Department</TableCell>
                      <TableCell align="right">Revenue</TableCell>
                      <TableCell align="right">Expenses</TableCell>
                      <TableCell align="right">Profit</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {(centers ?? []).map((cc: any) => {
                      const pnl = pnlMap.get(cc.id);
                      const profit = pnl ? pnl.profit : 0;
                      return (
                        <TableRow key={cc.id} hover>
                          <TableCell>
                            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                              <Box sx={{ width: 10, height: 10, borderRadius: '50%',
                                bgcolor: DEPT_COLORS[cc.department] ?? '#999', flexShrink: 0 }} />
                              <Box>
                                <Typography variant="body2" fontWeight={600} sx={{ fontSize: 12 }}>{cc.name}</Typography>
                                <Typography variant="caption" color="text.secondary">{cc.code}</Typography>
                              </Box>
                            </Box>
                          </TableCell>
                          <TableCell align="right" sx={{ fontFamily: 'monospace', fontSize: 12, color: '#1B5E20' }}>
                            {pnl ? `₹${INR(pnl.revenue)}` : '—'}
                          </TableCell>
                          <TableCell align="right" sx={{ fontFamily: 'monospace', fontSize: 12, color: '#B00020' }}>
                            {pnl ? `₹${INR(pnl.expenses)}` : '—'}
                          </TableCell>
                          <TableCell align="right" sx={{ fontFamily: 'monospace', fontSize: 12, fontWeight: 700,
                            color: profit >= 0 ? '#1B5E20' : '#B00020' }}>
                            {pnl ? `₹${INR(profit)}` : '—'}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </Grid>
      </Grid>
    </Box>
  );
}
