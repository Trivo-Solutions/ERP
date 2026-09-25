import { useState } from 'react';
import { Box, Card, CardContent, Grid, TextField, MenuItem, Button, Typography, Alert, Divider } from '@mui/material';
import { Send, KeyboardReturn } from '@mui/icons-material';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm, Controller } from 'react-hook-form';
import { useSnackbar } from 'notistack';
import { apiGet, apiPost } from '../../api/client';
import { PageHeader } from '../../components/common/PageHeader';
import { useScaleReading } from '../../hooks/useSocket';
import { useUiStore } from '../../store/ui.store';

export function KarigarTransactions() {
  const { enqueueSnackbar } = useSnackbar();
  const qc = useQueryClient();
  const { scaleDevice } = useUiStore();
  const [scaleWeight, setScaleWeight] = useState<number | null>(null);
  const [lastResult, setLastResult] = useState<any>(null);

  useScaleReading(scaleDevice, (w) => setScaleWeight(w));

  const { data: artisans } = useQuery({ queryKey: ['artisans'], queryFn: () => apiGet<any[]>('/outsourcing/artisans') });

  const issueForm = useForm({ defaultValues: { artisanId: '', metalType: 'GOLD', karat: '22K', issuedWeight: 0, notes: '' } });
  const returnForm = useForm({ defaultValues: { artisanId: '', metalType: 'GOLD', returnedWeight: 0, scrapWeight: 0, jobCardRef: '', notes: '' } });

  const issueMutation = useMutation({
    mutationFn: (data: any) => apiPost('/outsourcing/issue', data),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['artisans'] }); issueForm.reset(); enqueueSnackbar('Metal issued to artisan', { variant: 'success' }); },
  });

  const returnMutation = useMutation({
    mutationFn: (data: any) => apiPost('/outsourcing/return', data),
    onSuccess: (result: any) => { qc.invalidateQueries({ queryKey: ['artisans'] }); setLastResult(result); returnForm.reset(); enqueueSnackbar('Return recorded', { variant: 'success' }); },
  });

  return (
    <Box>
      <PageHeader title="Issue / Return Metal" subtitle="Record metal issues to artisans and return with loss calculation"
        breadcrumbs={[{ label: 'Outsourcing', path: '/outsourcing/ledger' }, { label: 'Transactions' }]} />

      {scaleWeight !== null && <Alert severity="info" sx={{ mb: 2 }}>Live Scale: <strong>{scaleWeight.toFixed(4)} g</strong></Alert>}

      <Grid container spacing={3}>
        {/* Issue */}
        <Grid item xs={12} md={6}>
          <Card>
            <CardContent>
              <Typography variant="subtitle1" fontWeight={700} sx={{ mb: 2, display: 'flex', alignItems: 'center', gap: 1 }}>
                <Send fontSize="small" /> Issue Metal to Karigar
              </Typography>
              <form onSubmit={issueForm.handleSubmit((d) => issueMutation.mutate(d))}>
                <Grid container spacing={2}>
                  <Grid item xs={12}><Controller name="artisanId" control={issueForm.control} rules={{ required: true }} render={({ field }) => <TextField {...field} select fullWidth label="Artisan">{(artisans ?? []).map((a: any) => <MenuItem key={a.id} value={a.id}>{a.artisanCode} — {a.name}</MenuItem>)}</TextField>} /></Grid>
                  <Grid item xs={6}><Controller name="karat" control={issueForm.control} render={({ field }) => <TextField {...field} select fullWidth label="Karat"><MenuItem value="24K">24K</MenuItem><MenuItem value="22K">22K</MenuItem><MenuItem value="18K">18K</MenuItem></TextField>} /></Grid>
                  <Grid item xs={6}><Controller name="issuedWeight" control={issueForm.control} rules={{ required: true }} render={({ field }) => <TextField {...field} fullWidth label="Weight (g)" type="number" inputProps={{ step: 0.001 }} InputProps={{ endAdornment: scaleWeight && <Button size="small" onClick={() => issueForm.setValue('issuedWeight', scaleWeight)}>←</Button> }} />} /></Grid>
                  <Grid item xs={12}><Controller name="notes" control={issueForm.control} render={({ field }) => <TextField {...field} fullWidth label="Notes / Job Card Ref" />} /></Grid>
                  <Grid item xs={12}><Button type="submit" variant="contained" fullWidth startIcon={<Send />} disabled={issueMutation.isPending}>{issueMutation.isPending ? 'Issuing...' : 'Issue Metal'}</Button></Grid>
                </Grid>
              </form>
            </CardContent>
          </Card>
        </Grid>

        {/* Return */}
        <Grid item xs={12} md={6}>
          <Card>
            <CardContent>
              <Typography variant="subtitle1" fontWeight={700} sx={{ mb: 2, display: 'flex', alignItems: 'center', gap: 1 }}>
                <KeyboardReturn fontSize="small" /> Record Return from Karigar
              </Typography>
              <form onSubmit={returnForm.handleSubmit((d) => returnMutation.mutate(d))}>
                <Grid container spacing={2}>
                  <Grid item xs={12}><Controller name="artisanId" control={returnForm.control} rules={{ required: true }} render={({ field }) => <TextField {...field} select fullWidth label="Artisan">{(artisans ?? []).map((a: any) => <MenuItem key={a.id} value={a.id}>{a.artisanCode} — {a.name} (Balance: {Number(a.metalBalance).toFixed(4)}g)</MenuItem>)}</TextField>} /></Grid>
                  <Grid item xs={6}><Controller name="returnedWeight" control={returnForm.control} rules={{ required: true }} render={({ field }) => <TextField {...field} fullWidth label="Returned Finished (g)" type="number" inputProps={{ step: 0.001 }} InputProps={{ endAdornment: scaleWeight && <Button size="small" onClick={() => returnForm.setValue('returnedWeight', scaleWeight)}>←</Button> }} />} /></Grid>
                  <Grid item xs={6}><Controller name="scrapWeight" control={returnForm.control} render={({ field }) => <TextField {...field} fullWidth label="Scrap / Dust (g)" type="number" inputProps={{ step: 0.001 }} />} /></Grid>
                  <Grid item xs={12}><Controller name="jobCardRef" control={returnForm.control} render={({ field }) => <TextField {...field} fullWidth label="Job Card Reference" />} /></Grid>
                  <Grid item xs={12}><Button type="submit" variant="contained" fullWidth color="success" startIcon={<KeyboardReturn />} disabled={returnMutation.isPending}>{returnMutation.isPending ? 'Recording...' : 'Record Return'}</Button></Grid>
                </Grid>
              </form>

              {lastResult && (
                <Box sx={{ mt: 2, p: 1.5, bgcolor: lastResult.exceedsThreshold ? '#FFF3F3' : '#F0FFF4', borderRadius: 2 }}>
                  <Typography variant="caption" fontWeight={700}>Return Summary:</Typography>
                  <Typography variant="body2">Loss: <strong>{lastResult.lossPercent?.toFixed(2)}%</strong></Typography>
                  {lastResult.exceedsThreshold && <Alert severity="warning" sx={{ mt: 1 }}>Excess loss! Labor deduction: ₹{lastResult.laborDeduction?.toFixed(2)}</Alert>}
                </Box>
              )}
            </CardContent>
          </Card>
        </Grid>
      </Grid>
    </Box>
  );
}
