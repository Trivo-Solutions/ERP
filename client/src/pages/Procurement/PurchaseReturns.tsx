import { useState } from 'react';
import {
  Box, Card, CardContent, Table, TableHead, TableBody, TableRow, TableCell, Typography,
  Button, Grid, MenuItem, TextField, Stack, Checkbox, Chip, CircularProgress,
} from '@mui/material';
import { Undo } from '@mui/icons-material';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useSnackbar } from 'notistack';
import { apiGet, apiPost } from '../../api/client';
import { PageHeader } from '../../components/common/PageHeader';

function fmt(n: number) {
  return '₹' + Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });
}

export function PurchaseReturns() {
  const { enqueueSnackbar } = useSnackbar();
  const qc = useQueryClient();
  const [supplierId, setSupplierId] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [reason, setReason] = useState('');

  const { data: suppliers } = useQuery({
    queryKey: ['suppliers'], queryFn: () => apiGet<any[]>('/procurement/suppliers'),
  });
  const supplierList: any[] = suppliers ?? [];

  const { data: returnableTags, isFetching: loadingTags } = useQuery({
    queryKey: ['returnable-tags', supplierId],
    queryFn: () => apiGet<any[]>(`/procurement/suppliers/${supplierId}/returnable-tags`),
    enabled: !!supplierId,
  });
  const tags: any[] = returnableTags ?? [];

  const { data: returnsData } = useQuery({
    queryKey: ['purchase-returns', supplierId],
    queryFn: () => apiGet<any[]>('/procurement/returns', { supplierId: supplierId || undefined }),
  });
  const returns: any[] = returnsData ?? [];

  const toggle = (id: string) => {
    setSelected((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  };

  const mutation = useMutation({
    mutationFn: () => apiPost('/procurement/returns', {
      items: selected.map((tagId) => ({ tagId })),
      reason: reason || undefined,
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['returnable-tags', supplierId] });
      qc.invalidateQueries({ queryKey: ['purchase-returns'] });
      setSelected([]);
      setReason('');
      enqueueSnackbar('Purchase return recorded — tag(s) retired', { variant: 'success' });
    },
    onError: (e: any) => enqueueSnackbar(e.response?.data?.error ?? 'Failed to record return', { variant: 'error' }),
  });

  return (
    <Box>
      <PageHeader title="Purchase Returns" />

      <Card sx={{ mb: 2 }}>
        <CardContent>
          <Grid container spacing={2} alignItems="center">
            <Grid item xs={12} sm={4}>
              <TextField select fullWidth label="Supplier" value={supplierId}
                onChange={(e) => { setSupplierId(e.target.value); setSelected([]); }}>
                <MenuItem value="">Select a supplier...</MenuItem>
                {supplierList.map((s: any) => (
                  <MenuItem key={s.id} value={s.id}>{s.supplierCode} — {s.name}</MenuItem>
                ))}
              </TextField>
            </Grid>
          </Grid>

          {supplierId && (
            <Box sx={{ mt: 2 }}>
              {loadingTags && <Box sx={{ display: 'flex', justifyContent: 'center', py: 3 }}><CircularProgress size={24} /></Box>}

              {!loadingTags && tags.length === 0 && (
                <Typography color="text.secondary" sx={{ py: 2 }}>
                  No IN_STOCK finished-goods pieces from this supplier to return.
                </Typography>
              )}

              {tags.length > 0 && (
                <Stack spacing={1}>
                  {tags.map((tag: any) => (
                    <Stack key={tag.id} direction="row" alignItems="center" spacing={1}>
                      <Checkbox size="small" checked={selected.includes(tag.id)} onChange={() => toggle(tag.id)} />
                      <Typography variant="body2" sx={{ fontFamily: 'monospace', color: '#44C47A', minWidth: 120 }}>
                        {tag.tagNumber}
                      </Typography>
                      <Typography variant="body2" sx={{ flex: 1 }}>{tag.name}</Typography>
                      <Typography variant="body2" color="text.secondary">{tag.branch?.name}</Typography>
                      <Typography variant="body2" sx={{ fontFamily: 'monospace', fontWeight: 700 }}>
                        {fmt(Number(tag.costPrice))}
                      </Typography>
                    </Stack>
                  ))}
                  <Stack direction="row" spacing={1} alignItems="flex-start" sx={{ pt: 1 }}>
                    <TextField size="small" label="Reason (optional)" value={reason}
                      onChange={(e) => setReason(e.target.value)} sx={{ flex: 1 }} />
                    <Button variant="contained" color="warning" size="small" startIcon={<Undo />}
                      disabled={selected.length === 0 || mutation.isPending}
                      onClick={() => mutation.mutate()} sx={{ height: 40 }}>
                      Return Selected
                    </Button>
                  </Stack>
                </Stack>
              )}
            </Box>
          )}
        </CardContent>
      </Card>

      <Card>
        <Box sx={{ overflowX: 'auto' }}>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Return #</TableCell>
                <TableCell>Date</TableCell>
                <TableCell>Supplier</TableCell>
                <TableCell>Items</TableCell>
                <TableCell>Reason</TableCell>
                <TableCell align="right">Amount</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {returns.map((r: any) => (
                <TableRow key={r.id} hover>
                  <TableCell sx={{ fontFamily: 'monospace', fontWeight: 700, color: '#44C47A', fontSize: 12 }}>
                    {r.returnNumber}
                  </TableCell>
                  <TableCell sx={{ fontSize: 12 }}>{new Date(r.returnDate).toLocaleDateString('en-IN')}</TableCell>
                  <TableCell>{r.supplier?.name}</TableCell>
                  <TableCell>
                    {r.items.map((i: any) => (
                      <Chip key={i.id} label={i.tag?.tagNumber} size="small" sx={{ mr: 0.5, mb: 0.5 }} />
                    ))}
                  </TableCell>
                  <TableCell sx={{ fontSize: 12 }}>{r.reason || '—'}</TableCell>
                  <TableCell align="right" sx={{ fontFamily: 'monospace', fontWeight: 700 }}>
                    {fmt(Number(r.totalAmount))}
                  </TableCell>
                </TableRow>
              ))}
              {returns.length === 0 && (
                <TableRow><TableCell colSpan={6} align="center" sx={{ py: 4 }}>No purchase returns yet</TableCell></TableRow>
              )}
            </TableBody>
          </Table>
        </Box>
      </Card>
    </Box>
  );
}
