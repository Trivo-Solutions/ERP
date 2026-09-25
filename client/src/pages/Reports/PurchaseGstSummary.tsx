import { useState } from 'react';
import { Box, Card, Table, TableHead, TableBody, TableRow, TableCell, Typography, Divider, Grid, TextField, Alert, Tabs, Tab } from '@mui/material';
import { Download } from '@mui/icons-material';
import { useQuery } from '@tanstack/react-query';
import { apiGet } from '../../api/client';
import { PageHeader } from '../../components/common/PageHeader';
import { exportToCsv } from '../../utils/exportToCsv';

function money(n: number) {
  return '₹' + Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 });
}

const currentYear = new Date().getFullYear();

// Purchase-side GST — the input tax credit (ITC) you can claim against the GST collected on sales.
// Two views of the same numbers: HSN-wise (net of purchase returns), and bill-by-bill (one row per
// supplier invoice, with the supplier's GSTIN) for matching against your GSTR-2B. Prep aid, not a
// return: like the sales GST Summary, verify against the supplier bills before claiming anything.
export function PurchaseGstSummary() {
  const [from, setFrom] = useState(`${currentYear}-04-01`);
  const [to, setTo] = useState(new Date().toISOString().split('T')[0]);
  const [tab, setTab] = useState(0);

  const { data, isLoading } = useQuery({
    queryKey: ['purchase-gst-summary', from, to],
    queryFn: () => apiGet<any>('/finance/reports/purchase-gst-summary', { from, to }),
  });

  const rows: any[] = data?.rows ?? [];
  const bills: any[] = data?.bills ?? [];
  const totals = data?.totals ?? {};
  const pct = (r: number) => `${Number((r * 100).toFixed(2))}%`;

  return (
    <Box>
      <PageHeader title="Purchase GST (Input Tax Credit)" subtitle="GST paid to suppliers on stock received — the credit you can set off against GST collected"
        breadcrumbs={[{ label: 'Reports', path: '/reports/purchase-gst-summary' }, { label: 'Purchase GST' }]}
        actions={rows.length > 0 ? [{
          label: 'Export CSV', icon: <Download />,
          onClick: () => tab === 0
            ? exportToCsv('purchase-gst-hsn', [
                { header: 'HSN Code', value: (r: any) => r.hsnCode },
                { header: 'Description', value: (r: any) => r.description ?? '' },
                { header: 'Rate', value: (r: any) => pct(r.taxRate) },
                { header: 'Taxable Value', value: (r: any) => r.taxableValue },
                { header: 'CGST', value: (r: any) => r.cgst },
                { header: 'SGST', value: (r: any) => r.sgst },
                { header: 'IGST', value: (r: any) => r.igst },
              ], rows)
            : exportToCsv('purchase-gst-bills', [
                { header: 'Supplier', value: (b: any) => b.supplierName },
                { header: 'Supplier GSTIN', value: (b: any) => b.supplierGstin ?? '' },
                { header: 'Bill No.', value: (b: any) => b.invoiceNumber ?? '' },
                { header: 'Bill Date', value: (b: any) => b.invoiceDate ? new Date(b.invoiceDate).toLocaleDateString('en-IN') : '' },
                { header: 'GRN', value: (b: any) => b.grnNumber },
                { header: 'Taxable Value', value: (b: any) => b.taxableValue },
                { header: 'CGST', value: (b: any) => b.cgst },
                { header: 'SGST', value: (b: any) => b.sgst },
                { header: 'IGST', value: (b: any) => b.igst },
              ], bills),
        }] : []} />

      <Alert severity="info" sx={{ mb: 2 }}>
        Prep aid, not a return. GST is booked when a received piece is tagged into stock, using the rate on the
        purchase order line; purchase returns reduce it. Match the bill-wise view against your GSTR-2B and
        verify with the supplier bills before claiming credit.
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

      <Tabs value={tab} onChange={(_, v) => setTab(v)} sx={{ mb: 2, borderBottom: 1, borderColor: 'divider' }}>
        <Tab label="HSN-wise (net of returns)" />
        <Tab label="Bill-wise" />
      </Tabs>

      <Card>
        <Box sx={{ overflowX: 'auto' }}>
          {tab === 0 ? (
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
                      <TableCell align="right">{pct(r.taxRate)}</TableCell>
                      <TableCell align="right" sx={{ fontFamily: 'monospace' }}>{money(r.taxableValue)}</TableCell>
                      <TableCell align="right" sx={{ fontFamily: 'monospace' }}>{r.cgst !== 0 ? money(r.cgst) : '—'}</TableCell>
                      <TableCell align="right" sx={{ fontFamily: 'monospace' }}>{r.sgst !== 0 ? money(r.sgst) : '—'}</TableCell>
                      <TableCell align="right" sx={{ fontFamily: 'monospace' }}>{r.igst !== 0 ? money(r.igst) : '—'}</TableCell>
                    </TableRow>
                  ))}
                {!isLoading && rows.length === 0 && (
                  <TableRow><TableCell colSpan={7} align="center" sx={{ py: 4 }}>No purchases with GST in this period</TableCell></TableRow>
                )}
              </TableBody>
            </Table>
          ) : (
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>Supplier</TableCell><TableCell>GSTIN</TableCell><TableCell>Bill No.</TableCell><TableCell>Bill Date</TableCell>
                  <TableCell>GRN</TableCell><TableCell align="right">Taxable Value</TableCell>
                  <TableCell align="right">CGST</TableCell><TableCell align="right">SGST</TableCell><TableCell align="right">IGST</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {isLoading ? <TableRow><TableCell colSpan={9} align="center" sx={{ py: 4 }}>Loading...</TableCell></TableRow>
                  : bills.map((b) => (
                    <TableRow key={b.grnNumber} hover>
                      <TableCell>{b.supplierName}</TableCell>
                      <TableCell sx={{ fontFamily: 'monospace', fontSize: 12 }}>{b.supplierGstin ?? '—'}</TableCell>
                      <TableCell sx={{ fontFamily: 'monospace' }}>{b.invoiceNumber ?? '—'}</TableCell>
                      <TableCell>{b.invoiceDate ? new Date(b.invoiceDate).toLocaleDateString('en-IN') : '—'}</TableCell>
                      <TableCell sx={{ fontFamily: 'monospace', fontSize: 12 }}>{b.grnNumber}</TableCell>
                      <TableCell align="right" sx={{ fontFamily: 'monospace' }}>{money(b.taxableValue)}</TableCell>
                      <TableCell align="right" sx={{ fontFamily: 'monospace' }}>{b.cgst > 0 ? money(b.cgst) : '—'}</TableCell>
                      <TableCell align="right" sx={{ fontFamily: 'monospace' }}>{b.sgst > 0 ? money(b.sgst) : '—'}</TableCell>
                      <TableCell align="right" sx={{ fontFamily: 'monospace' }}>{b.igst > 0 ? money(b.igst) : '—'}</TableCell>
                    </TableRow>
                  ))}
                {!isLoading && bills.length === 0 && (
                  <TableRow><TableCell colSpan={9} align="center" sx={{ py: 4 }}>No supplier bills in this period</TableCell></TableRow>
                )}
              </TableBody>
            </Table>
          )}
        </Box>
        <Divider />
        <Box sx={{ p: 1.5, display: 'flex', justifyContent: 'flex-end', gap: 3, bgcolor: '#EEF1FA', flexWrap: 'wrap' }}>
          <Typography sx={{ fontFamily: 'monospace' }}>Taxable: {money(totals.taxableValue ?? 0)}</Typography>
          <Typography sx={{ fontFamily: 'monospace' }}>CGST: {money(totals.cgst ?? 0)}</Typography>
          <Typography sx={{ fontFamily: 'monospace' }}>SGST: {money(totals.sgst ?? 0)}</Typography>
          <Typography sx={{ fontFamily: 'monospace' }}>IGST: {money(totals.igst ?? 0)}</Typography>
          <Typography fontWeight={700} sx={{ fontFamily: 'monospace' }}>Net ITC: {money(totals.totalTax ?? 0)}</Typography>
        </Box>
      </Card>
    </Box>
  );
}
