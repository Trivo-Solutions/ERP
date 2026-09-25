import { useState } from 'react';
import { Box, Card, CardContent, Grid, Typography, Divider, TextField, Button, Table, TableHead, TableBody, TableRow, TableCell } from '@mui/material';
import { useQuery } from '@tanstack/react-query';
import { apiGet } from '../../api/client';
import { PageHeader } from '../../components/common/PageHeader';

export function PnLStatement() {
  const currentYear = new Date().getFullYear();
  const [from, setFrom] = useState(`${currentYear}-04-01`);
  const [to, setTo] = useState(new Date().toISOString().split('T')[0]);

  const { data, isLoading, refetch } = useQuery({
    queryKey: ['pnl', from, to],
    queryFn: () => apiGet<any>('/finance/reports/pnl', { from, to }),
  });

  const pnl = data ?? {};

  return (
    <Box>
      <PageHeader title="Profit & Loss Statement" subtitle="Real-time P&L from integrated double-entry ledger"
        breadcrumbs={[{ label: 'Finance', path: '/finance/journals' }, { label: 'P&L' }]} />

      <Card sx={{ mb: 2, p: 1.5 }}>
        <Grid container spacing={2} alignItems="center">
          <Grid item xs={3}><TextField fullWidth size="small" label="From Date" type="date" InputLabelProps={{ shrink: true }} value={from} onChange={(e) => setFrom(e.target.value)} /></Grid>
          <Grid item xs={3}><TextField fullWidth size="small" label="To Date" type="date" InputLabelProps={{ shrink: true }} value={to} onChange={(e) => setTo(e.target.value)} /></Grid>
          <Grid item><Button variant="outlined" onClick={() => refetch()}>Generate</Button></Grid>
        </Grid>
      </Card>

      <Grid container spacing={2}>
        <Grid item xs={12} md={6}>
          <Card>
            <CardContent>
              <Typography variant="subtitle1" fontWeight={700} color="success.main" gutterBottom>Revenue</Typography>
              <Table size="small">
                <TableBody>
                  {Object.entries(pnl.revenue ?? {}).map(([name, amount]: any) => (
                    <TableRow key={name}><TableCell>{name}</TableCell><TableCell align="right" sx={{ fontFamily: 'monospace', fontWeight: 600 }}>₹{Number(amount).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</TableCell></TableRow>
                  ))}
                </TableBody>
              </Table>
              <Divider sx={{ my: 1 }} />
              <Box sx={{ display: 'flex', justifyContent: 'space-between' }}>
                <Typography fontWeight={700}>Total Revenue</Typography>
                <Typography fontWeight={700} color="success.main" sx={{ fontFamily: 'monospace' }}>₹{Number(pnl.totalRevenue ?? 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</Typography>
              </Box>
            </CardContent>
          </Card>
        </Grid>
        <Grid item xs={12} md={6}>
          <Card>
            <CardContent>
              <Typography variant="subtitle1" fontWeight={700} color="error.main" gutterBottom>Expenses</Typography>
              <Table size="small">
                <TableBody>
                  {Object.entries(pnl.expenses ?? {}).map(([name, amount]: any) => (
                    <TableRow key={name}><TableCell>{name}</TableCell><TableCell align="right" sx={{ fontFamily: 'monospace', fontWeight: 600 }}>₹{Number(amount).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</TableCell></TableRow>
                  ))}
                </TableBody>
              </Table>
              <Divider sx={{ my: 1 }} />
              <Box sx={{ display: 'flex', justifyContent: 'space-between' }}>
                <Typography fontWeight={700}>Total Expenses</Typography>
                <Typography fontWeight={700} color="error.main" sx={{ fontFamily: 'monospace' }}>₹{Number(pnl.totalExpenses ?? 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</Typography>
              </Box>
            </CardContent>
          </Card>
        </Grid>

        <Grid item xs={12}>
          <Card sx={{ bgcolor: pnl.netProfit >= 0 ? '#E8F5E9' : '#FFEBEE' }}>
            <CardContent sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <Typography variant="h6" fontWeight={700}>Net {pnl.netProfit >= 0 ? 'Profit' : 'Loss'}</Typography>
              <Typography variant="h5" fontWeight={800} color={pnl.netProfit >= 0 ? 'success.main' : 'error.main'} sx={{ fontFamily: 'monospace' }}>
                ₹{Math.abs(Number(pnl.netProfit ?? 0)).toLocaleString('en-IN', { minimumFractionDigits: 2 })}
              </Typography>
            </CardContent>
          </Card>
        </Grid>
      </Grid>
    </Box>
  );
}
