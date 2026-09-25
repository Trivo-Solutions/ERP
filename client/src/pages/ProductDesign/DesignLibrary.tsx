import { useState } from 'react';
import {
  Box, Card, CardContent, Grid, TextField, MenuItem, Button, Typography,
  Table, TableBody, TableCell, TableHead, TableRow, IconButton,
  Dialog, DialogTitle, DialogContent, DialogActions, Chip, Avatar,
  InputAdornment,
} from '@mui/material';
import { Add, Search, Edit, Visibility, FileCopy } from '@mui/icons-material';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm, Controller } from 'react-hook-form';
import { useNavigate } from 'react-router-dom';
import { useSnackbar } from 'notistack';
import { apiGet, apiPost } from '../../api/client';
import { PageHeader } from '../../components/common/PageHeader';
import { StatusChip } from '../../components/common/StatusChip';

const KARATS = ['24K', '22K', '18K', '14K', 'SILVER', 'PT'];

export function DesignLibrary() {
  const navigate = useNavigate();
  const { enqueueSnackbar } = useSnackbar();
  const qc = useQueryClient();
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [createOpen, setCreateOpen] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ['designs', search, statusFilter],
    queryFn: () => apiGet<any>('/designs', { search: search || undefined, status: statusFilter || undefined }),
  });

  const { data: categories } = useQuery({
    queryKey: ['design-categories'],
    queryFn: () => apiGet<any[]>('/settings/design-categories'),
  });

  const { control, handleSubmit, reset, formState: { errors } } = useForm({
    defaultValues: { name: '', categoryId: '', metalKarat: '18K', grossWeightMin: 5, grossWeightMax: 8, netWeightMin: 4, netWeightMax: 7, description: '' },
  });

  const createMutation = useMutation({
    mutationFn: (data: any) => apiPost('/designs', data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['designs'] });
      setCreateOpen(false);
      reset();
      enqueueSnackbar('Design created', { variant: 'success' });
    },
    onError: (err: any) => enqueueSnackbar(err.response?.data?.error ?? 'Failed', { variant: 'error' }),
  });

  const designs = (data as any)?.designs ?? [];

  return (
    <Box>
      <PageHeader
        title="Design Library"
        subtitle="CAD/BOM Vault — Manage all jewelry designs and their specifications"
        breadcrumbs={[{ label: 'Product Design', path: '/designs' }, { label: 'Library' }]}
        actions={[{ label: 'New Design', icon: <Add />, onClick: () => setCreateOpen(true) }]}
      />

      {/* Filters */}
      <Card sx={{ mb: 2 }}>
        <CardContent sx={{ py: 1.5 }}>
          <Grid container spacing={2} alignItems="center">
            <Grid item xs={12} sm={5}>
              <TextField
                fullWidth size="small" placeholder="Search designs..."
                value={search} onChange={(e) => setSearch(e.target.value)}
                InputProps={{ startAdornment: <InputAdornment position="start"><Search fontSize="small" /></InputAdornment> }}
              />
            </Grid>
            <Grid item xs={6} sm={3}>
              <TextField select fullWidth size="small" label="Status" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
                <MenuItem value="">All</MenuItem>
                <MenuItem value="DRAFT">Draft</MenuItem>
                <MenuItem value="APPROVED">Approved</MenuItem>
                <MenuItem value="DISCONTINUED">Discontinued</MenuItem>
              </TextField>
            </Grid>
            <Grid item xs={6} sm={2}>
              <Typography variant="caption" color="text.secondary">
                {(data as any)?.total ?? 0} designs found
              </Typography>
            </Grid>
          </Grid>
        </CardContent>
      </Card>

      {/* Table */}
      <Card>
        <Box sx={{ overflowX: 'auto' }}>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>Design Code</TableCell>
              <TableCell>Name</TableCell>
              <TableCell>Category</TableCell>
              <TableCell>Karat</TableCell>
              <TableCell>Weight Range</TableCell>
              <TableCell>BOM Items</TableCell>
              <TableCell>Status</TableCell>
              <TableCell>Version</TableCell>
              <TableCell>Actions</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {isLoading ? (
              <TableRow><TableCell colSpan={9} align="center" sx={{ py: 4 }}>Loading...</TableCell></TableRow>
            ) : designs.length === 0 ? (
              <TableRow><TableCell colSpan={9} align="center" sx={{ py: 4 }}>No designs found</TableCell></TableRow>
            ) : designs.map((design: any) => (
              <TableRow key={design.id} hover>
                <TableCell>
                  <Typography sx={{ fontFamily: 'monospace', fontWeight: 700, color: '#44C47A', fontSize: 13 }}>
                    {design.designCode}
                  </Typography>
                </TableCell>
                <TableCell sx={{ fontWeight: 600 }}>{design.name}</TableCell>
                <TableCell>
                  <Chip label={design.category?.name} size="small" variant="outlined" />
                </TableCell>
                <TableCell>
                  <Chip label={design.metalKarat} size="small" sx={{ bgcolor: '#FFF8E7', color: '#44C47A', fontWeight: 700 }} />
                </TableCell>
                <TableCell sx={{ fontFamily: 'monospace', fontSize: 12 }}>
                  {Number(design.netWeightMin).toFixed(2)}–{Number(design.netWeightMax).toFixed(2)} g
                </TableCell>
                <TableCell align="center">{design._count?.bomItems ?? 0}</TableCell>
                <TableCell><StatusChip status={design.status} /></TableCell>
                <TableCell>
                  <Chip label={`v${design.version}`} size="small" variant="outlined" sx={{ fontFamily: 'monospace' }} />
                </TableCell>
                <TableCell>
                  <IconButton size="small" onClick={() => navigate(`/designs/${design.id}`)} title="View / Edit">
                    <Visibility fontSize="small" />
                  </IconButton>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        </Box>
      </Card>

      {/* Create Dialog */}
      <Dialog open={createOpen} onClose={() => setCreateOpen(false)} maxWidth="sm" fullWidth>
        <form onSubmit={handleSubmit((d) => createMutation.mutate(d))}>
          <DialogTitle sx={{ fontWeight: 700 }}>New Design</DialogTitle>
          <DialogContent sx={{ pt: 2 }}>
            <Grid container spacing={2}>
              <Grid item xs={12}>
                <Controller name="name" control={control} rules={{ required: true }}
                  render={({ field }) => <TextField {...field} fullWidth label="Design Name" error={!!errors.name} helperText={errors.name && 'Required'} />} />
              </Grid>
              <Grid item xs={6}>
                <Controller name="categoryId" control={control} rules={{ required: true }}
                  render={({ field }) => (
                    <TextField {...field} select fullWidth label="Category" error={!!errors.categoryId}>
                      {(categories ?? []).map((c: any) => <MenuItem key={c.id} value={c.id}>{c.name}</MenuItem>)}
                    </TextField>
                  )} />
              </Grid>
              <Grid item xs={6}>
                <Controller name="metalKarat" control={control}
                  render={({ field }) => (
                    <TextField {...field} select fullWidth label="Karat">
                      {KARATS.map((k) => <MenuItem key={k} value={k}>{k}</MenuItem>)}
                    </TextField>
                  )} />
              </Grid>
              <Grid item xs={6}>
                <Controller name="grossWeightMin" control={control}
                  render={({ field }) => <TextField {...field} fullWidth label="Gross Wt Min (g)" type="number" inputProps={{ step: 0.001 }} />} />
              </Grid>
              <Grid item xs={6}>
                <Controller name="grossWeightMax" control={control}
                  render={({ field }) => <TextField {...field} fullWidth label="Gross Wt Max (g)" type="number" inputProps={{ step: 0.001 }} />} />
              </Grid>
              <Grid item xs={6}>
                <Controller name="netWeightMin" control={control}
                  render={({ field }) => <TextField {...field} fullWidth label="Net Wt Min (g)" type="number" inputProps={{ step: 0.001 }} />} />
              </Grid>
              <Grid item xs={6}>
                <Controller name="netWeightMax" control={control}
                  render={({ field }) => <TextField {...field} fullWidth label="Net Wt Max (g)" type="number" inputProps={{ step: 0.001 }} />} />
              </Grid>
              <Grid item xs={12}>
                <Controller name="description" control={control}
                  render={({ field }) => <TextField {...field} fullWidth label="Description" multiline rows={2} />} />
              </Grid>
            </Grid>
          </DialogContent>
          <DialogActions sx={{ p: 2.5 }}>
            <Button onClick={() => setCreateOpen(false)}>Cancel</Button>
            <Button type="submit" variant="contained" disabled={createMutation.isPending}>
              {createMutation.isPending ? 'Creating...' : 'Create Design'}
            </Button>
          </DialogActions>
        </form>
      </Dialog>
    </Box>
  );
}
