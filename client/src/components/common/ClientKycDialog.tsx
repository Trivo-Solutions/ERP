import { useEffect } from 'react';
import { Alert, Button, Checkbox, Dialog, DialogActions, DialogContent, DialogTitle, FormControlLabel, Stack, TextField, Typography } from '@mui/material';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Controller, useForm } from 'react-hook-form';
import { useSnackbar } from 'notistack';
import { apiPatch } from '../../api/client';

// PAN / Form 60 for a customer — what the law asks for on a sale above ₹2,00,000 (Rule 114B). One small
// dialog used wherever a sale is blocked for want of it (the billing screen) and from the Clients page,
// so the counter never has to leave what it is doing to fix a client's record.
export function ClientKycDialog({ client, onClose, onSaved }: {
  client: { id: string; name: string; panNumber?: string | null; form60Received?: boolean; gstNumber?: string | null } | null;
  onClose: () => void;
  onSaved?: (updated: any) => void;
}) {
  const { enqueueSnackbar } = useSnackbar();
  const qc = useQueryClient();
  const { control, handleSubmit, reset } = useForm({ defaultValues: { panNumber: '', form60Received: false } });

  useEffect(() => {
    if (client) reset({ panNumber: client.panNumber ?? '', form60Received: !!client.form60Received });
  }, [client, reset]);

  const mutation = useMutation({
    mutationFn: (d: { panNumber: string; form60Received: boolean }) =>
      apiPatch<any>(`/orders/clients/${client!.id}`, { panNumber: d.panNumber.trim().toUpperCase(), form60Received: d.form60Received }),
    onSuccess: (updated) => {
      qc.invalidateQueries({ queryKey: ['clients'] });
      qc.invalidateQueries({ queryKey: ['clients-list'] });
      enqueueSnackbar('KYC saved', { variant: 'success' });
      onSaved?.(updated);
      onClose();
    },
    onError: (e: any) => enqueueSnackbar(e.response?.data?.error ?? 'Failed to save', { variant: 'error' }),
  });

  return (
    <Dialog open={!!client} onClose={onClose} maxWidth="xs" fullWidth>
      <form onSubmit={handleSubmit((d) => mutation.mutate(d))}>
        <DialogTitle fontWeight={700}>PAN / Form 60</DialogTitle>
        <DialogContent>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>{client?.name}</Typography>
          <Stack spacing={2}>
            <Controller name="panNumber" control={control}
              rules={{ pattern: { value: /^[A-Za-z]{5}[0-9]{4}[A-Za-z]$/, message: 'PAN looks like ABCDE1234F' } }}
              render={({ field, fieldState }) => (
                <TextField {...field} fullWidth autoFocus label="PAN" inputProps={{ maxLength: 10, style: { textTransform: 'uppercase' } }}
                  error={!!fieldState.error} helperText={fieldState.error?.message ?? 'Leave blank if the customer has none'} />
              )} />
            <Controller name="form60Received" control={control}
              render={({ field }) => (
                <FormControlLabel control={<Checkbox checked={field.value} onChange={(e) => field.onChange(e.target.checked)} />}
                  label="Form 60 received (customer has no PAN)" />
              )} />
            {client?.gstNumber && (
              <Alert severity="info" sx={{ py: 0 }}>A GSTIN already carries the holder's PAN, so a registered dealer needs nothing more here.</Alert>
            )}
          </Stack>
        </DialogContent>
        <DialogActions sx={{ p: 2 }}>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="contained" disabled={mutation.isPending}>Save</Button>
        </DialogActions>
      </form>
    </Dialog>
  );
}
