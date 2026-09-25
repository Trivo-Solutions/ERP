import { useState } from 'react';
import { Box, Card, Table, TableHead, TableBody, TableRow, TableCell, Typography, Button, Grid, Chip, Dialog, DialogTitle, DialogContent, DialogActions, TextField, Alert } from '@mui/material';
import { Add, CheckCircle } from '@mui/icons-material';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm, Controller, useFieldArray } from 'react-hook-form';
import { useSnackbar } from 'notistack';
import { apiGet, apiPost, apiPatch } from '../../api/client';
import { PageHeader } from '../../components/common/PageHeader';
import { StatusChip } from '../../components/common/StatusChip';

export function HallmarkingPage() {
  const { enqueueSnackbar } = useSnackbar();
  const qc = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);

  const { data, isLoading } = useQuery({ queryKey: ['hallmarking'], queryFn: () => apiGet<any[]>('/quality/hallmarking') });

  const { control, handleSubmit, reset } = useForm({
    defaultValues: { centerName: '', sentDate: new Date().toISOString().split('T')[0], items: [{ jobCardId: '', tagNumber: '', karat: '22K', netWeight: 0 }] },
  });
  const { fields, append, remove } = useFieldArray({ control, name: 'items' });

  // G2: an item needs either a real jobCardId (manufacturing lineage) or a tagId (purchased
  // finished goods, no JobCard — CLAUDE.md §3). The form takes a plain tag number, resolved to a
  // real tagId here via the same search endpoint Stock Lookup/Repairs use, rather than juggling
  // an async Autocomplete's state per field-array row.
  const mutation = useMutation({
    mutationFn: async (data: any) => {
      const items = await Promise.all(data.items.map(async (i: any) => {
        const jobCardId = i.jobCardId?.trim() || undefined;
        let tagId: string | undefined;
        if (!jobCardId && i.tagNumber?.trim()) {
          const results = await apiGet<any[]>('/tagging/tags/search', { q: i.tagNumber.trim(), status: 'ALL' });
          const match = results.find((t) => t.tagNumber.toLowerCase() === i.tagNumber.trim().toLowerCase()) ?? results[0];
          if (!match) throw new Error(`No tag found matching "${i.tagNumber}"`);
          tagId = match.id;
        }
        if (!jobCardId && !tagId) throw new Error('Each item needs either a Job Card ID or a Tag Number');
        return { jobCardId, tagId, karat: i.karat, netWeight: Number(i.netWeight) };
      }));
      return apiPost('/quality/hallmarking', { centerName: data.centerName, sentDate: new Date(data.sentDate), items });
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['hallmarking'] }); setCreateOpen(false); reset(); enqueueSnackbar('Hallmarking batch created', { variant: 'success' }); },
    onError: (e: any) => enqueueSnackbar(e?.message ?? e?.response?.data?.message ?? 'Could not create batch', { variant: 'error' }),
  });

  return (
    <Box>
      <PageHeader title="Hallmarking & BIS Compliance" subtitle="Track batches sent for hallmarking — record HUID upon return"
        breadcrumbs={[{ label: 'Quality', path: '/quality/hallmarking' }, { label: 'Hallmarking' }]}
        actions={[{ label: 'New Batch', icon: <Add />, onClick: () => setCreateOpen(true) }]} />

      <Card>
        <Box sx={{ overflowX: 'auto' }}>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>Batch #</TableCell><TableCell>Center</TableCell><TableCell>Sent Date</TableCell>
              <TableCell>Return Date</TableCell><TableCell align="center">Items</TableCell><TableCell>Status</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {isLoading ? <TableRow><TableCell colSpan={6} align="center" sx={{ py: 4 }}>Loading...</TableCell></TableRow>
              : (data ?? []).map((batch: any) => (
                <TableRow key={batch.id} hover>
                  <TableCell sx={{ fontFamily: 'monospace', fontWeight: 700, color: '#44C47A' }}>{batch.batchNumber}</TableCell>
                  <TableCell sx={{ fontWeight: 600 }}>{batch.centerName}</TableCell>
                  <TableCell sx={{ fontSize: 12 }}>{new Date(batch.sentDate).toLocaleDateString('en-IN')}</TableCell>
                  <TableCell sx={{ fontSize: 12 }}>{batch.returnDate ? new Date(batch.returnDate).toLocaleDateString('en-IN') : '—'}</TableCell>
                  <TableCell align="center">{batch._count?.items ?? 0}</TableCell>
                  <TableCell><StatusChip status={batch.status} /></TableCell>
                </TableRow>
              ))}
          </TableBody>
        </Table>
        </Box>
      </Card>

      <Dialog open={createOpen} onClose={() => setCreateOpen(false)} maxWidth="md" fullWidth>
        <form onSubmit={handleSubmit((d) => mutation.mutate(d))}>
          <DialogTitle fontWeight={700}>New Hallmarking Batch</DialogTitle>
          <DialogContent sx={{ pt: 2 }}>
            <Grid container spacing={2} sx={{ mb: 2 }}>
              <Grid item xs={6}><Controller name="centerName" control={control} rules={{ required: true }} render={({ field }) => <TextField {...field} fullWidth label="Hallmarking Center Name" />} /></Grid>
              <Grid item xs={6}><Controller name="sentDate" control={control} render={({ field }) => <TextField {...field} fullWidth label="Date Sent" type="date" InputLabelProps={{ shrink: true }} />} /></Grid>
            </Grid>
            <Typography variant="subtitle2" fontWeight={700} gutterBottom>Items</Typography>
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
              Give each item either a Job Card ID (manufactured piece) or a Tag Number (purchased finished goods) — not both.
            </Typography>
            {fields.map((f, idx) => (
              <Grid container spacing={2} key={f.id} sx={{ mb: 1 }} alignItems="center">
                <Grid item xs={3}><Controller name={`items.${idx}.jobCardId`} control={control} render={({ field }) => <TextField {...field} fullWidth size="small" label="Job Card ID" />} /></Grid>
                <Grid item xs={3}><Controller name={`items.${idx}.tagNumber`} control={control} render={({ field }) => <TextField {...field} fullWidth size="small" label="Tag Number" />} /></Grid>
                <Grid item xs={2}><Controller name={`items.${idx}.karat`} control={control} render={({ field }) => <TextField {...field} fullWidth size="small" label="Karat" />} /></Grid>
                <Grid item xs={3}><Controller name={`items.${idx}.netWeight`} control={control} render={({ field }) => <TextField {...field} fullWidth size="small" label="Net Weight (g)" type="number" inputProps={{ step: 0.001 }} />} /></Grid>
                <Grid item xs={1}><Button size="small" color="error" onClick={() => remove(idx)}>✕</Button></Grid>
              </Grid>
            ))}
            <Button size="small" startIcon={<Add />} onClick={() => append({ jobCardId: '', tagNumber: '', karat: '22K', netWeight: 0 })}>Add Item</Button>
          </DialogContent>
          <DialogActions sx={{ p: 2.5 }}><Button onClick={() => setCreateOpen(false)}>Cancel</Button><Button type="submit" variant="contained" disabled={mutation.isPending}>Send Batch</Button></DialogActions>
        </form>
      </Dialog>
    </Box>
  );
}
