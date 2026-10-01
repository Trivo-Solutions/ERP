import { useState, useMemo } from 'react';
import {
  Box, Card, Table, TableHead, TableBody, TableRow, TableCell, Typography, Divider,
  Grid, TextField, MenuItem, Alert,
} from '@mui/material';
import { Download } from '@mui/icons-material';
import { useQuery } from '@tanstack/react-query';
import { apiGet } from '../../api/client';
import { PageHeader, PageActions } from '../../components/common/PageHeader';
import { exportToCsv } from '../../utils/exportToCsv';
import { defaultGstFrom, defaultGstTo } from '../../utils/date';
import { useAuthStore } from '../../store/auth.store';

function money(n: number) {
  return '₹' + Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 });
}

function formatRegistrationLabel(r: any): string {
  const gstin = r.gstin || '';
  const legal = r.legalName || '';
  const trade = r.tradeName && r.tradeName !== legal ? r.tradeName : '';
  if (trade) {
    return `${gstin} — ${legal} (${trade})`;
  }
  return legal ? `${gstin} — ${legal}` : gstin;
}

// H5: GST HSN-wise summary for a period — the table a GSTR-1 filing needs assembled from. Prep
// aid, not a submission-ready export (per-line tax is approximated, see the server-side note on
// getGstSummary); the banner below says so explicitly rather than implying a finished filing.
export function GstSummary() {
  const user = useAuthStore((s) => s.user);
  const [from, setFrom] = useState(defaultGstFrom);
  const [to, setTo] = useState(defaultGstTo);
  const [branchId, setBranchId] = useState('');
  const [gstRegistrationId, setGstRegistrationId] = useState('');

  const { data: branchData } = useQuery({
    queryKey: ['branches'],
    queryFn: () => apiGet<any>('/tagging/branches'),
  });
  const allBranches: any[] = (branchData as any)?.data ?? branchData ?? [];

  const accessibleBranches = useMemo(() => {
    const active = allBranches.filter((b: any) => b.isActive !== false);
    if (!user?.branchAccess || user.branchAccess.allBranches) {
      return active;
    }
    const allowed = new Set(user.branchAccess.branchIds ?? []);
    return active.filter((b: any) => allowed.has(b.id));
  }, [allBranches, user?.branchAccess]);

  const { data: regData } = useQuery({
    queryKey: ['gst-registrations'],
    queryFn: () => apiGet<any>('/company/gst-registrations'),
  });
  const allRegistrations: any[] = (regData as any)?.data ?? regData ?? [];

  const activeRegistrations = useMemo(() => {
    return allRegistrations.filter((r: any) => r.isActive !== false);
  }, [allRegistrations]);

  const { data, isLoading } = useQuery({
    queryKey: ['gst-summary', from, to, branchId, gstRegistrationId],
    queryFn: () => apiGet<any>('/finance/reports/gst-summary', {
      from,
      to,
      ...(branchId ? { branchId } : {}),
      ...(gstRegistrationId ? { gstRegistrationId } : {}),
    }),
  });

  const rows: any[] = data?.rows ?? [];
  const totals = data?.totals ?? {};

  return (
    <Box>
      <PageHeader title="GST Summary" />

      <Alert severity="info" sx={{ mb: 2 }}>
        Prep aid for return filing, not a submission-ready export — per-line tax is approximated
        from each line's own rate (invoice-level discounts and other charges aren't split back to
        individual HSN lines). Verify against the invoice totals before filing.
      </Alert>

      <Card sx={{ p: 2, mb: 2 }}>
        <Grid container spacing={2} alignItems="center">
          <Grid item xs={6} sm={3} md={2}>
            <TextField fullWidth size="small" label="From" type="date" value={from}
              onChange={(e) => setFrom(e.target.value)} InputLabelProps={{ shrink: true }} />
          </Grid>
          <Grid item xs={6} sm={3} md={2}>
            <TextField fullWidth size="small" label="To" type="date" value={to}
              onChange={(e) => setTo(e.target.value)} InputLabelProps={{ shrink: true }} />
          </Grid>
          <Grid item xs={12} sm={6} md={3}>
            <TextField fullWidth size="small" select label="Branch" value={branchId}
              onChange={(e) => setBranchId(e.target.value)}
              SelectProps={{ native: true }} InputLabelProps={{ shrink: true }}>
              <option value="">All Branches</option>
              {accessibleBranches.map((b: any) => (
                <option key={b.id} value={b.id}>{b.name}</option>
              ))}
            </TextField>
          </Grid>
          <Grid item xs={12} sm={6} md={3.5}>
            <TextField fullWidth size="small" select label="GST Registration" value={gstRegistrationId}
              onChange={(e) => setGstRegistrationId(e.target.value)}
              SelectProps={{ native: true }} InputLabelProps={{ shrink: true }}>
              <option value="">All Registrations</option>
              {activeRegistrations.map((r: any) => (
                <option key={r.id} value={r.id}>{formatRegistrationLabel(r)}</option>
              ))}
            </TextField>
          </Grid>
          <Grid item sx={{ ml: 'auto', alignSelf: 'center' }}>
            <PageActions actions={rows.length > 0 ? [{
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
