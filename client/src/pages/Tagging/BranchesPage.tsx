import { useState } from 'react';
import {
  Box, Card, Table, TableHead, TableBody, TableRow, TableCell, Typography,
  Button, Grid, Dialog, DialogTitle, DialogContent, DialogActions,
  TextField, Chip, Switch, FormControlLabel, IconButton,
} from '@mui/material';
import { Add, Edit } from '@mui/icons-material';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm, Controller } from 'react-hook-form';
import { useSnackbar } from 'notistack';
import { apiGet, apiPost, apiPatch } from '../../api/client';
import { PageHeader } from '../../components/common/PageHeader';

function BranchDialog({
  open, branch, onClose,
}: { open: boolean; branch?: any; onClose: () => void }) {
  const { enqueueSnackbar } = useSnackbar();
  const qc = useQueryClient();
  const isEdit = !!branch;

  const { control, handleSubmit, reset } = useForm({
    defaultValues: {
      name: branch?.name ?? '',
      address: branch?.address ?? '',
      city: branch?.city ?? '',
      state: branch?.state ?? '',
      phone: branch?.phone ?? '',
      email: branch?.email ?? '',
      managerName: branch?.managerName ?? '',
      isHeadOffice: branch?.isHeadOffice ?? false,
      isActive: branch?.isActive ?? true,
    },
  });

  const mutation = useMutation({
    mutationFn: (data: any) =>
      isEdit ? apiPatch(`/tagging/branches/${branch.id}`, data) : apiPost('/tagging/branches', data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['branches'] });
      enqueueSnackbar(isEdit ? 'Branch updated' : 'Branch created', { variant: 'success' });
      onClose();
      reset();
    },
    onError: (e: any) => enqueueSnackbar(e.response?.data?.error ?? 'Failed', { variant: 'error' }),
  });

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <form onSubmit={handleSubmit((d) => mutation.mutate(d))}>
        <DialogTitle fontWeight={700}>{isEdit ? 'Edit Branch' : 'Add Branch'}</DialogTitle>
        <DialogContent sx={{ pt: 2 }}>
          <Grid container spacing={2}>
            <Grid item xs={12}>
              <Controller name="name" control={control} rules={{ required: true }}
                render={({ field, fieldState }) => (
                  <TextField {...field} fullWidth label="Branch Name" error={!!fieldState.error} />
                )} />
            </Grid>
            <Grid item xs={12}>
              <Controller name="address" control={control}
                render={({ field }) => <TextField {...field} fullWidth label="Address" />} />
            </Grid>
            <Grid item xs={6}>
              <Controller name="city" control={control}
                render={({ field }) => <TextField {...field} fullWidth label="City" />} />
            </Grid>
            <Grid item xs={6}>
              <Controller name="state" control={control}
                render={({ field }) => <TextField {...field} fullWidth label="State" />} />
            </Grid>
            <Grid item xs={6}>
              <Controller name="phone" control={control}
                render={({ field }) => <TextField {...field} fullWidth label="Phone" />} />
            </Grid>
            <Grid item xs={6}>
              <Controller name="email" control={control}
                render={({ field }) => <TextField {...field} fullWidth label="Email" type="email" />} />
            </Grid>
            <Grid item xs={12}>
              <Controller name="managerName" control={control}
                render={({ field }) => <TextField {...field} fullWidth label="Manager Name" />} />
            </Grid>
            <Grid item xs={6}>
              <Controller name="isHeadOffice" control={control}
                render={({ field }) => (
                  <FormControlLabel control={<Switch checked={field.value} onChange={(e) => field.onChange(e.target.checked)} />}
                    label="Head Office" />
                )} />
            </Grid>
            {isEdit && (
              <Grid item xs={6}>
                <Controller name="isActive" control={control}
                  render={({ field }) => (
                    <FormControlLabel control={<Switch checked={field.value} onChange={(e) => field.onChange(e.target.checked)} />}
                      label="Active" />
                  )} />
              </Grid>
            )}
          </Grid>
        </DialogContent>
        <DialogActions sx={{ p: 2.5 }}>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="contained" disabled={mutation.isPending}>
            {isEdit ? 'Save' : 'Create'}
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  );
}

export function BranchesPage() {
  const [dialog, setDialog] = useState<{ open: boolean; branch?: any }>({ open: false });

  const { data, isLoading } = useQuery({
    queryKey: ['branches'],
    queryFn: () => apiGet<any>('/tagging/branches'),
  });
  const branches: any[] = (data as any)?.data ?? data ?? [];

  return (
    <Box>
      <PageHeader title="Branches"
        actions={[{ label: 'Add Branch', icon: <Add />, onClick: () => setDialog({ open: true }) }]} />

      <Card>
        <Box sx={{ overflowX: 'auto' }}>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>Code</TableCell>
              <TableCell>Name</TableCell>
              <TableCell>City</TableCell>
              <TableCell>Manager</TableCell>
              <TableCell>Phone</TableCell>
              <TableCell>Type</TableCell>
              <TableCell>Status</TableCell>
              <TableCell />
            </TableRow>
          </TableHead>
          <TableBody>
            {isLoading ? (
              <TableRow><TableCell colSpan={8} align="center" sx={{ py: 4 }}>Loading...</TableCell></TableRow>
            ) : branches.map((b: any) => (
              <TableRow key={b.id} hover>
                <TableCell sx={{ fontFamily: 'monospace', fontWeight: 700, color: '#44C47A', fontSize: 12 }}>{b.branchCode}</TableCell>
                <TableCell sx={{ fontWeight: 600 }}>{b.name}</TableCell>
                <TableCell>{b.city ?? '—'}</TableCell>
                <TableCell>{b.managerName ?? '—'}</TableCell>
                <TableCell>{b.phone ?? '—'}</TableCell>
                <TableCell>
                  {b.isHeadOffice && <Chip label="Head Office" size="small" color="primary" />}
                </TableCell>
                <TableCell>
                  <Chip label={b.isActive ? 'Active' : 'Inactive'} size="small"
                    color={b.isActive ? 'success' : 'default'} />
                </TableCell>
                <TableCell align="right">
                  <IconButton size="small" onClick={() => setDialog({ open: true, branch: b })}>
                    <Edit fontSize="small" />
                  </IconButton>
                </TableCell>
              </TableRow>
            ))}
            {!isLoading && branches.length === 0 && (
              <TableRow><TableCell colSpan={8} align="center" sx={{ py: 4 }}>No branches yet</TableCell></TableRow>
            )}
          </TableBody>
        </Table>
        </Box>
      </Card>

      <BranchDialog open={dialog.open} branch={dialog.branch} onClose={() => setDialog({ open: false })} />
    </Box>
  );
}
