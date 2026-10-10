import { Button, Dialog, DialogActions, DialogContent, DialogTitle, Grid, TextField } from '@mui/material';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm, Controller } from 'react-hook-form';
import { useSnackbar } from 'notistack';
import { apiPost, apiPatch } from '../../api/client';
import { SelectField } from '../fields/SelectField';

export const SUPPLIER_TYPES = ['METAL_REFINER', 'STONE_DEALER', 'FINDINGS_VENDOR', 'KARIGAR', 'OTHER'];

const BLANK = {
  name: '', type: 'METAL_REFINER', gstNumber: '', panNumber: '', contactName: '', phone: '', email: '',
  address: '', city: '', state: '', pincode: '',
};

// The one Add Supplier form — used by the Suppliers page and by the PO screen's "+" beside the Supplier field.
// `onCreated` gets the saved supplier so a caller (the PO form) can select it straight away.
export function AddSupplierDialog({ open, onClose, onCreated, supplier }: {
  open: boolean; onClose: () => void; onCreated?: (supplier: any) => void;
  /** When given, the dialog edits this supplier (PATCH) instead of creating one. */
  supplier?: any;
}) {
  const { enqueueSnackbar } = useSnackbar();
  const qc = useQueryClient();
  const isEdit = !!supplier;
  const { control, handleSubmit, reset } = useForm({
    defaultValues: BLANK,
    values: supplier ? Object.fromEntries(Object.keys(BLANK).map((k) => [k, supplier[k] ?? ''])) as typeof BLANK : undefined,
  });

  const editMutation = useMutation({
    // On edit a cleared field is sent as null so it can actually be blanked.
    mutationFn: (data: typeof BLANK) => apiPatch<any>(
      `/procurement/suppliers/${supplier.id}`,
      Object.fromEntries(Object.entries(data).map(([k, v]) => [k, v.trim() === '' && k !== 'name' && k !== 'type' ? null : v.trim()])),
    ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['suppliers'] });
      onClose();
      enqueueSnackbar('Supplier updated', { variant: 'success' });
    },
    onError: (e: any) => enqueueSnackbar(e.response?.data?.error ?? 'Failed', { variant: 'error' }),
  });

  const mutation = useMutation({
    // Blank optional fields are left out rather than saved as empty strings.
    mutationFn: (data: typeof BLANK) => apiPost<any>(
      '/procurement/suppliers',
      Object.fromEntries(Object.entries(data).filter(([k, v]) => k === 'name' || k === 'type' || v.trim() !== '')),
    ),
    onSuccess: (supplier) => {
      // Put the new supplier in the cached list first, so a select that is handed its id right away already has
      // the option to show; the invalidate then brings in the server's copy (e.g. its live payable).
      qc.setQueryData<any[]>(['suppliers'], (old) => [...(old ?? []), supplier]);
      qc.invalidateQueries({ queryKey: ['suppliers'] });
      reset();
      onClose();
      enqueueSnackbar('Supplier added', { variant: 'success' });
      onCreated?.(supplier);
    },
    onError: (e: any) => enqueueSnackbar(e.response?.data?.error ?? 'Failed', { variant: 'error' }),
  });

  const handleClose = () => { if (!isEdit) reset(); onClose(); };

  return (
    <Dialog open={open} onClose={handleClose} maxWidth="sm" fullWidth>
      {/* stopPropagation: React bubbles a portal's events to its React parent, so without it Save here would also
          submit a PO form this dialog is opened from. */}
      <form onSubmit={(e) => { e.stopPropagation(); handleSubmit((d) => (isEdit ? editMutation : mutation).mutate(d))(e); }}>
        <DialogTitle fontWeight={700}>{isEdit ? 'Edit Supplier' : 'Add Supplier'}</DialogTitle>
        <DialogContent sx={{ pt: 2 }}>
          <Grid container spacing={2} sx={{ pt: 1 }}>
            <Grid item xs={8}>
              <Controller name="name" control={control} rules={{ required: true }}
                render={({ field, fieldState }) => (
                  <TextField {...field} fullWidth autoFocus required label="Company Name" error={!!fieldState.error} />
                )} />
            </Grid>
            <Grid item xs={4}>
              <Controller name="type" control={control}
                render={({ field }) => (
                  <SelectField {...field} label="Type" options={SUPPLIER_TYPES.map((t) => ({ value: t, label: t }))} />
                )} />
            </Grid>
            <Grid item xs={6}>
              <Controller name="gstNumber" control={control}
                render={({ field }) => <TextField {...field} fullWidth label="GSTIN" />} />
            </Grid>
            <Grid item xs={6}>
              <Controller name="panNumber" control={control}
                render={({ field }) => <TextField {...field} fullWidth label="PAN" />} />
            </Grid>
            <Grid item xs={6}>
              <Controller name="contactName" control={control}
                render={({ field }) => <TextField {...field} fullWidth label="Contact Person" />} />
            </Grid>
            <Grid item xs={6}>
              <Controller name="phone" control={control}
                render={({ field }) => <TextField {...field} fullWidth label="Phone" />} />
            </Grid>
            <Grid item xs={12}>
              <Controller name="email" control={control}
                render={({ field }) => <TextField {...field} fullWidth label="Email" type="email" />} />
            </Grid>
            <Grid item xs={12}>
              <Controller name="address" control={control}
                render={({ field }) => <TextField {...field} fullWidth label="Address" />} />
            </Grid>
            <Grid item xs={4}>
              <Controller name="city" control={control}
                render={({ field }) => <TextField {...field} fullWidth label="City" />} />
            </Grid>
            <Grid item xs={5}>
              <Controller name="state" control={control}
                render={({ field }) => <TextField {...field} fullWidth label="State" helperText="Used for CGST/SGST vs IGST when GSTIN is blank" />} />
            </Grid>
            <Grid item xs={3}>
              <Controller name="pincode" control={control}
                render={({ field }) => <TextField {...field} fullWidth label="Pincode" />} />
            </Grid>
          </Grid>
        </DialogContent>
        <DialogActions sx={{ p: 2.5 }}>
          <Button onClick={handleClose}>Cancel</Button>
          <Button type="submit" variant="contained" disabled={mutation.isPending || editMutation.isPending}>Save</Button>
        </DialogActions>
      </form>
    </Dialog>
  );
}
