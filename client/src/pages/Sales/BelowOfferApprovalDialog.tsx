import { useState } from 'react';
import {
  Alert, Box, Button, Chip, Dialog, DialogActions, DialogContent, DialogTitle, Stack, TextField, Typography,
} from '@mui/material';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSnackbar } from 'notistack';
import { apiGet, apiPost } from '../../api/client';

// Offers step 3. The server refused the bill because something on it is priced below an offered rate (or carries an extra
// discount on an offer bill). This dialog asks a store manager for exactly those approvals, shows where each stands, and
// lets the biller save the bill again once every one is approved. The server — not this screen — decides what needs
// approving and whether an approval matches; an approval is single-use and tied to the exact rates, so changing a rate
// after approval simply sends the bill back here for a new one.

export interface ApprovalNeed {
  scope: 'LINE' | 'DISCOUNT';
  rateHash: string;
  tagId?: string;
  offerName?: string;
  amount?: number;
  requested?: { mcRate?: number; vaPercent?: number; rows: { materialId: string; rate: number; code?: string }[] };
  offered?: { mcRate?: number; vaPercent?: number; rows: { materialId: string; rate: number; code?: string }[] };
}

const LIVE = ['PENDING', 'APPROVED'];
const STATUS_COLOR: Record<string, 'default' | 'warning' | 'success' | 'error'> = {
  PENDING: 'warning', APPROVED: 'success', REJECTED: 'error', CANCELLED: 'default', USED: 'default',
};
const STATUS_LABEL: Record<string, string> = {
  PENDING: 'Waiting for a store manager', APPROVED: 'Approved', REJECTED: 'Rejected', CANCELLED: 'Cancelled', USED: 'Already used',
};

/** "Making charge ₹600/g (offer ₹750/g) · Ruby ₹700 (offer ₹800)" - what is below what. */
export function describeRates(requested: NonNullable<ApprovalNeed['requested']>, offered: NonNullable<ApprovalNeed['offered']>): string {
  const parts: string[] = [];
  if (requested.mcRate !== undefined) parts.push(`Making charge ₹${requested.mcRate}/g (offer ₹${offered.mcRate}/g)`);
  if (requested.vaPercent !== undefined) parts.push(`VA ${requested.vaPercent}% (offer ${offered.vaPercent}%)`);
  requested.rows.forEach((r, i) => parts.push(`${r.code ?? 'Material'} ₹${r.rate} (offer ₹${offered.rows[i]?.rate})`));
  return parts.join(' · ');
}

export function BelowOfferApprovalDialog({ open, needs, labelFor, requestBody, ids, setIds, onClose, onSave, saving }: {
  open: boolean;
  needs: ApprovalNeed[];
  /** A human label for a line need's piece (e.g. its tag number). */
  labelFor: (n: ApprovalNeed) => string;
  /** The POST /offers/approvals body for a need, or null if this screen cannot build one. */
  requestBody: (n: ApprovalNeed, reason: string) => object | null;
  /** need.rateHash -> the approval request made for it (kept by the parent so closing this dialog loses nothing). */
  ids: Record<string, string>;
  setIds: (f: (p: Record<string, string>) => Record<string, string>) => void;
  onClose: () => void;
  onSave: () => void;
  saving: boolean;
}) {
  const { enqueueSnackbar } = useSnackbar();
  const qc = useQueryClient();
  const [reason, setReason] = useState('');

  const { data } = useQuery({
    queryKey: ['my-discount-approvals'],
    queryFn: () => apiGet<any>('/offers/approvals', { mine: true }),
    enabled: open,
    refetchInterval: open ? 4000 : false,
  });
  const mine: any[] = (data as any)?.data ?? (data as any) ?? [];
  const statusOf = (n: ApprovalNeed) => mine.find((a) => a.id === ids[n.rateHash])?.status as string | undefined;

  const toAsk = needs.filter((n) => !LIVE.includes(statusOf(n) ?? ''));
  const allApproved = needs.length > 0 && needs.every((n) => statusOf(n) === 'APPROVED');

  const ask = useMutation({
    mutationFn: async () => {
      for (const n of toAsk) {
        const body = requestBody(n, reason.trim());
        if (!body) throw new Error('Could not build the approval request for one of the lines');
        const res: any = await apiPost('/offers/approvals', body);
        const a = res?.data ?? res;
        setIds((p) => ({ ...p, [n.rateHash]: a.id }));
      }
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['my-discount-approvals'] }); enqueueSnackbar('Sent to a store manager', { variant: 'success' }); },
    onError: (e: any) => enqueueSnackbar(e.response?.data?.error ?? e.message ?? 'Could not send the request', { variant: 'error' }),
  });

  const cancel = useMutation({
    mutationFn: (id: string) => apiPost(`/offers/approvals/${id}/cancel`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['my-discount-approvals'] }),
    onError: (e: any) => enqueueSnackbar(e.response?.data?.error ?? 'Could not cancel', { variant: 'error' }),
  });

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>Store manager's approval needed</DialogTitle>
      <DialogContent>
        <Alert severity="info" sx={{ mb: 1.5 }}>
          This bill sells below the offered rate. A store manager (not you) has to approve each item below before it can be saved.
          An approval covers exactly these figures — change a rate and a fresh approval is needed.
        </Alert>
        <Stack spacing={1}>
          {needs.map((n) => {
            const st = statusOf(n);
            return (
              <Box key={n.rateHash} sx={{ border: 1, borderColor: 'divider', borderRadius: 1, p: 1 }}>
                <Stack direction="row" spacing={1} alignItems="center" justifyContent="space-between">
                  <Typography variant="body2" fontWeight={600}>
                    {n.scope === 'DISCOUNT' ? `Extra discount ₹${(n.amount ?? 0).toLocaleString('en-IN')}` : labelFor(n)}
                  </Typography>
                  <Chip size="small" color={st ? STATUS_COLOR[st] : 'default'} label={st ? STATUS_LABEL[st] : 'Not asked yet'} />
                </Stack>
                <Typography variant="body2" color="text.secondary">
                  {n.scope === 'DISCOUNT'
                    ? 'A discount on top of an offer price'
                    : `${n.offerName ?? 'Offer'}: ${describeRates(n.requested!, n.offered!)}`}
                </Typography>
                {st && LIVE.includes(st) && (
                  <Button size="small" color="warning" sx={{ p: 0, minWidth: 0 }} disabled={cancel.isPending} onClick={() => cancel.mutate(ids[n.rateHash])}>Withdraw request</Button>
                )}
              </Box>
            );
          })}
        </Stack>
        {toAsk.length > 0 && (
          <TextField fullWidth size="small" sx={{ mt: 1.5 }} label="Reason (the manager sees this)" value={reason} onChange={(e) => setReason(e.target.value)}
            inputProps={{ maxLength: 500 }} />
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Close</Button>
        {toAsk.length > 0 && (
          <Button variant="outlined" disabled={!reason.trim() || ask.isPending} onClick={() => ask.mutate()}>Ask a store manager</Button>
        )}
        <Button variant="contained" disabled={!allApproved || saving} onClick={onSave}>Save bill</Button>
      </DialogActions>
    </Dialog>
  );
}
