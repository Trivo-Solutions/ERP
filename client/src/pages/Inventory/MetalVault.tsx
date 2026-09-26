import { useState } from 'react';
import { Box, Card, Table, TableHead, TableBody, TableRow, TableCell, Typography, Button, Grid, Chip, Dialog, DialogTitle, DialogContent, DialogActions, TextField, MenuItem, Alert } from '@mui/material';
import { Add, Scale } from '@mui/icons-material';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm, Controller } from 'react-hook-form';
import { useSnackbar } from 'notistack';
import { apiGet, apiPost } from '../../api/client';
import { PageHeader } from '../../components/common/PageHeader';
import { useScaleReading } from '../../hooks/useSocket';
import { useUiStore } from '../../store/ui.store';

const KARATS = ['24K', '22K', '18K', '14K', 'SILVER', 'PT'];
const LOCATIONS = ['VAULT', 'SHOP_FLOOR', 'CASTING_ROOM', 'POLISHING_ROOM'];

export function MetalVault() {
  const { enqueueSnackbar } = useSnackbar();
  const qc = useQueryClient();
  const { scaleDevice } = useUiStore();
  const [createOpen, setCreateOpen] = useState(false);
  const [karatFilter, setKaratFilter] = useState('');
  const [scaleWeight, setScaleWeight] = useState<number | null>(null);

  useScaleReading(scaleDevice, (w) => setScaleWeight(w));

  const { data: stock, isLoading } = useQuery({
    queryKey: ['metal-stock', karatFilter],
    queryFn: () => apiGet<any[]>('/inventory/metals', { karat: karatFilter || undefined }),
  });

  const { control, handleSubmit, reset, setValue } = useForm({
    defaultValues: { materialName: '', karat: '22K', purity: 0.916, grossWeight: 0, netWeight: 0, location: 'VAULT', sourceType: 'PURCHASE', avgCostPerGram: 0 },
  });

  const mutation = useMutation({
    mutationFn: (data: any) => apiPost('/inventory/metals', data),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['metal-stock'] }); setCreateOpen(false); reset(); enqueueSnackbar('Metal stock added to vault', { variant: 'success' }); },
  });

  const totalAvailable = (stock ?? []).reduce((sum: number, s: any) => sum + Number(s.availableWt), 0);

  return (
    <Box>
      <PageHeader title="Metal Vault"
        actions={[{ label: 'Add Metal Stock', icon: <Add />, onClick: () => setCreateOpen(true) }]} />

      {scaleWeight !== null && <Alert severity="info" sx={{ mb: 2 }}><Scale sx={{ mr: 1, verticalAlign: 'middle' }} />Scale: <strong>{scaleWeight.toFixed(4)} g</strong></Alert>}

      <Grid container spacing={2} sx={{ mb: 2 }}>
        {KARATS.map((k) => {
          const total = (stock ?? []).filter((s: any) => s.karat === k).reduce((sum: number, s: any) => sum + Number(s.availableWt), 0);
          return (
            <Grid item xs={4} sm={2} key={k}>
              <Card sx={{ p: 1.5, cursor: 'pointer', border: karatFilter === k ? '2px solid #44C47A' : '1px solid transparent' }} onClick={() => setKaratFilter(karatFilter === k ? '' : k)}>
                <Typography variant="caption" color="text.secondary">{k}</Typography>
                <Typography fontWeight={700} sx={{ fontFamily: 'monospace', fontSize: 13 }}>{total.toFixed(3)}g</Typography>
              </Card>
            </Grid>
          );
        })}
      </Grid>

      <Card>
        <Box sx={{ overflowX: 'auto' }}>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>Stock Code</TableCell><TableCell>Material</TableCell><TableCell>Karat</TableCell>
              <TableCell align="right">Gross Wt (g)</TableCell><TableCell align="right">Net Wt (g)</TableCell>
              <TableCell align="right">Available (g)</TableCell><TableCell>Location</TableCell>
              <TableCell align="right">Cost/g (₹)</TableCell><TableCell>Source</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {isLoading ? <TableRow><TableCell colSpan={9} align="center" sx={{ py: 4 }}>Loading...</TableCell></TableRow>
              : (stock ?? []).map((s: any) => (
                <TableRow key={s.id} hover>
                  <TableCell sx={{ fontFamily: 'monospace', fontSize: 12, fontWeight: 700, color: '#44C47A' }}>{s.stockCode}</TableCell>
                  <TableCell>{s.materialName}</TableCell>
                  <TableCell><Chip label={s.karat} size="small" sx={{ bgcolor: '#FFF8E7', color: '#44C47A', fontWeight: 700 }} /></TableCell>
                  <TableCell align="right" sx={{ fontFamily: 'monospace' }}>{Number(s.grossWeight).toFixed(4)}</TableCell>
                  <TableCell align="right" sx={{ fontFamily: 'monospace' }}>{Number(s.netWeight).toFixed(4)}</TableCell>
                  <TableCell align="right" sx={{ fontFamily: 'monospace', fontWeight: 700, color: Number(s.availableWt) < 50 ? 'error.main' : 'success.main' }}>
                    {Number(s.availableWt).toFixed(4)}
                  </TableCell>
                  <TableCell><Chip label={s.location ?? 'VAULT'} size="small" variant="outlined" /></TableCell>
                  <TableCell align="right" sx={{ fontFamily: 'monospace' }}>₹{Number(s.avgCostPerGram).toFixed(2)}</TableCell>
                  <TableCell><Chip label={s.sourceType} size="small" /></TableCell>
                </TableRow>
              ))}
          </TableBody>
        </Table>
        </Box>
        <Box sx={{ p: 1.5, borderTop: 1, borderColor: 'divider', display: 'flex', justifyContent: 'flex-end', gap: 3 }}>
          <Typography variant="caption" color="text.secondary">Total Available:</Typography>
          <Typography variant="subtitle2" fontWeight={700} sx={{ fontFamily: 'monospace', color: '#44C47A' }}>{totalAvailable.toFixed(4)} g</Typography>
        </Box>
      </Card>

      <Dialog open={createOpen} onClose={() => setCreateOpen(false)} maxWidth="sm" fullWidth>
        <form onSubmit={handleSubmit((d) => mutation.mutate(d))}>
          <DialogTitle fontWeight={700}>Add Metal to Vault</DialogTitle>
          <DialogContent sx={{ pt: 2 }}>
            <Grid container spacing={2}>
              <Grid item xs={8}><Controller name="materialName" control={control} rules={{ required: true }} render={({ field }) => <TextField {...field} fullWidth label="Material Description" />} /></Grid>
              <Grid item xs={4}><Controller name="karat" control={control} render={({ field }) => <TextField {...field} select fullWidth label="Karat">{KARATS.map((k) => <MenuItem key={k} value={k}>{k}</MenuItem>)}</TextField>} /></Grid>
              <Grid item xs={4}>
                <Controller name="grossWeight" control={control} rules={{ required: true }}
                  render={({ field }) => <TextField {...field} fullWidth label="Gross Weight (g)" type="number" inputProps={{ step: 0.0001 }}
                    InputProps={{ endAdornment: scaleWeight && <Button size="small" onClick={() => { setValue('grossWeight', scaleWeight); setValue('netWeight', scaleWeight * 0.995); }}>←</Button> }} />} />
              </Grid>
              <Grid item xs={4}><Controller name="netWeight" control={control} render={({ field }) => <TextField {...field} fullWidth label="Net Weight (g)" type="number" inputProps={{ step: 0.0001 }} />} /></Grid>
              <Grid item xs={4}><Controller name="avgCostPerGram" control={control} render={({ field }) => <TextField {...field} fullWidth label="Cost/gram (₹)" type="number" inputProps={{ step: 0.01 }} />} /></Grid>
              <Grid item xs={6}><Controller name="location" control={control} render={({ field }) => <TextField {...field} select fullWidth label="Location">{LOCATIONS.map((l) => <MenuItem key={l} value={l}>{l}</MenuItem>)}</TextField>} /></Grid>
              <Grid item xs={6}><Controller name="sourceType" control={control} render={({ field }) => <TextField {...field} select fullWidth label="Source Type"><MenuItem value="PURCHASE">Purchase</MenuItem><MenuItem value="CUSTOMER_SUPPLIED">Customer Supplied</MenuItem><MenuItem value="PRODUCTION_RETURN">Production Return</MenuItem></TextField>} /></Grid>
            </Grid>
          </DialogContent>
          <DialogActions sx={{ p: 2.5 }}><Button onClick={() => setCreateOpen(false)}>Cancel</Button><Button type="submit" variant="contained" disabled={mutation.isPending}>Add to Vault</Button></DialogActions>
        </form>
      </Dialog>
    </Box>
  );
}
