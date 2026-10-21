import { useEffect, useState } from 'react';
import { Box, Card, Table, TableHead, TableBody, TableRow, TableCell, Typography, Button, Grid, Chip, Dialog, DialogTitle, DialogContent, DialogActions, TextField, MenuItem, Alert } from '@mui/material';
import { Add, Scale } from '@mui/icons-material';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm, Controller } from 'react-hook-form';
import { useSnackbar } from 'notistack';
import { apiGet, apiPost } from '../../api/client';
import { PageHeader } from '../../components/common/PageHeader';
import { useScaleReading } from '../../hooks/useSocket';
import { useUiStore } from '../../store/ui.store';
import { buildMetalStockPayload, emptyMetalStockForm } from '../../utils/metalStockPayload';

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

  // The karat list is the company's Karat master - never a hard-coded list - and each karat carries its metal. The vault holds
  // gold and silver; the metal sent with a new lot is the selected karat's own, which the server re-checks against the master.
  const { data: karatsData, isSuccess: karatsLoaded } = useQuery({ queryKey: ['vault-karats'], queryFn: () => apiGet<any>('/inventory/metals/karats') });
  const allKarats: any[] = (karatsData as any)?.data ?? karatsData ?? [];
  const vaultKarats = allKarats.filter((k) => k.isActive !== false && (k.metalType === 'GOLD' || k.metalType === 'SILVER'));
  const metalOf = (code: string) => vaultKarats.find((k) => k.code === code)?.metalType as string | undefined;

  const { control, handleSubmit, reset, setValue, getValues } = useForm({
    defaultValues: emptyMetalStockForm([]),
  });
  // Once the master has loaded, start on 22K when the company has it (else its first gold karat), with that karat's own purity. If the
  // list later changes under an open form (a karat deactivated or removed) and the chosen karat is gone, fall back the same way.
  const karatCodes = vaultKarats.map((k) => k.code).join('|');
  useEffect(() => {
    if (vaultKarats.length === 0) return;
    const current = getValues('karat');
    if (current && vaultKarats.some((k) => k.code === current)) return;
    const d = emptyMetalStockForm(vaultKarats);
    setValue('karat', d.karat); setValue('purity', Number(d.purity));
  }, [karatCodes]); // eslint-disable-line react-hooks/exhaustive-deps

  const mutation = useMutation({
    mutationFn: (data: any) => apiPost('/inventory/metals', buildMetalStockPayload(data, vaultKarats)),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['metal-stock'] }); qc.invalidateQueries({ queryKey: ['vault-availability'] }); setCreateOpen(false); reset(emptyMetalStockForm(vaultKarats)); enqueueSnackbar('Metal stock added to vault', { variant: 'success' }); },
  });

  const totalAvailable = (stock ?? []).reduce((sum: number, s: any) => sum + Number(s.availableWt), 0);

  return (
    <Box>
      <PageHeader title="Metal Vault"
        actions={[{ label: 'Add Metal Stock', icon: <Add />, onClick: () => setCreateOpen(true) }]} />

      {scaleWeight !== null && <Alert severity="info" sx={{ mb: 2 }}><Scale sx={{ mr: 1, verticalAlign: 'middle' }} />Scale: <strong>{scaleWeight.toFixed(4)} g</strong></Alert>}

      <Grid container spacing={2} sx={{ mb: 2 }}>
        {vaultKarats.map((kr) => kr.code as string).map((k) => {
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
              <TableCell>Stock Code</TableCell><TableCell>Material</TableCell><TableCell>Karat</TableCell><TableCell>Metal</TableCell>
              <TableCell align="right">Gross Wt (g)</TableCell><TableCell align="right">Net Wt (g)</TableCell>
              <TableCell align="right">Available (g)</TableCell><TableCell>Location</TableCell>
              <TableCell align="right">Cost/g (₹)</TableCell><TableCell>Source</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {isLoading ? <TableRow><TableCell colSpan={10} align="center" sx={{ py: 4 }}>Loading...</TableCell></TableRow>
              : (stock ?? []).map((s: any) => (
                <TableRow key={s.id} hover>
                  <TableCell sx={{ fontFamily: 'monospace', fontSize: 12, fontWeight: 700, color: '#44C47A' }}>{s.stockCode}</TableCell>
                  <TableCell>{s.materialName}</TableCell>
                  <TableCell><Chip label={s.karat} size="small" sx={{ bgcolor: '#FFF8E7', color: '#44C47A', fontWeight: 700 }} /></TableCell>
                  <TableCell>
                    {/* A lot with no stored metal predates the metal column: it is treated as gold, never as silver. */}
                    {s.metalType
                      ? <Chip label={s.metalType === 'SILVER' ? 'Silver' : 'Gold'} size="small" variant="outlined" />
                      : <Chip label="Not set — counts as gold" size="small" color="warning" variant="outlined" title="Entered before the metal was recorded. It can only be sold as gold; correct it with the owner if it is silver." />}
                  </TableCell>
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
            {karatsLoaded && vaultKarats.length === 0 && (
              <Alert severity="warning" sx={{ mb: 2 }}>No active gold or silver karats are set up for this company, so metal cannot be added yet. Add them in Masters → Karats.</Alert>
            )}
            <Grid container spacing={2}>
              <Grid item xs={8}><Controller name="materialName" control={control} rules={{ required: true }} render={({ field }) => <TextField {...field} fullWidth label="Material Description" />} /></Grid>
              <Grid item xs={4}>
                <Controller name="karat" control={control} rules={{ required: true }}
                  render={({ field }) => (
                    <TextField {...field} select fullWidth label="Karat" helperText={metalOf(field.value) ? (metalOf(field.value) === 'SILVER' ? 'Silver' : 'Gold') : ' '}
                      onChange={(e) => { field.onChange(e); const k = vaultKarats.find((x) => x.code === e.target.value); if (k) setValue('purity', Number(k.purity)); }}>
                      {vaultKarats.map((k) => <MenuItem key={k.code} value={k.code}>{k.code} · {k.metalType === 'SILVER' ? 'Silver' : 'Gold'}</MenuItem>)}
                    </TextField>
                  )} />
              </Grid>
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
          <DialogActions sx={{ p: 2.5 }}><Button onClick={() => setCreateOpen(false)}>Cancel</Button><Button type="submit" variant="contained" disabled={mutation.isPending || vaultKarats.length === 0}>Add to Vault</Button></DialogActions>
        </form>
      </Dialog>
    </Box>
  );
}
