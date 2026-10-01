import { useState } from 'react';
import {
  Box, Card, Table, TableHead, TableBody, TableRow, TableCell, Typography, Chip, Divider,
  Grid, TextField, MenuItem,
} from '@mui/material';
import { Download } from '@mui/icons-material';
import { useQuery } from '@tanstack/react-query';
import { apiGet } from '../../api/client';
import { PageHeader, PageActions } from '../../components/common/PageHeader';
import { exportToCsv } from '../../utils/exportToCsv';
import { defaultGstFrom, defaultGstTo } from '../../utils/date';

function money(n: number) {
  return '₹' + Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 });
}

// H1: every invoice (retail + wholesale, together — invoiceType is just a label on the row) in a
// date range, filterable by salesperson. Branch filtering is approximate (SalesInvoice has no
// branchId — CLAUDE.md's B2 note); left out of this screen rather than shipping a filter whose
// results would be silently incomplete for free-text-only invoices.
export function SalesRegister() {
  const [from, setFrom] = useState(defaultGstFrom);
  const [to, setTo] = useState(defaultGstTo);
  const [salesPersonId, setSalesPersonId] = useState('');

  const { data: staff } = useQuery({ queryKey: ['staff'], queryFn: () => apiGet<any[]>('/sales/staff') });
  const { data, isLoading } = useQuery({
    queryKey: ['sales-register', from, to, salesPersonId],
    queryFn: () => apiGet<any>('/sales/reports/register', { from, to, ...(salesPersonId && { salesPersonId }) }),
  });

  const rows: any[] = data?.rows ?? [];
  const byType = data?.byType ?? {};
  const totals = data?.totals ?? {};

  return (
    <Box>
      <PageHeader title="Sales Register" />

      <Card sx={{ p: 2, mb: 2 }}>
        <Grid container spacing={2} alignItems="center">
          <Grid item xs={6} sm={3}>
            <TextField fullWidth size="small" label="From" type="date" value={from}
              onChange={(e) => setFrom(e.target.value)} InputLabelProps={{ shrink: true }} />
          </Grid>
          <Grid item xs={6} sm={3}>
            <TextField fullWidth size="small" label="To" type="date" value={to}
              onChange={(e) => setTo(e.target.value)} InputLabelProps={{ shrink: true }} />
          </Grid>
          <Grid item xs={12} sm={4}>
            <TextField fullWidth size="small" select label="Salesperson" value={salesPersonId}
              onChange={(e) => setSalesPersonId(e.target.value)}>
              <MenuItem value="">All</MenuItem>
              {(staff ?? []).map((s: any) => <MenuItem key={s.id} value={s.id}>{s.name}</MenuItem>)}
            </TextField>
          </Grid>
          <Grid item sx={{ ml: 'auto', alignSelf: 'center' }}>
            <PageActions actions={rows.length > 0 ? [{
          label: 'Export CSV', icon: <Download />,
          onClick: () => exportToCsv('sales-register', [
            { header: 'Invoice #', value: (r: any) => r.invoiceNumber },
            { header: 'Date', value: (r: any) => new Date(r.invoiceDate).toLocaleDateString('en-IN') },
            { header: 'Type', value: (r: any) => r.invoiceType },
            { header: 'Client', value: (r: any) => `${r.client.clientCode} — ${r.client.name}` },
            { header: 'Salesperson', value: (r: any) => r.salesPerson ?? '' },
            { header: 'Items', value: (r: any) => r.itemCount },
            { header: 'Subtotal', value: (r: any) => r.subtotal },
            { header: 'Tax', value: (r: any) => r.taxAmount },
            { header: 'Total', value: (r: any) => r.totalAmount },
            { header: 'Balance Due', value: (r: any) => r.balanceDue },
            { header: 'Status', value: (r: any) => r.status },
          ], rows),
        }] : []} />
          </Grid>
        </Grid>
      </Card>

      {Object.keys(byType).length > 0 && (
        <Box sx={{ display: 'flex', gap: 1, mb: 2, flexWrap: 'wrap' }}>
          {Object.entries(byType).map(([type, t]: any) => (
            <Chip key={type} label={`${type}: ${t.count} · ${money(t.totalAmount)}`} variant="outlined" />
          ))}
        </Box>
      )}

      <Card>
        <Box sx={{ overflowX: 'auto' }}>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Invoice #</TableCell><TableCell>Date</TableCell><TableCell>Type</TableCell>
                <TableCell>Client</TableCell><TableCell>Salesperson</TableCell>
                <TableCell align="right">Total</TableCell><TableCell align="right">Balance Due</TableCell>
                <TableCell>Status</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {isLoading ? <TableRow><TableCell colSpan={8} align="center" sx={{ py: 4 }}>Loading...</TableCell></TableRow>
                : rows.map((r) => (
                  <TableRow key={r.id} hover>
                    <TableCell sx={{ fontFamily: 'monospace', fontWeight: 700, color: '#44C47A', fontSize: 12 }}>{r.invoiceNumber}</TableCell>
                    <TableCell sx={{ fontSize: 12 }}>{new Date(r.invoiceDate).toLocaleDateString('en-IN')}</TableCell>
                    <TableCell><Chip label={r.invoiceType} size="small" /></TableCell>
                    <TableCell>{r.client.clientCode} — {r.client.name}</TableCell>
                    <TableCell sx={{ fontSize: 12 }}>{r.salesPerson ?? '—'}</TableCell>
                    <TableCell align="right" sx={{ fontFamily: 'monospace' }}>{money(r.totalAmount)}</TableCell>
                    <TableCell align="right" sx={{ fontFamily: 'monospace', color: r.balanceDue > 0 ? 'error.main' : undefined }}>{money(r.balanceDue)}</TableCell>
                    <TableCell><Chip label={r.status} size="small" variant="outlined" /></TableCell>
                  </TableRow>
                ))}
              {!isLoading && rows.length === 0 && (
                <TableRow><TableCell colSpan={8} align="center" sx={{ py: 4 }}>No invoices in this period</TableCell></TableRow>
              )}
            </TableBody>
          </Table>
        </Box>
        <Divider />
        <Box sx={{ p: 1.5, display: 'flex', justifyContent: 'flex-end', gap: 3, bgcolor: '#EEF1FA' }}>
          <Typography sx={{ fontFamily: 'monospace' }}>Invoices: {totals.count ?? 0}</Typography>
          <Typography fontWeight={700} sx={{ fontFamily: 'monospace' }}>Total: {money(totals.totalAmount ?? 0)}</Typography>
        </Box>
      </Card>
    </Box>
  );
}
