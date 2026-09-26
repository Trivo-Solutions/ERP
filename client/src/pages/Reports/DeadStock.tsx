import { Box, Card, Table, TableHead, TableBody, TableRow, TableCell, Typography, Chip, Divider } from '@mui/material';
import { Download } from '@mui/icons-material';
import { useQuery } from '@tanstack/react-query';
import { apiGet } from '../../api/client';
import { PageHeader, PageActions } from '../../components/common/PageHeader';
import { exportToCsv } from '../../utils/exportToCsv';

function money(n: number) {
  return '₹' + Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 });
}

const BUCKET_COLOR: Record<string, 'success' | 'info' | 'warning' | 'error'> = {
  '0-90': 'success', '91-180': 'info', '181-365': 'warning', '365+': 'error',
};

// H3: how long an IN_STOCK piece has sat, anchored on updatedAt (proxy for "time in current
// status" — see the server-side note on getDeadStock for why createdAt would overstate age after
// a return-then-relist).
export function DeadStock() {
  const { data, isLoading } = useQuery({ queryKey: ['dead-stock'], queryFn: () => apiGet<any>('/tagging/reports/dead-stock') });

  const rows: any[] = data?.rows ?? [];
  const bucketTotals = data?.bucketTotals ?? {};
  const totals = data?.totals ?? {};

  return (
    <Box>
      <PageHeader title="Dead Stock / Ageing" />

      <Box sx={{ display: 'flex', gap: 1, mb: 2, flexWrap: 'wrap' }}>
        {['0-90', '91-180', '181-365', '365+'].map((b) => (
          <Chip key={b} label={`${b} days: ${money(bucketTotals[b] ?? 0)}`} color={BUCKET_COLOR[b]} variant="outlined" />
        ))}
        <Box sx={{ ml: 'auto' }}>
          <PageActions actions={rows.length > 0 ? [{
          label: 'Export CSV', icon: <Download />,
          onClick: () => exportToCsv('dead-stock', [
            { header: 'Tag #', value: (r: any) => r.tagNumber },
            { header: 'Name', value: (r: any) => r.name },
            { header: 'Branch', value: (r: any) => r.branchName },
            { header: 'Category', value: (r: any) => r.categoryName },
            { header: 'Days in Stock', value: (r: any) => r.daysInStock },
            { header: 'Bucket', value: (r: any) => r.bucket },
            { header: 'Cost Value', value: (r: any) => r.costValue },
            { header: 'Selling Value', value: (r: any) => r.sellingValue },
          ], rows),
        }] : []} />
        </Box>
      </Box>

      <Card>
        <Box sx={{ overflowX: 'auto' }}>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Tag #</TableCell><TableCell>Name</TableCell><TableCell>Branch</TableCell><TableCell>Category</TableCell>
                <TableCell align="right">Days in Stock</TableCell><TableCell>Bucket</TableCell>
                <TableCell align="right">Cost</TableCell><TableCell align="right">Selling</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {isLoading ? <TableRow><TableCell colSpan={8} align="center" sx={{ py: 4 }}>Loading...</TableCell></TableRow>
                : rows.map((r) => (
                  <TableRow key={r.id} hover>
                    <TableCell sx={{ fontFamily: 'monospace', fontWeight: 700, color: '#44C47A', fontSize: 12 }}>{r.tagNumber}</TableCell>
                    <TableCell>{r.name}</TableCell>
                    <TableCell sx={{ fontSize: 12 }}>{r.branchName}</TableCell>
                    <TableCell sx={{ fontSize: 12 }}>{r.categoryName}</TableCell>
                    <TableCell align="right" sx={{ fontFamily: 'monospace' }}>{r.daysInStock}</TableCell>
                    <TableCell><Chip label={r.bucket} size="small" color={BUCKET_COLOR[r.bucket]} /></TableCell>
                    <TableCell align="right" sx={{ fontFamily: 'monospace' }}>{money(r.costValue)}</TableCell>
                    <TableCell align="right" sx={{ fontFamily: 'monospace' }}>{money(r.sellingValue)}</TableCell>
                  </TableRow>
                ))}
              {!isLoading && rows.length === 0 && (
                <TableRow><TableCell colSpan={8} align="center" sx={{ py: 4 }}>No stock on hand</TableCell></TableRow>
              )}
            </TableBody>
          </Table>
        </Box>
        <Divider />
        <Box sx={{ p: 1.5, display: 'flex', justifyContent: 'flex-end', gap: 3, bgcolor: '#EEF1FA' }}>
          <Typography sx={{ fontFamily: 'monospace' }}>Pieces: {totals.count ?? 0}</Typography>
          <Typography fontWeight={700} sx={{ fontFamily: 'monospace' }}>Cost Value: {money(totals.costValue ?? 0)}</Typography>
        </Box>
      </Card>
    </Box>
  );
}
