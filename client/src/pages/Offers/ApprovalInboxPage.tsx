import { useState } from 'react';
import {
  Box, Button, Chip, Dialog, DialogActions, DialogContent, DialogTitle, Stack, TextField, Typography,
} from '@mui/material';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSnackbar } from 'notistack';
import { apiGet, apiPost } from '../../api/client';
import { PageHeader } from '../../components/common/PageHeader';
import { DataTable } from '../../components/common/DataTable';
import { SelectField } from '../../components/fields/SelectField';
import { PermissionGate } from '../../components/auth/PermissionGate';
import { useAuthStore } from '../../store/auth.store';
import { describeRates } from '../Sales/BelowOfferApprovalDialog';

// Offers step 3 — the store manager's inbox. A biller who priced a piece below its offered rate (or took an extra discount
// on an offer bill) has asked here; a DIFFERENT person with discount:approve decides. Approving lets exactly those rates be
// billed once; it does not change any rate, tag or offer.

const STATUS_COLOR: Record<string, 'default' | 'warning' | 'success' | 'error' | 'info'> = {
  PENDING: 'warning', APPROVED: 'success', REJECTED: 'error', CANCELLED: 'default', USED: 'info',
};

const summary = (r: any): string =>
  r.scope === 'DISCOUNT'
    ? `Extra discount ₹${Number(r.requestedRates?.discountAmount ?? 0).toLocaleString('en-IN')} on a bill carrying an offer`
    : `${r.offer?.name ?? 'Offer'}: ${describeRates(r.requestedRates, r.offeredRates)}`;

export function ApprovalInboxPage() {
  const { enqueueSnackbar } = useSnackbar();
  const qc = useQueryClient();
  const me = useAuthStore((s) => s.user?.id);
  const [status, setStatus] = useState('PENDING');
  const [rejecting, setRejecting] = useState<any>(null);
  const [note, setNote] = useState('');

  const { data, isLoading } = useQuery({
    queryKey: ['discount-approvals', status],
    queryFn: () => apiGet<any>('/offers/approvals', { status }),
    refetchInterval: status === 'PENDING' ? 10000 : false,
  });
  const rows: any[] = (data as any)?.data ?? (data as any) ?? [];

  const done = () => { qc.invalidateQueries({ queryKey: ['discount-approvals'] }); };
  const fail = (e: any) => enqueueSnackbar(e.response?.data?.error ?? 'Failed', { variant: 'error' });
  const approve = useMutation({
    mutationFn: (r: any) => apiPost(`/offers/approvals/${r.id}/approve`, {}),
    onSuccess: () => { done(); enqueueSnackbar('Approved — the biller can now save the bill', { variant: 'success' }); },
    onError: fail,
  });
  const reject = useMutation({
    mutationFn: (r: any) => apiPost(`/offers/approvals/${r.id}/reject`, { note: note.trim() }),
    onSuccess: () => { done(); setRejecting(null); setNote(''); enqueueSnackbar('Rejected', { variant: 'success' }); },
    onError: fail,
  });

  return (
    <Box>
      <PageHeader
        title="Offer Approvals"
        subtitle="Requests to sell below an offered rate. Approve or reject each one; you cannot decide a request you made yourself."
        actions={[]}
      />
      <Stack direction="row" spacing={1.5} sx={{ mb: 1.5 }}>
        <SelectField size="small" fullWidth={false} sx={{ minWidth: 170 }} label="Show" value={status}
          onChange={(e) => setStatus(e.target.value)}
          options={[
            { value: 'PENDING', label: 'Waiting' }, { value: 'APPROVED', label: 'Approved (not yet billed)' },
            { value: 'USED', label: 'Billed' }, { value: 'REJECTED', label: 'Rejected' }, { value: 'CANCELLED', label: 'Withdrawn' },
            { value: 'ALL', label: 'All' },
          ]} />
      </Stack>

      <DataTable
        tableId="offer-approvals"
        isLoading={isLoading}
        rows={rows}
        getRowId={(r) => r.id}
        emptyLabel={status === 'PENDING' ? 'Nothing waiting for approval' : 'No requests'}
        columns={[
          { key: 'requestedAt', label: 'Asked', width: 150, render: (r) => new Date(r.requestedAt).toLocaleString('en-IN'), filterValue: (r) => new Date(r.requestedAt).toLocaleDateString('en-IN') },
          { key: 'requestedBy', label: 'Asked by', width: 140, render: (r) => r.requestedBy?.name ?? '', filterValue: (r) => r.requestedBy?.name ?? '' },
          { key: 'piece', label: 'Piece', width: 190, render: (r) => (r.tag ? `${r.tag.tagNumber} — ${r.tag.name}` : '—'), filterValue: (r) => r.tag?.tagNumber ?? '—' },
          { key: 'what', label: 'Below the offer', width: 420, filterable: false, render: (r) => <Typography variant="body2">{summary(r)}</Typography> },
          { key: 'reason', label: 'Reason', width: 220, render: (r) => r.reason },
          {
            key: 'status', label: 'Status', width: 120,
            render: (r) => <Chip size="small" color={STATUS_COLOR[r.status]} label={r.status === 'USED' ? 'Billed' : r.status[0] + r.status.slice(1).toLowerCase()} />,
            filterValue: (r) => r.status,
          },
          { key: 'decision', label: 'Decided by', width: 160, render: (r) => (r.decidedBy ? `${r.decidedBy.name}${r.decisionNote ? ` — ${r.decisionNote}` : ''}` : ''), filterValue: (r) => r.decidedBy?.name ?? '' },
          {
            key: 'actions', label: 'Actions', hideable: false, filterable: false, width: 180,
            render: (r) => r.status !== 'PENDING' ? null : (
              <PermissionGate permission="discount:approve">
                {r.requestedBy?.id === me ? (
                  <Typography variant="caption" color="text.secondary">Your own request</Typography>
                ) : (
                  <Stack direction="row" spacing={0.5}>
                    <Button size="small" variant="contained" color="success" disabled={approve.isPending} onClick={() => approve.mutate(r)}>Approve</Button>
                    <Button size="small" color="error" onClick={() => { setRejecting(r); setNote(''); }}>Reject</Button>
                  </Stack>
                )}
              </PermissionGate>
            ),
          },
        ]}
      />

      <Dialog open={!!rejecting} onClose={() => setRejecting(null)} maxWidth="xs" fullWidth>
        <DialogTitle>Reject this request?</DialogTitle>
        <DialogContent>
          <Typography variant="body2" sx={{ mb: 1 }}>{rejecting && summary(rejecting)}</Typography>
          <TextField autoFocus fullWidth size="small" label="Why (the biller sees this)" value={note} onChange={(e) => setNote(e.target.value)} inputProps={{ maxLength: 500 }} />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setRejecting(null)}>Cancel</Button>
          <Button color="error" variant="contained" disabled={!note.trim() || reject.isPending} onClick={() => reject.mutate(rejecting)}>Reject</Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
