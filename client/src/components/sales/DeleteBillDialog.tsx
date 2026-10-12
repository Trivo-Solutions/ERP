import { useEffect, useState } from 'react';
import {
  Alert, Box, Button, CircularProgress, Dialog, DialogActions, DialogContent, DialogTitle, Stack, TextField, Typography,
} from '@mui/material';
import { DeleteForever } from '@mui/icons-material';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSnackbar } from 'notistack';
import { apiGet, apiPost } from '../../api/client';

// "Delete bill" (permission invoice:delete). The server does the real work and is authoritative: it reverses every live
// receipt, then voids the bill - the bill stays on record as VOID, stock and ledger go back where they were, and it is audited.
// This dialog only explains that, asks for the mandatory reason, and shows the server's answer. The button that opens it is
// permission-gated, but hiding a button is not the security: POST /sales/invoices/:id/delete re-checks invoice:delete.

export const MIN_REASON = 3;

export interface BillFacts {
  invoiceNumber: string;
  status: string;
  clientName?: string;
  totalAmount: number;
  livePayments: number;     // receipts not yet reversed
  livePaid: number;
  returns: number;
  creditNotes: number;
  irn?: string | null;
}

/** Why this bill cannot be deleted from the screen (empty = it can be tried). Mirrors the server's own up-front checks. */
export function deleteBlockers(f: BillFacts): string[] {
  const out: string[] = [];
  if (f.status === 'VOID') out.push('This bill has already been deleted (voided).');
  if (f.returns > 0) out.push('A return has been recorded against this bill, so it cannot be deleted.');
  if (f.creditNotes > 0) out.push('A credit note has been issued against this bill, so it cannot be deleted.');
  if (f.irn) out.push('An e-invoice (IRN) exists for this bill. Cancel the IRN on the GST portal first.');
  return out;
}

const money = (n: number) => '₹' + Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });

/** The dialog's content, with no data fetching - so it can be rendered and tested on its own. */
export function DeleteBillBody({ facts, reason, onReason, error }: {
  facts: BillFacts; reason: string; onReason: (v: string) => void; error?: string;
}) {
  const blockers = deleteBlockers(facts);
  return (
    <Stack spacing={1.5}>
      <Typography variant="body2">
        Delete bill <b style={{ fontFamily: 'monospace' }}>{facts.invoiceNumber}</b>
        {facts.clientName ? <> for <b>{facts.clientName}</b></> : null} ({money(facts.totalAmount)})?
      </Typography>

      {blockers.length > 0 ? (
        <Alert severity="error" role="alert">
          {blockers.map((b) => <div key={b}>{b}</div>)}
        </Alert>
      ) : (
        <>
          <Alert severity="warning" icon={false} sx={{ '& ul': { m: 0, pl: 2.5 } }}>
            <b>What happens</b>
            <ul>
              {facts.livePayments > 0 && (
                <li>{facts.livePayments} receipt{facts.livePayments > 1 ? 's' : ''} ({money(facts.livePaid)}) will be reversed - money is taken back out of cash / bank.</li>
              )}
              <li>Every piece on the bill goes back into stock.</li>
              <li>The sale, GST and customer balance are reversed in the accounts.</li>
              <li>The bill stays on record marked <b>VOID</b>, and its number is not reused.</li>
            </ul>
            <Box sx={{ mt: 0.5 }}>This cannot be undone.</Box>
          </Alert>
          <TextField
            label="Reason (required)" size="small" fullWidth autoFocus multiline minRows={2} value={reason}
            onChange={(e) => onReason(e.target.value)} inputProps={{ 'aria-label': 'Reason for deleting this bill', maxLength: 500 }}
            helperText={reason.trim().length > 0 && reason.trim().length < MIN_REASON ? `At least ${MIN_REASON} characters` : 'Recorded in the audit trail with your name.'}
          />
        </>
      )}
      {error && <Alert severity="error" role="alert">{error}</Alert>}
    </Stack>
  );
}

export function DeleteBillDialog({ invoiceId, open, onClose, onDeleted }: {
  invoiceId: string; open: boolean; onClose: () => void; onDeleted?: () => void;
}) {
  const { enqueueSnackbar } = useSnackbar();
  const qc = useQueryClient();
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | undefined>();
  useEffect(() => { if (open) { setReason(''); setError(undefined); } }, [open, invoiceId]);

  const { data: invoice, isLoading } = useQuery({
    queryKey: ['invoice-detail', invoiceId], queryFn: () => apiGet<any>(`/sales/invoices/${invoiceId}`), enabled: open && !!invoiceId,
  });
  const { data: returns } = useQuery({
    queryKey: ['invoice-returns', invoiceId], queryFn: () => apiGet<any[]>('/sales/returns', { invoiceId }), enabled: open && !!invoiceId,
  });
  const { data: creditNotes } = useQuery({
    queryKey: ['invoice-credit-notes', invoiceId], queryFn: () => apiGet<any[]>('/sales/credit-notes', { invoiceId }), enabled: open && !!invoiceId,
  });

  const mutation = useMutation({
    mutationFn: () => apiPost<any>(`/sales/invoices/${invoiceId}/delete`, { reason: reason.trim() }),
    onSuccess: () => {
      for (const key of ['sales-invoices', 'invoice-detail', 'invoice-returns', 'invoice-credit-notes', 'tags', 'stock', 'clients']) {
        qc.invalidateQueries({ queryKey: [key] });
      }
      enqueueSnackbar('Bill deleted (voided) and its stock and accounts reversed', { variant: 'success' });
      onDeleted?.();
      onClose();
    },
    onError: (err: any) => setError(err.response?.data?.error ?? 'Could not delete the bill'),
  });

  const livePayments = (invoice?.payments ?? []).filter((p: any) => !p.reversedAt);
  const facts: BillFacts | null = invoice ? {
    invoiceNumber: invoice.invoiceNumber, status: invoice.status, clientName: invoice.client?.name,
    totalAmount: Number(invoice.totalAmount), livePayments: livePayments.length,
    livePaid: livePayments.reduce((s: number, p: any) => s + Number(p.amount), 0),
    returns: (returns ?? []).length, creditNotes: (creditNotes ?? []).filter((c: any) => c.status !== 'CANCELLED').length,
    irn: invoice.taxDetails?.irn ?? null,
  } : null;
  const blocked = !facts || deleteBlockers(facts).length > 0;
  const canSubmit = !blocked && reason.trim().length >= MIN_REASON && !mutation.isPending;

  return (
    <Dialog open={open} onClose={mutation.isPending ? undefined : onClose} maxWidth="xs" fullWidth>
      <DialogTitle>Delete bill</DialogTitle>
      <DialogContent>
        {isLoading || !facts ? <Box sx={{ display: 'flex', justifyContent: 'center', py: 3 }}><CircularProgress size={24} /></Box>
          : <DeleteBillBody facts={facts} reason={reason} onReason={setReason} error={error} />}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={mutation.isPending}>Cancel</Button>
        <Button color="error" variant="contained" startIcon={<DeleteForever />} disabled={!canSubmit} onClick={() => mutation.mutate()}>
          {mutation.isPending ? 'Deleting…' : 'Delete bill'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
