import { Box, Card, Table, TableHead, TableBody, TableRow, TableCell, Typography, Chip, Divider } from '@mui/material';
import { useQuery } from '@tanstack/react-query';
import { apiGet } from '../../api/client';
import { PageHeader } from '../../components/common/PageHeader';

function money(n: number) {
  return '₹' + Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 });
}

// F3: every client with an outstanding balance (SalesInvoice.balanceDue > 0), bucketed by how
// overdue it is, plus a flag for anyone currently over their own Client.creditLimit — the audit
// view for the credit-limit guard createInvoice/convertMemoToInvoice enforce at sale time.
export function DealerAging() {
  const { data, isLoading } = useQuery({ queryKey: ['dealer-aging'], queryFn: () => apiGet<any>('/finance/reports/dealer-aging') });
  const rows: any[] = data?.rows ?? [];
  const totals = data?.totals ?? {};

  return (
    <Box>
      <PageHeader title="Dealer Aging" subtitle="Outstanding balances by age, and who's over their credit limit"
        breadcrumbs={[{ label: 'Finance', path: '/finance/journals' }, { label: 'Dealer Aging' }]} />

      <Card>
        <Box sx={{ overflowX: 'auto' }}>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Client</TableCell>
                <TableCell>Type</TableCell>
                <TableCell align="right">0–30 days</TableCell>
                <TableCell align="right">31–60 days</TableCell>
                <TableCell align="right">61–90 days</TableCell>
                <TableCell align="right">90+ days</TableCell>
                <TableCell align="right">Total Outstanding</TableCell>
                <TableCell align="right">Credit Limit</TableCell>
                <TableCell>Status</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {isLoading ? <TableRow><TableCell colSpan={9} align="center" sx={{ py: 4 }}>Loading...</TableCell></TableRow>
                : rows.map((r) => (
                  <TableRow key={r.clientId} hover sx={r.overLimit ? { bgcolor: 'error.light' } : undefined}>
                    <TableCell sx={{ fontWeight: 600 }}>{r.clientCode} — {r.name}</TableCell>
                    <TableCell><Chip label={r.type} size="small" /></TableCell>
                    <TableCell align="right" sx={{ fontFamily: 'monospace' }}>{r.bucket0to30 > 0 ? money(r.bucket0to30) : '—'}</TableCell>
                    <TableCell align="right" sx={{ fontFamily: 'monospace' }}>{r.bucket31to60 > 0 ? money(r.bucket31to60) : '—'}</TableCell>
                    <TableCell align="right" sx={{ fontFamily: 'monospace' }}>{r.bucket61to90 > 0 ? money(r.bucket61to90) : '—'}</TableCell>
                    <TableCell align="right" sx={{ fontFamily: 'monospace', color: r.bucket90plus > 0 ? 'error.main' : undefined }}>
                      {r.bucket90plus > 0 ? money(r.bucket90plus) : '—'}
                    </TableCell>
                    <TableCell align="right" sx={{ fontFamily: 'monospace', fontWeight: 700 }}>{money(r.total)}</TableCell>
                    <TableCell align="right" sx={{ fontFamily: 'monospace' }}>{r.creditLimit != null ? money(r.creditLimit) : '—'}</TableCell>
                    <TableCell>{r.overLimit && <Chip label="Over Limit" size="small" color="error" />}</TableCell>
                  </TableRow>
                ))}
              {!isLoading && rows.length === 0 && (
                <TableRow><TableCell colSpan={9} align="center" sx={{ py: 4 }}>No outstanding balances</TableCell></TableRow>
              )}
            </TableBody>
          </Table>
        </Box>
        <Divider />
        <Box sx={{ p: 1.5, display: 'flex', justifyContent: 'flex-end', gap: 3, bgcolor: '#EEF1FA', flexWrap: 'wrap' }}>
          <Typography sx={{ fontFamily: 'monospace' }}>0–30: {money(totals.bucket0to30 ?? 0)}</Typography>
          <Typography sx={{ fontFamily: 'monospace' }}>31–60: {money(totals.bucket31to60 ?? 0)}</Typography>
          <Typography sx={{ fontFamily: 'monospace' }}>61–90: {money(totals.bucket61to90 ?? 0)}</Typography>
          <Typography sx={{ fontFamily: 'monospace' }}>90+: {money(totals.bucket90plus ?? 0)}</Typography>
          <Typography fontWeight={700} sx={{ fontFamily: 'monospace' }}>Total: {money(totals.total ?? 0)}</Typography>
        </Box>
      </Card>
    </Box>
  );
}
