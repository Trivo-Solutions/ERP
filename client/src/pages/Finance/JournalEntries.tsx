import { useState } from 'react';
import { Box, Card, Table, TableHead, TableBody, TableRow, TableCell, Typography, Button, Grid, Chip, Dialog, DialogTitle, DialogContent, DialogActions, TextField, MenuItem, Alert } from '@mui/material';
import { Add, PlayArrow } from '@mui/icons-material';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm, Controller, useFieldArray } from 'react-hook-form';
import { useSnackbar } from 'notistack';
import { apiGet, apiPost } from '../../api/client';
import { PageHeader } from '../../components/common/PageHeader';
import { useAuthStore } from '../../store/auth.store';

export function JournalEntries() {
  const { enqueueSnackbar } = useSnackbar();
  const qc = useQueryClient();
  const hasPermission = useAuthStore((s) => s.hasPermission);
  const [createOpen, setCreateOpen] = useState(false);

  const { data, isLoading } = useQuery({ queryKey: ['journal-entries'], queryFn: () => apiGet<any[]>('/finance/journals') });
  const { data: accounts } = useQuery({ queryKey: ['accounts'], queryFn: () => apiGet<any[]>('/finance/accounts') });

  const { control, handleSubmit, reset, watch } = useForm({
    defaultValues: { date: new Date().toISOString().split('T')[0], description: '', lines: [{ accountId: '', debit: 0, credit: 0, narration: '' }, { accountId: '', debit: 0, credit: 0, narration: '' }] },
  });
  const { fields, append, remove } = useFieldArray({ control, name: 'lines' });

  const createMutation = useMutation({
    mutationFn: (data: any) => apiPost('/finance/journals', { ...data, date: new Date(data.date) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['journal-entries'] }); setCreateOpen(false); reset(); enqueueSnackbar('Journal entry created', { variant: 'success' }); },
    onError: (err: any) => enqueueSnackbar(err.response?.data?.error ?? 'Entry not balanced', { variant: 'error' }),
  });

  const postMutation = useMutation({
    mutationFn: (id: string) => apiPost(`/finance/journals/${id}/post`, {}),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['journal-entries'] }); enqueueSnackbar('Entry posted to ledger', { variant: 'success' }); },
  });

  const lines = watch('lines');
  const totalDr = lines.reduce((s, l) => s + Number(l.debit), 0);
  const totalCr = lines.reduce((s, l) => s + Number(l.credit), 0);
  const balanced = Math.abs(totalDr - totalCr) < 0.01;

  return (
    <Box>
      <PageHeader title="Journal Entries"
        actions={hasPermission('journal:create') ? [{ label: 'New Journal', icon: <Add />, onClick: () => setCreateOpen(true) }] : []} />

      <Card>
        <Box sx={{ overflowX: 'auto' }}>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>Entry #</TableCell><TableCell>Date</TableCell><TableCell>Description</TableCell>
              <TableCell align="right">Total Dr (₹)</TableCell><TableCell align="right">Total Cr (₹)</TableCell>
              <TableCell>Lines</TableCell><TableCell>Posted</TableCell><TableCell>Actions</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {isLoading ? <TableRow><TableCell colSpan={8} align="center" sx={{ py: 4 }}>Loading...</TableCell></TableRow>
              : (data ?? []).map((je: any) => (
                <TableRow key={je.id} hover>
                  <TableCell sx={{ fontFamily: 'monospace', fontWeight: 700, color: '#44C47A', fontSize: 12 }}>{je.entryNumber}</TableCell>
                  <TableCell sx={{ fontSize: 12 }}>{new Date(je.date).toLocaleDateString('en-IN')}</TableCell>
                  <TableCell>{je.description}</TableCell>
                  <TableCell align="right" sx={{ fontFamily: 'monospace' }}>₹{Number(je.totalDebit).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</TableCell>
                  <TableCell align="right" sx={{ fontFamily: 'monospace' }}>₹{Number(je.totalCredit).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</TableCell>
                  <TableCell align="center">{je.lines?.length ?? 0}</TableCell>
                  <TableCell><Chip label={je.isPosted ? 'Posted' : 'Draft'} size="small" color={je.isPosted ? 'success' : 'default'} /></TableCell>
                  <TableCell>
                    {!je.isPosted && hasPermission('journal:post') && (
                      <Button size="small" startIcon={<PlayArrow />} onClick={() => postMutation.mutate(je.id)}>Post</Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
          </TableBody>
        </Table>
        </Box>
      </Card>

      <Dialog open={createOpen} onClose={() => setCreateOpen(false)} maxWidth="md" fullWidth>
        <form onSubmit={handleSubmit((d) => createMutation.mutate(d))}>
          <DialogTitle fontWeight={700}>New Journal Entry</DialogTitle>
          <DialogContent sx={{ pt: 2 }}>
            <Grid container spacing={2} sx={{ mb: 2 }}>
              <Grid item xs={3}><Controller name="date" control={control} render={({ field }) => <TextField {...field} fullWidth label="Date" type="date" InputLabelProps={{ shrink: true }} />} /></Grid>
              <Grid item xs={9}><Controller name="description" control={control} rules={{ required: true }} render={({ field }) => <TextField {...field} fullWidth label="Description / Narration" />} /></Grid>
            </Grid>
            {!balanced && totalDr > 0 && (
              <Alert severity="error" sx={{ mb: 1 }}>Not balanced! Dr: ₹{totalDr.toFixed(2)} ≠ Cr: ₹{totalCr.toFixed(2)}</Alert>
            )}
            {fields.map((f, idx) => (
              <Grid container spacing={1.5} key={f.id} sx={{ mb: 1 }} alignItems="center">
                <Grid item xs={4}><Controller name={`lines.${idx}.accountId`} control={control} rules={{ required: true }} render={({ field }) => <TextField {...field} select fullWidth size="small" label="Account">{(accounts ?? []).map((a: any) => <MenuItem key={a.id} value={a.id}>{a.code} — {a.name}</MenuItem>)}</TextField>} /></Grid>
                <Grid item xs={3}><Controller name={`lines.${idx}.debit`} control={control} render={({ field }) => <TextField {...field} fullWidth size="small" label="Debit (₹)" type="number" inputProps={{ step: 0.01 }} />} /></Grid>
                <Grid item xs={3}><Controller name={`lines.${idx}.credit`} control={control} render={({ field }) => <TextField {...field} fullWidth size="small" label="Credit (₹)" type="number" inputProps={{ step: 0.01 }} />} /></Grid>
                <Grid item xs={2}><Button size="small" color="error" onClick={() => remove(idx)}>✕</Button></Grid>
              </Grid>
            ))}
            <Button size="small" startIcon={<Add />} onClick={() => append({ accountId: '', debit: 0, credit: 0, narration: '' })}>Add Line</Button>
          </DialogContent>
          <DialogActions sx={{ p: 2.5 }}>
            <Typography sx={{ mr: 'auto', fontSize: 13, color: balanced ? 'success.main' : 'error.main', fontWeight: 700 }}>
              {balanced ? '✓ Balanced' : `Difference: ₹${Math.abs(totalDr - totalCr).toFixed(2)}`}
            </Typography>
            <Button onClick={() => setCreateOpen(false)}>Cancel</Button>
            <Button type="submit" variant="contained" disabled={!balanced || createMutation.isPending}>Save Draft</Button>
          </DialogActions>
        </form>
      </Dialog>
    </Box>
  );
}
