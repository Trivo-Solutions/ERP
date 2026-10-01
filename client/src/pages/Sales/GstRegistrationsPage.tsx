import { useState } from 'react';
import {
  Box, Card, Table, TableHead, TableBody, TableRow, TableCell, Button, Grid, Dialog,
  DialogTitle, DialogContent, DialogActions, TextField, Chip, Switch, FormControlLabel, IconButton,
} from '@mui/material';
import { Add, Edit } from '@mui/icons-material';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm, Controller } from 'react-hook-form';
import { useSnackbar } from 'notistack';
import { apiGet, apiPost, apiPut, apiPatch } from '../../api/client';
import { PageHeader } from '../../components/common/PageHeader';
import { PermissionGate } from '../../components/auth/PermissionGate';
import { useAuthStore } from '../../store/auth.store';

// G1 Part K — GST Registration admin. One company may hold several registrations (multi-GSTIN
// support, CLAUDE.md §3); exactly one is ever isPrimary — that is the one createInvoice falls
// back to when a branch has no explicit registration link (see Branches page's own dropdown).

function GstRegistrationDialog({ open, registration, onClose }: { open: boolean; registration?: any; onClose: () => void }) {
  const { enqueueSnackbar } = useSnackbar();
  const qc = useQueryClient();
  const isEdit = !!registration;

  const { control, handleSubmit } = useForm({
    defaultValues: {
      gstin: registration?.gstin ?? '', legalName: registration?.legalName ?? '',
      tradeName: registration?.tradeName ?? '', stateCode: registration?.stateCode ?? '',
      address: registration?.address ?? '', city: registration?.city ?? '',
      district: registration?.district ?? '', pincode: registration?.pincode ?? '',
      isPrimary: registration?.isPrimary ?? false, isActive: registration?.isActive ?? true,
    },
  });

  const mutation = useMutation({
    mutationFn: (data: any) =>
      isEdit ? apiPut(`/company/gst-registrations/${registration.id}`, data) : apiPost('/company/gst-registrations', data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['gst-registrations'] });
      enqueueSnackbar(isEdit ? 'GST registration updated' : 'GST registration created', { variant: 'success' });
      onClose();
    },
    onError: (e: any) => enqueueSnackbar(e.response?.data?.error ?? 'Failed', { variant: 'error' }),
  });

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <form onSubmit={handleSubmit((d) => mutation.mutate(d))}>
        <DialogTitle fontWeight={700}>{isEdit ? 'Edit GST Registration' : 'Add GST Registration'}</DialogTitle>
        <DialogContent sx={{ pt: 2 }}>
          <Grid container spacing={2}>
            <Grid item xs={6}>
              <Controller name="gstin" control={control} rules={{ required: true, minLength: 15, maxLength: 15 }}
                render={({ field, fieldState }) => (
                  <TextField {...field} fullWidth label="GSTIN" error={!!fieldState.error}
                    helperText={fieldState.error ? '15 characters, standard format' : ''} inputProps={{ maxLength: 15 }} />
                )} />
            </Grid>
            <Grid item xs={6}>
              <Controller name="stateCode" control={control} rules={{ required: true }}
                render={({ field }) => <TextField {...field} fullWidth label="State Code (2-digit)" inputProps={{ maxLength: 2 }} />} />
            </Grid>
            <Grid item xs={12}>
              <Controller name="legalName" control={control} rules={{ required: true }}
                render={({ field, fieldState }) => <TextField {...field} fullWidth label="Legal Name" error={!!fieldState.error} />} />
            </Grid>
            <Grid item xs={12}>
              <Controller name="tradeName" control={control}
                render={({ field }) => <TextField {...field} fullWidth label="Trade Name (optional)" />} />
            </Grid>
            <Grid item xs={12}>
              <Controller name="address" control={control}
                render={({ field }) => <TextField {...field} fullWidth label="Address" />} />
            </Grid>
            <Grid item xs={4}>
              <Controller name="city" control={control} render={({ field }) => <TextField {...field} fullWidth label="City" />} />
            </Grid>
            <Grid item xs={4}>
              <Controller name="district" control={control} render={({ field }) => <TextField {...field} fullWidth label="District" />} />
            </Grid>
            <Grid item xs={4}>
              <Controller name="pincode" control={control} render={({ field }) => <TextField {...field} fullWidth label="PIN" />} />
            </Grid>
            <Grid item xs={6}>
              <Controller name="isPrimary" control={control}
                render={({ field }) => (
                  <FormControlLabel control={<Switch checked={field.value} onChange={(e) => field.onChange(e.target.checked)} />}
                    label="Primary Registration" />
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
          <Button type="submit" variant="contained" disabled={mutation.isPending}>{isEdit ? 'Save' : 'Create'}</Button>
        </DialogActions>
      </form>
    </Dialog>
  );
}

export function GstRegistrationsPage() {
  const [dialog, setDialog] = useState<{ open: boolean; registration?: any }>({ open: false });
  const { hasPermission } = useAuthStore();
  const qc = useQueryClient();
  const { enqueueSnackbar } = useSnackbar();

  const { data, isLoading } = useQuery({
    queryKey: ['gst-registrations'],
    queryFn: () => apiGet<any>('/company/gst-registrations'),
  });
  const registrations: any[] = (data as any)?.data ?? data ?? [];

  const markPrimary = useMutation({
    mutationFn: (id: string) => apiPatch(`/company/gst-registrations/${id}/status`, { isPrimary: true }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['gst-registrations'] }); enqueueSnackbar('Marked as primary', { variant: 'success' }); },
    onError: (e: any) => enqueueSnackbar(e.response?.data?.error ?? 'Failed', { variant: 'error' }),
  });

  return (
    <Box>
      <PageHeader title="GST Registrations"
        actions={hasPermission('gst:registration_create') ? [{ label: 'Add Registration', icon: <Add />, onClick: () => setDialog({ open: true }) }] : []} />

      <Card>
        <Box sx={{ overflowX: 'auto' }}>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>GSTIN</TableCell>
                <TableCell>Legal Name</TableCell>
                <TableCell>Trade Name</TableCell>
                <TableCell>State</TableCell>
                <TableCell>Primary</TableCell>
                <TableCell>Status</TableCell>
                <TableCell />
              </TableRow>
            </TableHead>
            <TableBody>
              {isLoading ? (
                <TableRow><TableCell colSpan={7} align="center" sx={{ py: 4 }}>Loading...</TableCell></TableRow>
              ) : registrations.map((r: any) => (
                <TableRow key={r.id} hover>
                  <TableCell sx={{ fontFamily: 'monospace', fontWeight: 700 }}>{r.gstin}</TableCell>
                  <TableCell sx={{ fontWeight: 600 }}>{r.legalName}</TableCell>
                  <TableCell>{r.tradeName ?? '—'}</TableCell>
                  <TableCell>{r.stateCode}</TableCell>
                  <TableCell>
                    {r.isPrimary ? <Chip label="Primary" size="small" color="primary" /> : (
                      <PermissionGate permission="gst:registration_manage">
                        <Button size="small" onClick={() => markPrimary.mutate(r.id)}>Mark Primary</Button>
                      </PermissionGate>
                    )}
                  </TableCell>
                  <TableCell><Chip label={r.isActive ? 'Active' : 'Inactive'} size="small" color={r.isActive ? 'success' : 'default'} /></TableCell>
                  <TableCell align="right">
                    <PermissionGate permission="gst:registration_edit">
                      <IconButton size="small" onClick={() => setDialog({ open: true, registration: r })}><Edit fontSize="small" /></IconButton>
                    </PermissionGate>
                  </TableCell>
                </TableRow>
              ))}
              {!isLoading && registrations.length === 0 && (
                <TableRow><TableCell colSpan={7} align="center" sx={{ py: 4 }}>
                  No GST registrations yet — this company still bills under its legacy single Company GSTIN.
                </TableCell></TableRow>
              )}
            </TableBody>
          </Table>
        </Box>
      </Card>

      <GstRegistrationDialog open={dialog.open} registration={dialog.registration} onClose={() => setDialog({ open: false })} />
    </Box>
  );
}
