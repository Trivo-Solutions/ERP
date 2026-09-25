import { Box, Card, Table, TableHead, TableBody, TableRow, TableCell, Chip, Typography } from '@mui/material';
import { useQuery } from '@tanstack/react-query';
import { apiGet } from '../../api/client';
import { PageHeader } from '../../components/common/PageHeader';
import { StatusChip } from '../../components/common/StatusChip';

export function SubcontractorInvoices() {
  const { data, isLoading } = useQuery({ queryKey: ['subcon-invoices'], queryFn: () => apiGet<any[]>('/outsourcing/invoices') });
  return (
    <Box>
      <PageHeader title="Sub-Contractor Invoices" subtitle="Automated labor payout invoices with excess-loss deductions"
        breadcrumbs={[{ label: 'Outsourcing', path: '/outsourcing/ledger' }, { label: 'Invoices' }]} />
      <Card>
        <Box sx={{ overflowX: 'auto' }}>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>Invoice #</TableCell><TableCell>Artisan</TableCell><TableCell>Period</TableCell>
              <TableCell>Charge Type</TableCell><TableCell align="right">Gross (₹)</TableCell>
              <TableCell align="right">Deductions (₹)</TableCell><TableCell align="right">Net Payable (₹)</TableCell>
              <TableCell>Status</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {isLoading ? <TableRow><TableCell colSpan={8} align="center" sx={{ py: 4 }}>Loading...</TableCell></TableRow>
              : (data ?? []).map((inv: any) => (
                <TableRow key={inv.id} hover>
                  <TableCell sx={{ fontFamily: 'monospace', fontSize: 12, fontWeight: 700, color: '#44C47A' }}>{inv.invoiceNumber}</TableCell>
                  <TableCell>{inv.artisan?.name}</TableCell>
                  <TableCell sx={{ fontSize: 12 }}>{new Date(inv.periodFrom).toLocaleDateString('en-IN')} — {new Date(inv.periodTo).toLocaleDateString('en-IN')}</TableCell>
                  <TableCell><Chip label={inv.chargeType} size="small" /></TableCell>
                  <TableCell align="right" sx={{ fontFamily: 'monospace' }}>₹{Number(inv.grossAmount).toLocaleString('en-IN')}</TableCell>
                  <TableCell align="right" sx={{ fontFamily: 'monospace', color: Number(inv.deductions) > 0 ? 'error.main' : 'text.secondary' }}>₹{Number(inv.deductions).toLocaleString('en-IN')}</TableCell>
                  <TableCell align="right" sx={{ fontFamily: 'monospace', fontWeight: 700 }}>₹{Number(inv.netPayable).toLocaleString('en-IN')}</TableCell>
                  <TableCell><StatusChip status={inv.status} /></TableCell>
                </TableRow>
              ))}
          </TableBody>
        </Table>
        </Box>
      </Card>
    </Box>
  );
}
