import { useState } from 'react';
import {
  Box, Card, Table, TableHead, TableBody, TableRow, TableCell, Typography, Divider,
  Grid, TextField, MenuItem,
} from '@mui/material';
import { Download } from '@mui/icons-material';
import { useQuery } from '@tanstack/react-query';
import { apiGet } from '../../api/client';
import { PageHeader, PageActions } from '../../components/common/PageHeader';
import { exportToCsv } from '../../utils/exportToCsv';

function money(n: number) {
  return '₹' + Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 });
}

// H2: IN_STOCK tags sliced by branch x category — "what could I sell right now," not a network
// visibility screen (that's E2's Branch Stock Summary, which also counts ON_APPROVAL/TRANSFERRED).
export function StockOnHand() {
  const [branchId, setBranchId] = useState('');
  const [categoryId, setCategoryId] = useState('');

  const { data: branches } = useQuery({ queryKey: ['branches'], queryFn: () => apiGet<any[]>('/tagging/branches') });
  const { data: categories } = useQuery({ queryKey: ['categories'], queryFn: () => apiGet<any[]>('/masters/categories') });
  const { data, isLoading } = useQuery({
    queryKey: ['stock-on-hand', branchId, categoryId],
    queryFn: () => apiGet<any>('/tagging/reports/stock-on-hand', { ...(branchId && { branchId }), ...(categoryId && { categoryId }) }),
  });

  const rows: any[] = data?.rows ?? [];
  const totals = data?.totals ?? {};

  return (
    <Box>
      <PageHeader title="Stock on Hand" />

      <Card sx={{ p: 2, mb: 2 }}>
        <Grid container spacing={2}>
          <Grid item xs={5}>
            <TextField fullWidth size="small" select label="Branch" value={branchId} onChange={(e) => setBranchId(e.target.value)}>
              <MenuItem value="">All Branches</MenuItem>
              {(branches ?? []).map((b: any) => <MenuItem key={b.id} value={b.id}>{b.name}</MenuItem>)}
            </TextField>
          </Grid>
          <Grid item xs={5}>
            <TextField fullWidth size="small" select label="Category" value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
              <MenuItem value="">All Categories</MenuItem>
              {(categories ?? []).map((c: any) => <MenuItem key={c.id} value={c.id}>{c.name}</MenuItem>)}
            </TextField>
          </Grid>
          <Grid item sx={{ ml: 'auto', alignSelf: 'center' }}>
            <PageActions actions={rows.length > 0 ? [{
          label: 'Export CSV', icon: <Download />,
          onClick: () => exportToCsv('stock-on-hand', [
            { header: 'Branch', value: (r: any) => r.branchName },
            { header: 'Category', value: (r: any) => r.categoryName },
            { header: 'Count', value: (r: any) => r.count },
            { header: 'Gross Weight (g)', value: (r: any) => r.grossWeight.toFixed(3) },
            { header: 'Cost Value', value: (r: any) => r.costValue },
            { header: 'Selling Value', value: (r: any) => r.sellingValue },
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
                <TableCell>Branch</TableCell><TableCell>Category</TableCell>
                <TableCell align="right">Count</TableCell><TableCell align="right">Gross Weight (g)</TableCell>
                <TableCell align="right">Cost Value</TableCell><TableCell align="right">Selling Value</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {isLoading ? <TableRow><TableCell colSpan={6} align="center" sx={{ py: 4 }}>Loading...</TableCell></TableRow>
                : rows.map((r) => (
                  <TableRow key={`${r.branchId}-${r.categoryId ?? 'none'}`} hover>
                    <TableCell sx={{ fontWeight: 600 }}>{r.branchName}</TableCell>
                    <TableCell>{r.categoryName}</TableCell>
                    <TableCell align="right" sx={{ fontFamily: 'monospace' }}>{r.count}</TableCell>
                    <TableCell align="right" sx={{ fontFamily: 'monospace' }}>{r.grossWeight.toFixed(3)}</TableCell>
                    <TableCell align="right" sx={{ fontFamily: 'monospace' }}>{money(r.costValue)}</TableCell>
                    <TableCell align="right" sx={{ fontFamily: 'monospace', fontWeight: 600 }}>{money(r.sellingValue)}</TableCell>
                  </TableRow>
                ))}
              {!isLoading && rows.length === 0 && (
                <TableRow><TableCell colSpan={6} align="center" sx={{ py: 4 }}>No stock matches these filters</TableCell></TableRow>
              )}
            </TableBody>
          </Table>
        </Box>
        <Divider />
        <Box sx={{ p: 1.5, display: 'flex', justifyContent: 'flex-end', gap: 3, bgcolor: '#EEF1FA' }}>
          <Typography sx={{ fontFamily: 'monospace' }}>Pieces: {totals.count ?? 0}</Typography>
          <Typography sx={{ fontFamily: 'monospace' }}>Cost: {money(totals.costValue ?? 0)}</Typography>
          <Typography fontWeight={700} sx={{ fontFamily: 'monospace' }}>Selling: {money(totals.sellingValue ?? 0)}</Typography>
        </Box>
      </Card>
    </Box>
  );
}
