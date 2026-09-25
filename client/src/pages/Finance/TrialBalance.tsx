import { Box, Card, Table, TableHead, TableBody, TableRow, TableCell, Typography, Divider } from '@mui/material';
import { useQuery } from '@tanstack/react-query';
import { apiGet } from '../../api/client';
import { PageHeader } from '../../components/common/PageHeader';

export function TrialBalance() {
  const { data, isLoading } = useQuery({ queryKey: ['trial-balance'], queryFn: () => apiGet<any[]>('/finance/reports/trial-balance') });

  const totalDr = (data ?? []).reduce((s, a) => s + Number(a.debit), 0);
  const totalCr = (data ?? []).reduce((s, a) => s + Number(a.credit), 0);
  const balanced = Math.abs(totalDr - totalCr) < 0.01;

  return (
    <Box>
      <PageHeader title="Trial Balance" subtitle="Real-time ledger balance verification"
        breadcrumbs={[{ label: 'Finance', path: '/finance/journals' }, { label: 'Trial Balance' }]} />

      {!isLoading && !balanced && (
        <Box sx={{ p: 2, bgcolor: 'error.light', borderRadius: 2, mb: 2 }}>
          <Typography fontWeight={700} color="error.dark">⚠ TRIAL BALANCE IS NOT BALANCED — Difference: ₹{Math.abs(totalDr - totalCr).toFixed(2)}</Typography>
        </Box>
      )}

      <Card>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>Code</TableCell><TableCell>Account Name</TableCell><TableCell>Type</TableCell>
              <TableCell align="right">Debit (₹)</TableCell><TableCell align="right">Credit (₹)</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {isLoading ? <TableRow><TableCell colSpan={5} align="center" sx={{ py: 4 }}>Loading...</TableCell></TableRow>
              : (data ?? []).filter((a) => a.debit > 0 || a.credit > 0).map((acc: any) => (
                <TableRow key={acc.id} hover>
                  <TableCell sx={{ fontFamily: 'monospace', fontWeight: 700, color: '#44C47A' }}>{acc.code}</TableCell>
                  <TableCell>{acc.name}</TableCell>
                  <TableCell sx={{ fontSize: 12 }}>{acc.type}</TableCell>
                  <TableCell align="right" sx={{ fontFamily: 'monospace', color: acc.debit > 0 ? 'text.primary' : 'text.disabled' }}>
                    {acc.debit > 0 ? `₹${acc.debit.toLocaleString('en-IN', { minimumFractionDigits: 2 })}` : '—'}
                  </TableCell>
                  <TableCell align="right" sx={{ fontFamily: 'monospace', color: acc.credit > 0 ? 'text.primary' : 'text.disabled' }}>
                    {acc.credit > 0 ? `₹${acc.credit.toLocaleString('en-IN', { minimumFractionDigits: 2 })}` : '—'}
                  </TableCell>
                </TableRow>
              ))}
          </TableBody>
        </Table>
        <Divider />
        <Box sx={{ p: 1.5, display: 'flex', justifyContent: 'flex-end', gap: 4, bgcolor: '#EEF1FA' }}>
          <Typography fontWeight={700} sx={{ fontFamily: 'monospace' }}>Total Dr: ₹{totalDr.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</Typography>
          <Typography fontWeight={700} sx={{ fontFamily: 'monospace' }}>Total Cr: ₹{totalCr.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</Typography>
          <Typography fontWeight={700} color={balanced ? 'success.main' : 'error.main'}>{balanced ? '✓ Balanced' : '✗ Not Balanced'}</Typography>
        </Box>
      </Card>
    </Box>
  );
}
