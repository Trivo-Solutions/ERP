import { useState } from 'react';
import { Box, Card, Table, TableHead, TableBody, TableRow, TableCell, Typography, Divider, Grid, TextField, Alert } from '@mui/material';
import { Download } from '@mui/icons-material';
import { useQuery } from '@tanstack/react-query';
import { apiGet } from '../../api/client';
import { PageHeader } from '../../components/common/PageHeader';
import { exportToCsv } from '../../utils/exportToCsv';

function money(n: number) {
  return '₹' + Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 });
}

const currentYear = new Date().getFullYear();

// H5: GST HSN-wise summary for a period — the table a GSTR-1 filing needs assembled from. Prep
// aid, not a submission-ready export (per-line tax is approximated, see the server-side note on
// getGstSummary); the banner below says so explicitly rather than implying a finished filing.
export function GstSummary() {
  const [from, setFrom] = useState(`${currentYear}-04-01`);
  const [to, setTo] = useState(new Date().toISOString().split('T')[0]);

  const { data, isLoading } = useQuery({
    queryKey: ['gst-summary', from, to],
    queryFn: () => apiGet<any>('/finance/reports/gst-summary', { from, to }),
  });

  const rows: any[] = data?.rows ?? [];
  const totals = data?.totals ?? {};

  return (
    <Box>
      <PageHeader title="GST Summary" subtitle="HSN-wise taxable value and tax split, for return-filing prep"
        breadcrumbs={[{ label: 'Reports', path: '/reports/gst-summary' }, { label: 'GST Summary' }]}
        actions={rows.length > 0 ? [{
          label: 'Export CSV', icon: <Download />,
          onClick: () => exportToCsv('gst-summary', [
            { header: 'HSN Code', value: (r: any) => r.hsnCode },
            { header: 'Description', value: (r: any) => r.description ?? '' },
            { header: 'Rate', value: (r: any) => `${(r.taxRate * 100).toFixed(0)}%` },
            { header: 'Taxable Value', value: (r: any) => r.taxableValue },
            { header: 'CGST', value: (r: any) => r.cgst },
            { header: 'SGST', value: (r: any) => r.sgst },
            { header: 'IGST', value: (r: any) => r.igst },
          ], rows),
        }] : []} />

      <Alert severity="info" sx={{ mb: 2 }}>
        Prep aid for return filing, not a submission-ready export — per-line tax is approximated
        from each line's own rate (invoice-level discounts and other charges aren't split back to
        individual HSN lines). Verify against the invoice totals before filing.
      </Alert>

      <Card sx={{ p: 2, mb: 2 }}>
        <Grid container spacing={2}>
          <Grid item xs={6} sm={3}>
            <TextField fullWidth size="small" label="From" type="date" value={from}
              onChange={(e) => setFrom(e.target.value)} InputLabelProps={{ shrink: true }} />
          </Grid>
          <Grid item xs={6} sm={3}>
            <TextField fullWidth size="small" label="To" type="date" value={to}
              onChange={(e) => setTo(e.target.value)} InputLabelProps={{ shrink: true }} />
          </Grid>
        </Grid>
      </Card>

      <Card>
        <Box sx={{ overflowX: 'auto' }}>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>HSN Code</TableCell><TableCell>Description</TableCell><TableCell align="right">Rate</TableCell>
                <TableCell align="right">Taxable Value</TableCell>
                <TableCell align="right">CGST</TableCell><TableCell align="right">SGST</TableCell><TableCell align="right">IGST</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {isLoading ? <TableRow><TableCell colSpan={7} align="center" sx={{ py: 4 }}>Loading...</TableCell></TableRow>
                : rows.map((r) => (
                  <TableRow key={`${r.hsnCode}-${r.taxRate}`} hover>
                    <TableCell sx={{ fontFamily: 'monospace', fontWeight: 700 }}>{r.hsnCode}</TableCell>
                    <TableCell sx={{ fontSize: 12 }}>{r.description ?? '—'}</TableCell>
                    <TableCell align="right">{(r.taxRate * 100).toFixed(0)}%</TableCell>
                    <TableCell align="right" sx={{ fontFamily: 'monospace' }}>{money(r.taxableValue)}</TableCell>
                    <TableCell align="right" sx={{ fontFamily: 'monospace' }}>{r.cgst > 0 ? money(r.cgst) : '—'}</TableCell>
                    <TableCell align="right" sx={{ fontFamily: 'monospace' }}>{r.sgst > 0 ? money(r.sgst) : '—'}</TableCell>
                    <TableCell align="right" sx={{ fontFamily: 'monospace' }}>{r.igst > 0 ? money(r.igst) : '—'}</TableCell>
                  </TableRow>
                ))}
              {!isLoading && rows.length === 0 && (
                <TableRow><TableCell colSpan={7} align="center" sx={{ py: 4 }}>No taxable sales in this period</TableCell></TableRow>
              )}
            </TableBody>
          </Table>
        </Box>
        <Divider />
        <Box sx={{ p: 1.5, display: 'flex', justifyContent: 'flex-end', gap: 3, bgcolor: '#EEF1FA', flexWrap: 'wrap' }}>
          <Typography sx={{ fontFamily: 'monospace' }}>Taxable: {money(totals.taxableValue ?? 0)}</Typography>
          <Typography sx={{ fontFamily: 'monospace' }}>CGST: {money(totals.cgst ?? 0)}</Typography>
          <Typography sx={{ fontFamily: 'monospace' }}>SGST: {money(totals.sgst ?? 0)}</Typography>
          <Typography sx={{ fontFamily: 'monospace' }}>IGST: {money(totals.igst ?? 0)}</Typography>
          <Typography fontWeight={700} sx={{ fontFamily: 'monospace' }}>Total Tax: {money(totals.totalTax ?? 0)}</Typography>
        </Box>
      </Card>
    </Box>
  );
}
