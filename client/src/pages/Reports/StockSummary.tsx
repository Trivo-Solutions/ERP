import { Box, Grid, Card, CardContent, Typography, Table, TableHead, TableBody, TableRow, TableCell, Chip, Alert } from '@mui/material';
import { useQuery } from '@tanstack/react-query';
import { PieChart, Pie, Cell, Tooltip, Legend, ResponsiveContainer } from 'recharts';
import { apiGet } from '../../api/client';
import { PageHeader } from '../../components/common/PageHeader';

const COLORS = ['#44C47A', '#009688', '#B00020', '#0277BD', '#1B5E20', '#7B1FA2'];

export function StockSummary() {
  const { data, isLoading } = useQuery({ queryKey: ['stock-summary'], queryFn: () => apiGet<any>('/reports/stock-summary') });
  const stock = data ?? {};

  const metalData = (stock.metalByKarat ?? []).map((m: any) => ({
    name: m.karat, value: Number(m._sum?.availableWt ?? 0),
  }));

  return (
    <Box>
      <PageHeader title="Stock Summary Report" subtitle="Real-time precious metal vault and stone inventory overview"
        breadcrumbs={[{ label: 'Reports', path: '/reports/wip' }, { label: 'Stock' }]} />

      {(stock.lowConsumables ?? []).length > 0 && (
        <Alert severity="warning" sx={{ mb: 2 }}>
          {stock.lowConsumables.length} consumable(s) below reorder level: {stock.lowConsumables.map((c: any) => c.name).join(', ')}
        </Alert>
      )}

      <Grid container spacing={2}>
        <Grid item xs={12} md={5}>
          <Card>
            <CardContent>
              <Typography variant="subtitle1" fontWeight={700} gutterBottom>Metal Stock by Karat (g)</Typography>
              <ResponsiveContainer width="100%" height={260}>
                <PieChart>
                  <Pie data={metalData} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={90} label={({ name, value }) => `${name}: ${value.toFixed(2)}g`}>
                    {metalData.map((_: any, idx: number) => <Cell key={idx} fill={COLORS[idx % COLORS.length]} />)}
                  </Pie>
                  <Tooltip formatter={(v: any) => `${Number(v).toFixed(4)} g`} />
                </PieChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>
        </Grid>
        <Grid item xs={12} md={7}>
          <Card>
            <CardContent>
              <Typography variant="subtitle1" fontWeight={700} gutterBottom>Stone Inventory by Type</Typography>
              <Table size="small">
                <TableHead><TableRow><TableCell>Stone Type</TableCell><TableCell>Status</TableCell><TableCell align="right">Available (cts)</TableCell><TableCell align="right">Lots</TableCell></TableRow></TableHead>
                <TableBody>
                  {(stock.stonesByType ?? []).map((s: any, i: number) => (
                    <TableRow key={i} hover>
                      <TableCell sx={{ fontWeight: 600 }}>{s.stoneType}</TableCell>
                      <TableCell><Chip label={s.status} size="small" color={s.status === 'AVAILABLE' ? 'success' : s.status === 'EXHAUSTED' ? 'error' : 'warning'} /></TableCell>
                      <TableCell align="right" sx={{ fontFamily: 'monospace', fontWeight: 700, color: '#44C47A' }}>{Number(s._sum?.availableCts ?? 0).toFixed(4)}</TableCell>
                      <TableCell align="right">{s._count}</TableCell>
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
