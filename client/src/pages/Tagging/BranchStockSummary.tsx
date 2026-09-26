import { Box, Card, Table, TableHead, TableBody, TableRow, TableCell, Typography, Chip } from '@mui/material';
import { useQuery } from '@tanstack/react-query';
import { apiGet } from '../../api/client';
import { PageHeader } from '../../components/common/PageHeader';

function fmt(n: number) {
  return '₹' + Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 });
}

// E2: inter-branch stock visibility — one screen for the whole network, instead of switching the
// branch filter on Tags & Inventory one at a time. Scoped to "stock" in the literal sense (where
// inventory is sitting right now) — SOLD/RETIRED are closed history, not shown here.
export function BranchStockSummary() {
  const { data, isLoading } = useQuery({
    queryKey: ['branch-stock-summary'],
    queryFn: () => apiGet<any[]>('/tagging/branches/stock-summary'),
  });
  const branches: any[] = data ?? [];

  const totals = branches.reduce((acc, b) => ({
    count: acc.count + b.inStock.count,
    sellingValue: acc.sellingValue + b.inStock.sellingValue,
    costValue: acc.costValue + b.inStock.costValue,
    grossWeight: acc.grossWeight + b.inStock.grossWeight,
  }), { count: 0, sellingValue: 0, costValue: 0, grossWeight: 0 });

  return (
    <Box>
      <PageHeader title="Branch Stock Summary" />

      <Card sx={{ mb: 2, p: 2 }}>
        <Typography variant="caption" color="text.secondary">Network Total (IN_STOCK)</Typography>
        <Typography variant="h5" fontWeight={900} color="primary.main">
          {totals.count} piece{totals.count !== 1 ? 's' : ''} · {fmt(totals.sellingValue)} · {totals.grossWeight.toFixed(3)} g
        </Typography>
      </Card>

      <Card>
        <Box sx={{ overflowX: 'auto' }}>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Branch</TableCell>
                <TableCell align="right">IN_STOCK Pieces</TableCell>
                <TableCell align="right">IN_STOCK Value</TableCell>
                <TableCell align="right">IN_STOCK Cost</TableCell>
                <TableCell align="right">Gross Wt (g)</TableCell>
                <TableCell align="right">On Approval</TableCell>
                <TableCell align="right">In Transit</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {isLoading ? (
                <TableRow><TableCell colSpan={7} align="center" sx={{ py: 4 }}>Loading...</TableCell></TableRow>
              ) : branches.map((b: any) => (
                <TableRow key={b.branchId} hover>
                  <TableCell sx={{ fontWeight: 700 }}>
                    {b.branchName}
                    <Typography variant="caption" sx={{ ml: 0.75, fontFamily: 'monospace', color: '#44C47A' }}>
                      {b.branchCode}
                    </Typography>
                  </TableCell>
                  <TableCell align="right" sx={{ fontFamily: 'monospace', fontWeight: 700 }}>{b.inStock.count}</TableCell>
                  <TableCell align="right" sx={{ fontFamily: 'monospace', fontWeight: 700, color: 'primary.main' }}>
                    {fmt(b.inStock.sellingValue)}
                  </TableCell>
                  <TableCell align="right" sx={{ fontFamily: 'monospace' }}>{fmt(b.inStock.costValue)}</TableCell>
                  <TableCell align="right" sx={{ fontFamily: 'monospace' }}>{Number(b.inStock.grossWeight).toFixed(3)}</TableCell>
                  <TableCell align="right">
                    {b.onApprovalCount > 0 ? <Chip label={b.onApprovalCount} size="small" color="info" /> : '—'}
                  </TableCell>
                  <TableCell align="right">
                    {b.inTransitCount > 0 ? <Chip label={b.inTransitCount} size="small" color="warning" /> : '—'}
                  </TableCell>
                </TableRow>
              ))}
              {!isLoading && branches.length === 0 && (
                <TableRow><TableCell colSpan={7} align="center" sx={{ py: 4 }}>No branches yet</TableCell></TableRow>
              )}
            </TableBody>
          </Table>
        </Box>
      </Card>
    </Box>
  );
}
