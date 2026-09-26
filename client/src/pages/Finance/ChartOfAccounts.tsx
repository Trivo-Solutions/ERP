import { Box, Card, Table, TableHead, TableBody, TableRow, TableCell, Chip, Typography } from '@mui/material';
import { useQuery } from '@tanstack/react-query';
import { apiGet } from '../../api/client';
import { PageHeader } from '../../components/common/PageHeader';

const TYPE_COLOR: Record<string, any> = { ASSET: 'info', LIABILITY: 'warning', EQUITY: 'secondary', REVENUE: 'success', EXPENSE: 'error' };

export function ChartOfAccounts() {
  const { data, isLoading } = useQuery({ queryKey: ['accounts'], queryFn: () => apiGet<any[]>('/finance/accounts') });
  return (
    <Box>
      <PageHeader title="Chart of Accounts" />
      <Card>
        <Box sx={{ overflowX: 'auto' }}>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>Code</TableCell><TableCell>Account Name</TableCell><TableCell>Type</TableCell>
              <TableCell>Sub-Type</TableCell><TableCell align="right">Balance (₹)</TableCell>
              <TableCell>System</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {isLoading ? <TableRow><TableCell colSpan={6} align="center" sx={{ py: 4 }}>Loading...</TableCell></TableRow>
              : (data ?? []).map((acc: any) => (
                <TableRow key={acc.id} hover>
                  <TableCell sx={{ fontFamily: 'monospace', fontWeight: 700, color: '#44C47A' }}>{acc.code}</TableCell>
                  <TableCell sx={{ fontWeight: acc.isSystem ? 700 : 400 }}>{acc.name}</TableCell>
                  <TableCell><Chip label={acc.type} size="small" color={TYPE_COLOR[acc.type] ?? 'default'} /></TableCell>
                  <TableCell sx={{ fontSize: 12 }}>{acc.subType ?? '—'}</TableCell>
                  <TableCell align="right" sx={{ fontFamily: 'monospace', color: Number(acc.balance) < 0 ? 'error.main' : 'inherit' }}>₹{Number(acc.balance).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</TableCell>
                  <TableCell>{acc.isSystem && <Chip label="System" size="small" variant="outlined" />}</TableCell>
                </TableRow>
              ))}
          </TableBody>
        </Table>
        </Box>
      </Card>
    </Box>
  );
}
