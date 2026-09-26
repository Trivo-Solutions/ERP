import { useState } from 'react';
import { Box, Card, Table, TableHead, TableBody, TableRow, TableCell, Typography, Button, Grid, Chip, Dialog, DialogTitle, DialogContent, DialogActions, TextField, MenuItem, Alert } from '@mui/material';
import { Add, CallSplit } from '@mui/icons-material';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm, Controller, useFieldArray } from 'react-hook-form';
import { useSnackbar } from 'notistack';
import { apiGet, apiPost } from '../../api/client';
import { PageHeader } from '../../components/common/PageHeader';
import { StatusChip } from '../../components/common/StatusChip';

export function DiamondAssortment() {
  const { enqueueSnackbar } = useSnackbar();
  const qc = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [splitOpen, setSplitOpen] = useState<string | null>(null);

  const { data: lots, isLoading } = useQuery({ queryKey: ['stone-lots'], queryFn: () => apiGet<any[]>('/inventory/stones') });

  const { control, handleSubmit, reset } = useForm({
    defaultValues: { stoneType: 'DIAMOND', shape: 'ROUND', color: 'G', clarity: 'VS1', cut: 'EXCELLENT', caratWeight: 0, pieces: 0, sieveSize: '', certNumber: '', certLab: 'GIA', avgCostPerCt: 0, totalCost: 0, location: 'VAULT' },
  });

  const splitForm = useForm({ defaultValues: { splits: [{ weight: 0, pieces: 0 }] } });
  const { fields, append, remove } = useFieldArray({ control: splitForm.control, name: 'splits' });

  const createMutation = useMutation({
    mutationFn: (data: any) => apiPost('/inventory/stones', data),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['stone-lots'] }); setCreateOpen(false); reset(); enqueueSnackbar('Stone lot created', { variant: 'success' }); },
  });

  const splitMutation = useMutation({
    mutationFn: ({ id, splits }: { id: string; splits: any[] }) => apiPost(`/inventory/stones/${id}/split`, { splits }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['stone-lots'] }); setSplitOpen(null); enqueueSnackbar('Lot split successfully', { variant: 'success' }); },
  });

  return (
    <Box>
      <PageHeader title="Diamond & Stone Assortment"
        actions={[{ label: 'Add Stone Lot', icon: <Add />, onClick: () => setCreateOpen(true) }]} />

      <Card>
        <Box sx={{ overflowX: 'auto' }}>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>Lot #</TableCell><TableCell>Type</TableCell><TableCell>Shape</TableCell>
              <TableCell>Color</TableCell><TableCell>Clarity</TableCell><TableCell>Cut</TableCell>
              <TableCell align="right">Total Cts</TableCell><TableCell align="right">Available Cts</TableCell>
              <TableCell align="right">Pcs</TableCell><TableCell>Cert</TableCell>
              <TableCell align="right">Cost/ct (₹)</TableCell><TableCell>Status</TableCell><TableCell>Actions</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {isLoading ? <TableRow><TableCell colSpan={13} align="center" sx={{ py: 4 }}>Loading...</TableCell></TableRow>
              : (lots ?? []).map((lot: any) => (
                <TableRow key={lot.id} hover>
                  <TableCell sx={{ fontFamily: 'monospace', fontSize: 12, fontWeight: 700, color: '#44C47A' }}>{lot.lotNumber}</TableCell>
                  <TableCell sx={{ fontWeight: 600 }}>{lot.stoneType}</TableCell>
                  <TableCell>{lot.shape}</TableCell>
                  <TableCell><Chip label={lot.color ?? '—'} size="small" sx={{ fontFamily: 'monospace', minWidth: 28 }} /></TableCell>
                  <TableCell><Chip label={lot.clarity ?? '—'} size="small" /></TableCell>
                  <TableCell sx={{ fontSize: 12 }}>{lot.cut ?? '—'}</TableCell>
                  <TableCell align="right" sx={{ fontFamily: 'monospace' }}>{Number(lot.caratWeight).toFixed(4)}</TableCell>
                  <TableCell align="right" sx={{ fontFamily: 'monospace', fontWeight: 700, color: '#44C47A' }}>{Number(lot.availableCts).toFixed(4)}</TableCell>
                  <TableCell align="right" sx={{ fontFamily: 'monospace' }}>{lot.availablePcs}</TableCell>
                  <TableCell>{lot.certLab && <Chip label={lot.certLab} size="small" color="info" />}</TableCell>
                  <TableCell align="right" sx={{ fontFamily: 'monospace' }}>₹{Number(lot.avgCostPerCt).toFixed(2)}</TableCell>
                  <TableCell><StatusChip status={lot.status} /></TableCell>
                  <TableCell>
                    <Button size="small" startIcon={<CallSplit />} onClick={() => setSplitOpen(lot.id)} disabled={lot.status === 'EXHAUSTED'}>Split</Button>
                  </TableCell>
                </TableRow>
              ))}
          </TableBody>
        </Table>
        </Box>
      </Card>

      {/* Create Dialog */}
      <Dialog open={createOpen} onClose={() => setCreateOpen(false)} maxWidth="md" fullWidth>
        <form onSubmit={handleSubmit((d) => createMutation.mutate(d))}>
          <DialogTitle fontWeight={700}>Add Stone Lot</DialogTitle>
          <DialogContent sx={{ pt: 2 }}>
            <Grid container spacing={2}>
              <Grid item xs={4}><Controller name="stoneType" control={control} render={({ field }) => <TextField {...field} select fullWidth label="Stone Type"><MenuItem value="DIAMOND">Diamond</MenuItem><MenuItem value="RUBY">Ruby</MenuItem><MenuItem value="EMERALD">Emerald</MenuItem><MenuItem value="SAPPHIRE">Sapphire</MenuItem></TextField>} /></Grid>
              <Grid item xs={4}><Controller name="shape" control={control} render={({ field }) => <TextField {...field} select fullWidth label="Shape"><MenuItem value="ROUND">Round</MenuItem><MenuItem value="PRINCESS">Princess</MenuItem><MenuItem value="OVAL">Oval</MenuItem><MenuItem value="CUSHION">Cushion</MenuItem><MenuItem value="MARQUISE">Marquise</MenuItem></TextField>} /></Grid>
              <Grid item xs={4}><Controller name="cut" control={control} render={({ field }) => <TextField {...field} select fullWidth label="Cut Grade"><MenuItem value="EXCELLENT">Excellent</MenuItem><MenuItem value="VERY_GOOD">Very Good</MenuItem><MenuItem value="GOOD">Good</MenuItem></TextField>} /></Grid>
              <Grid item xs={3}><Controller name="color" control={control} render={({ field }) => <TextField {...field} fullWidth label="Color (D-Z)" />} /></Grid>
              <Grid item xs={3}><Controller name="clarity" control={control} render={({ field }) => <TextField {...field} select fullWidth label="Clarity"><MenuItem value="IF">IF</MenuItem><MenuItem value="VVS1">VVS1</MenuItem><MenuItem value="VVS2">VVS2</MenuItem><MenuItem value="VS1">VS1</MenuItem><MenuItem value="VS2">VS2</MenuItem><MenuItem value="SI1">SI1</MenuItem></TextField>} /></Grid>
              <Grid item xs={3}><Controller name="caratWeight" control={control} rules={{ required: true }} render={({ field }) => <TextField {...field} fullWidth label="Total Carat Wt" type="number" inputProps={{ step: 0.0001 }} />} /></Grid>
              <Grid item xs={3}><Controller name="pieces" control={control} rules={{ required: true }} render={({ field }) => <TextField {...field} fullWidth label="Pieces" type="number" />} /></Grid>
              <Grid item xs={4}><Controller name="sieveSize" control={control} render={({ field }) => <TextField {...field} fullWidth label="Sieve Size" placeholder="e.g. -10+8" />} /></Grid>
              <Grid item xs={4}><Controller name="certNumber" control={control} render={({ field }) => <TextField {...field} fullWidth label="Cert Number (GIA/IGI)" />} /></Grid>
              <Grid item xs={4}><Controller name="certLab" control={control} render={({ field }) => <TextField {...field} select fullWidth label="Lab"><MenuItem value="GIA">GIA</MenuItem><MenuItem value="IGI">IGI</MenuItem><MenuItem value="HRD">HRD</MenuItem><MenuItem value="NONE">None</MenuItem></TextField>} /></Grid>
              <Grid item xs={6}><Controller name="avgCostPerCt" control={control} rules={{ required: true }} render={({ field }) => <TextField {...field} fullWidth label="Avg Cost/ct (₹)" type="number" inputProps={{ step: 0.01 }} />} /></Grid>
              <Grid item xs={6}><Controller name="totalCost" control={control} render={({ field }) => <TextField {...field} fullWidth label="Total Cost (₹)" type="number" />} /></Grid>
            </Grid>
          </DialogContent>
          <DialogActions sx={{ p: 2.5 }}><Button onClick={() => setCreateOpen(false)}>Cancel</Button><Button type="submit" variant="contained" disabled={createMutation.isPending}>Add Lot</Button></DialogActions>
        </form>
      </Dialog>

      {/* Split Dialog */}
      <Dialog open={!!splitOpen} onClose={() => setSplitOpen(null)} maxWidth="sm" fullWidth>
        <form onSubmit={splitForm.handleSubmit((d) => splitMutation.mutate({ id: splitOpen!, splits: d.splits }))}>
          <DialogTitle fontWeight={700}>Split Stone Lot</DialogTitle>
          <DialogContent sx={{ pt: 2 }}>
            <Alert severity="info" sx={{ mb: 2 }}>Define sub-lots to split from the parent lot. Weighted average cost will be recalculated automatically.</Alert>
            {fields.map((f, idx) => (
              <Grid container spacing={2} key={f.id} sx={{ mb: 1 }} alignItems="center">
                <Grid item xs={5}><Controller name={`splits.${idx}.weight`} control={splitForm.control} render={({ field }) => <TextField {...field} fullWidth size="small" label="Carat Weight" type="number" inputProps={{ step: 0.0001 }} />} /></Grid>
                <Grid item xs={5}><Controller name={`splits.${idx}.pieces`} control={splitForm.control} render={({ field }) => <TextField {...field} fullWidth size="small" label="Pieces" type="number" />} /></Grid>
                <Grid item xs={2}><Button size="small" color="error" onClick={() => remove(idx)}>✕</Button></Grid>
              </Grid>
            ))}
            <Button size="small" startIcon={<Add />} onClick={() => append({ weight: 0, pieces: 0 })}>Add Sub-lot</Button>
          </DialogContent>
          <DialogActions sx={{ p: 2.5 }}><Button onClick={() => setSplitOpen(null)}>Cancel</Button><Button type="submit" variant="contained" disabled={splitMutation.isPending}>Split Lot</Button></DialogActions>
        </form>
      </Dialog>
    </Box>
  );
}
