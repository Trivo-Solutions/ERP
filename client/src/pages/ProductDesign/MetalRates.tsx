import { Box, Card, CardContent, Grid, TextField, MenuItem, Button, Table, TableHead, TableBody, TableRow, TableCell, Typography } from '@mui/material';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm, Controller } from 'react-hook-form';
import { useSnackbar } from 'notistack';
import { apiGet, apiPost } from '../../api/client';
import { PageHeader } from '../../components/common/PageHeader';

export function MetalRates() {
  const { enqueueSnackbar } = useSnackbar();
  const qc = useQueryClient();

  const { data: rates } = useQuery({
    queryKey: ['metal-rates'],
    queryFn: () => apiGet<any[]>('/designs/rates/latest'),
  });

  const { data: karats } = useQuery({
    queryKey: ['karats'],
    queryFn: () => apiGet<any[]>('/masters/karats'),
  });
  const KARATS = (karats ?? []).map((k) => k.code);

  const { control, handleSubmit, reset } = useForm({
    defaultValues: { date: new Date().toISOString().split('T')[0], karat: '22K', ratePerGram: 0, source: 'MANUAL' },
  });

  const mutation = useMutation({
    mutationFn: (data: any) => apiPost('/designs/rates', { ...data, date: new Date(data.date) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['metal-rates'] });
      reset();
      enqueueSnackbar('Rate updated', { variant: 'success' });
    },
  });

  const latestByKarat: Record<string, any> = {};
  (rates ?? []).forEach((r: any) => {
    if (!latestByKarat[r.karat]) latestByKarat[r.karat] = r;
  });

  return (
    <Box>
      <PageHeader title="Daily Metal Rates" subtitle="Update morning gold rates used for cost estimation"
        breadcrumbs={[{ label: 'Product Design', path: '/designs' }, { label: 'Metal Rates' }]} />

      <Grid container spacing={2}>
        {/* Current Rates */}
        <Grid item xs={12} md={8}>
          <Card>
            <CardContent>
              <Typography variant="subtitle1" fontWeight={700} gutterBottom>Current Rates</Typography>
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>Karat</TableCell>
                    <TableCell>Purity</TableCell>
                    <TableCell align="right">Rate / Gram (₹)</TableCell>
                    <TableCell>Date</TableCell>
                    <TableCell>Source</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {KARATS.map((karat) => {
                    const r = latestByKarat[karat];
                    return (
                      <TableRow key={karat} hover>
                        <TableCell sx={{ fontWeight: 700 }}>{karat}</TableCell>
                        <TableCell sx={{ fontFamily: 'monospace' }}>{r ? `${(Number(r.purity) * 100).toFixed(2)}%` : '—'}</TableCell>
                        <TableCell align="right" sx={{ fontFamily: 'monospace', fontWeight: 700, color: '#44C47A', fontSize: 15 }}>
                          {r ? `₹${Number(r.ratePerGram).toLocaleString('en-IN', { minimumFractionDigits: 2 })}` : '—'}
                        </TableCell>
                        <TableCell sx={{ fontSize: 12 }}>{r ? new Date(r.date).toLocaleDateString('en-IN') : '—'}</TableCell>
                        <TableCell>{r?.source ?? '—'}</TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </Grid>

        {/* Update Form */}
        <Grid item xs={12} md={4}>
          <Card>
            <CardContent>
              <Typography variant="subtitle1" fontWeight={700} gutterBottom>Update Today's Rate</Typography>
              <form onSubmit={handleSubmit((d) => mutation.mutate(d))}>
                <Grid container spacing={2}>
                  <Grid item xs={12}>
                    <Controller name="date" control={control}
                      render={({ field }) => <TextField {...field} fullWidth label="Date" type="date" InputLabelProps={{ shrink: true }} />} />
                  </Grid>
                  <Grid item xs={12}>
                    <Controller name="karat" control={control}
                      render={({ field }) => (
                        <TextField {...field} select fullWidth label="Karat">
                          {KARATS.map((k) => <MenuItem key={k} value={k}>{k}</MenuItem>)}
                        </TextField>
                      )} />
                  </Grid>
                  <Grid item xs={12}>
                    <Controller name="ratePerGram" control={control}
                      render={({ field }) => (
                        <TextField {...field} fullWidth label="Rate per Gram (₹)" type="number"
                          inputProps={{ step: 0.01 }} />
                      )} />
                  </Grid>
                  <Grid item xs={12}>
                    <Controller name="source" control={control}
                      render={({ field }) => (
                        <TextField {...field} select fullWidth label="Source">
                          <MenuItem value="MANUAL">Manual Entry</MenuItem>
                          <MenuItem value="MCX">MCX Exchange</MenuItem>
                          <MenuItem value="IBJA">IBJA Rate</MenuItem>
                          <MenuItem value="API">API Feed</MenuItem>
                        </TextField>
                      )} />
                  </Grid>
                  <Grid item xs={12}>
                    <Button type="submit" fullWidth variant="contained" disabled={mutation.isPending}>
                      {mutation.isPending ? 'Updating...' : 'Update Rate'}
                    </Button>
                  </Grid>
                </Grid>
              </form>
            </CardContent>
          </Card>
        </Grid>
      </Grid>
    </Box>
  );
}
