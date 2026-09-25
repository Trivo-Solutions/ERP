import { Box, Card, Table, TableHead, TableBody, TableRow, TableCell, Chip, LinearProgress, Typography } from '@mui/material';
import { useQuery } from '@tanstack/react-query';
import { apiGet } from '../../api/client';
import { PageHeader } from '../../components/common/PageHeader';

export function Consumables() {
  const { data, isLoading } = useQuery({ queryKey: ['consumables'], queryFn: () => apiGet<any[]>('/inventory/consumables') });
  return (
    <Box>
      <PageHeader title="Consumables & Tool Auditing" subtitle="Factory inputs: casting powder, rhodium, rubber molds, fluxes, burs"
        breadcrumbs={[{ label: 'Inventory', path: '/inventory/metals' }, { label: 'Consumables' }]} />
      <Card>
        <Box sx={{ overflowX: 'auto' }}>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>Code</TableCell><TableCell>Name</TableCell><TableCell>Category</TableCell>
              <TableCell align="right">Current Qty</TableCell><TableCell align="right">Reorder Level</TableCell>
              <TableCell>Unit</TableCell><TableCell>Stock Level</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {isLoading ? <TableRow><TableCell colSpan={7} align="center" sx={{ py: 4 }}>Loading...</TableCell></TableRow>
              : (data ?? []).map((item: any) => {
                const pct = Math.min(100, (Number(item.currentQty) / Number(item.reorderLevel)) * 100);
                const low = Number(item.currentQty) <= Number(item.reorderLevel);
                return (
                  <TableRow key={item.id} hover sx={{ bgcolor: low ? '#FFF3F3' : 'inherit' }}>
                    <TableCell sx={{ fontFamily: 'monospace', fontSize: 12, fontWeight: 700 }}>{item.itemCode}</TableCell>
                    <TableCell sx={{ fontWeight: 600 }}>{item.name}</TableCell>
                    <TableCell><Chip label={item.category} size="small" /></TableCell>
                    <TableCell align="right" sx={{ fontFamily: 'monospace', color: low ? 'error.main' : 'inherit', fontWeight: low ? 700 : 400 }}>{Number(item.currentQty).toFixed(2)}</TableCell>
                    <TableCell align="right" sx={{ fontFamily: 'monospace' }}>{Number(item.reorderLevel).toFixed(2)}</TableCell>
                    <TableCell>{item.unit}</TableCell>
                    <TableCell sx={{ width: 120 }}>
                      <LinearProgress variant="determinate" value={pct} color={low ? 'error' : pct < 50 ? 'warning' : 'success'} sx={{ height: 6, borderRadius: 3 }} />
                      <Typography variant="caption" color={low ? 'error' : 'text.secondary'}>{low ? '⚠ REORDER' : `${pct.toFixed(0)}%`}</Typography>
                    </TableCell>
                  </TableRow>
                );
              })}
          </TableBody>
        </Table>
        </Box>
      </Card>
    </Box>
  );
}
