import { useState } from 'react';
import {
  Box, Card, CardContent, Grid, Table, TableHead, TableBody, TableRow, TableCell,
  Typography, Chip, LinearProgress, Alert,
} from '@mui/material';
import { useQuery } from '@tanstack/react-query';
import { apiGet } from '../../api/client';
import { PageHeader } from '../../components/common/PageHeader';
import { KpiCard } from '../../components/common/KpiCard';
import { AccountBalance, Warning } from '@mui/icons-material';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell } from 'recharts';

const INR = (v: number) =>
  v.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const BUCKET_COLOR: Record<string, string> = {
  '0-30':  '#1B5E20',
  '31-60': '#44C47A',
  '61-90': '#E65100',
  '90+':   '#B00020',
};

export function AgingReceivables() {
  const { data, isLoading } = useQuery({
    queryKey: ['aging-receivables'],
    queryFn: () => apiGet<any[]>('/reports/aging-receivables'),
    refetchInterval: 60_000,
  });

  const invoices = data ?? [];

  const byBucket = invoices.reduce((acc: Record<string, number>, inv: any) => {
    acc[inv.bucket] = (acc[inv.bucket] ?? 0) + Number(inv.balanceDue);
    return acc;
  }, {});

  const chartData = ['0-30', '31-60', '61-90', '90+'].map((b) => ({
    bucket: b,
    amount: byBucket[b] ?? 0,
  }));

  const totalOutstanding = invoices.reduce((s: number, i: any) => s + Number(i.balanceDue), 0);
  const overdue90        = byBucket['90+'] ?? 0;
  const overdue60        = (byBucket['61-90'] ?? 0) + overdue90;

  return (
    <Box>
      <PageHeader
        title="Aging Receivables"
      />

      {overdue90 > 0 && (
        <Alert severity="error" sx={{ mb: 2 }}>
          <strong>₹ {INR(overdue90)}</strong> is overdue by 90+ days. Immediate collections action required.
        </Alert>
      )}

      <Grid container spacing={2} sx={{ mb: 3 }}>
        <Grid item xs={6} sm={3}>
          <KpiCard title="Total Outstanding" value={`₹${(totalOutstanding / 100000).toFixed(2)}L`}
            icon={<AccountBalance />} color="#44C47A" subtitle="Across all unpaid invoices" />
        </Grid>
        <Grid item xs={6} sm={3}>
          <KpiCard title="Invoices Pending" value={invoices.length}
            icon={<AccountBalance />} color="#0277BD" />
        </Grid>
        <Grid item xs={6} sm={3}>
          <KpiCard title="Overdue > 60 days" value={`₹${(overdue60 / 100000).toFixed(2)}L`}
            icon={<Warning />} color={overdue60 > 0 ? '#E65100' : '#1B5E20'} />
        </Grid>
        <Grid item xs={6} sm={3}>
          <KpiCard title="Overdue > 90 days" value={`₹${(overdue90 / 100000).toFixed(2)}L`}
            icon={<Warning />} color={overdue90 > 0 ? '#B00020' : '#1B5E20'} />
        </Grid>
      </Grid>

      <Grid container spacing={2}>
        {/* Bucket chart */}
        <Grid item xs={12} md={5}>
          <Card>
            <CardContent>
              <Typography variant="subtitle1" fontWeight={700} gutterBottom>
                Outstanding by Aging Bucket
              </Typography>
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={chartData}>
                  <XAxis dataKey="bucket" tick={{ fontSize: 12 }} />
                  <YAxis tick={{ fontSize: 11 }} tickFormatter={(v) => `₹${(v / 100000).toFixed(1)}L`} />
                  <Tooltip formatter={(v: any) => `₹ ${INR(Number(v))}`} />
                  <Bar dataKey="amount" name="Outstanding" radius={[4, 4, 0, 0]}>
                    {chartData.map((entry) => (
                      <Cell key={entry.bucket} fill={BUCKET_COLOR[entry.bucket]} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
              <Grid container spacing={1} sx={{ mt: 1 }}>
                {['0-30', '31-60', '61-90', '90+'].map((b) => (
                  <Grid item xs={6} key={b}>
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                      <Box sx={{ width: 12, height: 12, borderRadius: 1, bgcolor: BUCKET_COLOR[b] }} />
                      <Typography variant="caption">{b} days: ₹ {INR(byBucket[b] ?? 0)}</Typography>
                    </Box>
                  </Grid>
                ))}
              </Grid>
            </CardContent>
          </Card>
        </Grid>

        {/* Invoice table */}
        <Grid item xs={12} md={7}>
          <Card>
            <Box sx={{ overflowX: 'auto' }}>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>Invoice #</TableCell>
                  <TableCell>Client</TableCell>
                  <TableCell align="right">Total</TableCell>
                  <TableCell align="right">Balance Due</TableCell>
                  <TableCell align="center">Days Overdue</TableCell>
                  <TableCell align="center">Bucket</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {isLoading ? (
                  <TableRow><TableCell colSpan={6} sx={{ py: 4 }}><LinearProgress /></TableCell></TableRow>
                ) : invoices.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={6} align="center" sx={{ py: 5 }}>
                      <Typography color="success.main" fontWeight={700}>
                        ✓ No outstanding receivables — all invoices paid!
                      </Typography>
                    </TableCell>
                  </TableRow>
                ) : invoices.map((inv: any) => (
                  <TableRow key={inv.invoiceNumber} hover
                    sx={{ bgcolor: inv.bucket === '90+' ? '#FFF5F5' : inv.bucket === '61-90' ? '#FFF8F0' : 'inherit' }}>
                    <TableCell sx={{ fontFamily: 'monospace', fontSize: 12, fontWeight: 700, color: '#44C47A' }}>
                      {inv.invoiceNumber}
                    </TableCell>
                    <TableCell sx={{ fontWeight: 600, fontSize: 13 }}>{inv.client}</TableCell>
                    <TableCell align="right" sx={{ fontFamily: 'monospace', fontSize: 12 }}>
                      ₹ {INR(Number(inv.totalAmount))}
                    </TableCell>
                    <TableCell align="right" sx={{ fontFamily: 'monospace', fontWeight: 700,
                      color: BUCKET_COLOR[inv.bucket] }}>
                      ₹ {INR(Number(inv.balanceDue))}
                    </TableCell>
                    <TableCell align="center">
                      <Chip
                        label={`${inv.daysDue} days`}
                        size="small"
                        sx={{ bgcolor: BUCKET_COLOR[inv.bucket], color: '#fff', fontWeight: 700, fontSize: 11 }}
                      />
                    </TableCell>
                    <TableCell align="center">
                      <Chip label={inv.bucket} size="small" variant="outlined"
                        sx={{ borderColor: BUCKET_COLOR[inv.bucket], color: BUCKET_COLOR[inv.bucket], fontWeight: 700 }} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            </Box>
            {!isLoading && invoices.length > 0 && (
              <Box sx={{ p: 1.5, borderTop: 1, borderColor: 'divider', display: 'flex', justifyContent: 'flex-end', gap: 3 }}>
                <Typography variant="caption" fontWeight={700} sx={{ fontFamily: 'monospace', color: '#B00020' }}>
                  Total Outstanding: ₹ {INR(totalOutstanding)}
                </Typography>
              </Box>
            )}
          </Card>
        </Grid>
      </Grid>
    </Box>
  );
}
