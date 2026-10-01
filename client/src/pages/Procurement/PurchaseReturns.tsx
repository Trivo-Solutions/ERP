import { useState } from 'react';
import {
  Box, Card, CardContent, Table, TableHead, TableBody, TableRow, TableCell, Typography,
  Button, Grid, MenuItem, TextField, Stack, Checkbox, Chip, CircularProgress,
  FormControlLabel, Alert, Tooltip, IconButton,
} from '@mui/material';
import { Undo, Receipt } from '@mui/icons-material';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useSnackbar } from 'notistack';
import { apiGet, apiPost } from '../../api/client';
import { PageHeader } from '../../components/common/PageHeader';
import { useAuthStore } from '../../store/auth.store';
import { DebitNoteDetailDrawer } from '../../components/procurement/DebitNoteDetailDrawer';

function fmt(n: number) {
  return '₹' + Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });
}

export function PurchaseReturns() {
  const { enqueueSnackbar } = useSnackbar();
  const qc = useQueryClient();
  // POST /procurement/returns is gated by po:approve server-side (see procurement.router.ts).
  const canReturn = useAuthStore((s) => s.hasPermission('po:approve'));
  const canIssueDebitNote = useAuthStore((s) => s.hasPermission('debitNote:create'));
  const [supplierId, setSupplierId] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [reason, setReason] = useState('');
  const [issueDebitNote, setIssueDebitNote] = useState(true);
  const [createdDebitNote, setCreatedDebitNote] = useState<any>(null);
  const [selectedDebitNoteId, setSelectedDebitNoteId] = useState<string>('');

  const { data: suppliers } = useQuery({
    queryKey: ['suppliers'], queryFn: () => apiGet<any[]>('/procurement/suppliers'),
  });
  const supplierList: any[] = suppliers ?? [];

  const { data: returnableTags, isFetching: loadingTags } = useQuery({
    queryKey: ['returnable-tags', supplierId],
    queryFn: () => apiGet<any[]>(`/procurement/suppliers/${supplierId}/returnable-tags`),
    enabled: !!supplierId,
  });
  const tags: any[] = returnableTags ?? [];

  const { data: returnsData } = useQuery({
    queryKey: ['purchase-returns', supplierId],
    queryFn: () => apiGet<any[]>('/procurement/returns', { supplierId: supplierId || undefined }),
  });
  const returns: any[] = returnsData ?? [];

  const toggle = (id: string) => {
    setSelected((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  };

  const mutation = useMutation({
    mutationFn: () => apiPost<any>('/procurement/returns', {
      items: selected.map((tagId) => ({ tagId })),
      reason: reason || undefined,
      issueDebitNote: canIssueDebitNote && issueDebitNote,
    }),
    onSuccess: (res: any) => {
      qc.invalidateQueries({ queryKey: ['returnable-tags', supplierId] });
      qc.invalidateQueries({ queryKey: ['purchase-returns'] });
      qc.invalidateQueries({ queryKey: ['procurement-debit-notes'] });
      setSelected([]);
      setReason('');
      const dn = res?.debitNote || res?.data?.debitNote;
      if (dn) {
        setCreatedDebitNote(dn);
        enqueueSnackbar(`Purchase return recorded and Debit Note ${dn.debitNoteNumber} issued`, { variant: 'success' });
      } else {
        enqueueSnackbar('Purchase return recorded — tag(s) retired', { variant: 'success' });
      }
    },
    onError: (e: any) => enqueueSnackbar(e.response?.data?.error ?? 'Failed to record return', { variant: 'error' }),
  });

  const issueExistingMutation = useMutation({
    mutationFn: (returnId: string) => apiPost<any>(`/procurement/returns/${returnId}/debit-note`, {}),
    onSuccess: (dn: any) => {
      qc.invalidateQueries({ queryKey: ['purchase-returns'] });
      qc.invalidateQueries({ queryKey: ['procurement-debit-notes'] });
      if (dn?.id) {
        setSelectedDebitNoteId(dn.id);
      }
      enqueueSnackbar(`Debit Note ${dn?.debitNoteNumber ?? ''} issued successfully`, { variant: 'success' });
    },
    onError: (e: any) => enqueueSnackbar(e.response?.data?.error ?? 'Failed to issue Debit Note', { variant: 'error' }),
  });

  return (
    <Box>
      <PageHeader title="Purchase Returns" />

      <Card sx={{ mb: 2 }}>
        <CardContent>
          <Grid container spacing={2} alignItems="center">
            <Grid item xs={12} sm={4}>
              <TextField select fullWidth label="Supplier" value={supplierId}
                onChange={(e) => { setSupplierId(e.target.value); setSelected([]); }}>
                <MenuItem value="">Select a supplier...</MenuItem>
                {supplierList.map((s: any) => (
                  <MenuItem key={s.id} value={s.id}>{s.supplierCode} — {s.name}</MenuItem>
                ))}
              </TextField>
            </Grid>
          </Grid>

          {supplierId && (
            <Box sx={{ mt: 2 }}>
              {loadingTags && <Box sx={{ display: 'flex', justifyContent: 'center', py: 3 }}><CircularProgress size={24} /></Box>}

              {!loadingTags && tags.length === 0 && (
                <Typography color="text.secondary" sx={{ py: 2 }}>
                  No IN_STOCK finished-goods pieces from this supplier to return.
                </Typography>
              )}

              {tags.length > 0 && (
                <Stack spacing={1}>
                  {tags.map((tag: any) => (
                    <Stack key={tag.id} direction="row" alignItems="center" spacing={1}>
                      <Checkbox size="small" checked={selected.includes(tag.id)} onChange={() => toggle(tag.id)} />
                      <Typography variant="body2" sx={{ fontFamily: 'monospace', color: '#44C47A', minWidth: 120 }}>
                        {tag.tagNumber}
                      </Typography>
                      <Typography variant="body2" sx={{ flex: 1 }}>{tag.name}</Typography>
                      <Typography variant="body2" color="text.secondary">{tag.branch?.name}</Typography>
                      <Typography variant="body2" sx={{ fontFamily: 'monospace', fontWeight: 700 }}>
                        {fmt(Number(tag.costPrice))}
                      </Typography>
                    </Stack>
                  ))}
                  {canReturn && (
                    <Stack spacing={1} sx={{ pt: 1 }}>
                      <Stack direction="row" spacing={1} alignItems="flex-start">
                        <TextField size="small" label="Reason (optional)" value={reason}
                          onChange={(e) => setReason(e.target.value)} sx={{ flex: 1 }} />
                        <Button variant="contained" color="warning" size="small" startIcon={<Undo />}
                          disabled={selected.length === 0 || mutation.isPending}
                          onClick={() => mutation.mutate()} sx={{ height: 40 }}>
                          Return Selected
                        </Button>
                      </Stack>
                      {canIssueDebitNote && (
                        <FormControlLabel
                          control={
                            <Checkbox
                              size="small"
                              checked={issueDebitNote}
                              onChange={(e) => setIssueDebitNote(e.target.checked)}
                            />
                          }
                          label={
                            <Typography variant="body2" sx={{ fontWeight: 600 }}>
                              Also issue a formal Debit Note (atomic GST document)
                            </Typography>
                          }
                        />
                      )}
                    </Stack>
                  )}
                </Stack>
              )}
            </Box>
          )}
        </CardContent>
      </Card>

      {createdDebitNote && (
        <Alert
          severity="success"
          action={
            <Button
              color="inherit"
              size="small"
              onClick={() => setSelectedDebitNoteId(createdDebitNote.id)}
            >
              View Debit Note
            </Button>
          }
          onClose={() => setCreatedDebitNote(null)}
          sx={{ mb: 2 }}
        >
          Purchase Return completed and Debit Note <b>{createdDebitNote.debitNoteNumber}</b> was issued.
        </Alert>
      )}

      <Card>
        <Box sx={{ overflowX: 'auto' }}>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Return #</TableCell>
                <TableCell>Date</TableCell>
                <TableCell>Supplier</TableCell>
                <TableCell>Items</TableCell>
                <TableCell>Reason</TableCell>
                <TableCell align="right">Amount</TableCell>
                {canIssueDebitNote && <TableCell align="center">Debit Note</TableCell>}
              </TableRow>
            </TableHead>
            <TableBody>
              {returns.map((r: any) => (
                <TableRow key={r.id} hover>
                  <TableCell sx={{ fontFamily: 'monospace', fontWeight: 700, color: '#44C47A', fontSize: 12 }}>
                    {r.returnNumber}
                  </TableCell>
                  <TableCell sx={{ fontSize: 12 }}>{new Date(r.returnDate).toLocaleDateString('en-IN')}</TableCell>
                  <TableCell>{r.supplier?.name}</TableCell>
                  <TableCell>
                    {r.items.map((i: any) => (
                      <Chip key={i.id} label={i.tag?.tagNumber} size="small" sx={{ mr: 0.5, mb: 0.5 }} />
                    ))}
                  </TableCell>
                  <TableCell sx={{ fontSize: 12 }}>{r.reason || '—'}</TableCell>
                  <TableCell align="right" sx={{ fontFamily: 'monospace', fontWeight: 700 }}>
                    {fmt(Number(r.totalAmount))}
                  </TableCell>
                  {canIssueDebitNote && (
                    <TableCell align="center">
                      <Tooltip title="Issue formal Debit Note for this return">
                        <IconButton
                          size="small"
                          color="primary"
                          disabled={issueExistingMutation.isPending}
                          onClick={() => issueExistingMutation.mutate(r.id)}
                        >
                          <Receipt fontSize="small" />
                        </IconButton>
                      </Tooltip>
                    </TableCell>
                  )}
                </TableRow>
              ))}
              {returns.length === 0 && (
                <TableRow><TableCell colSpan={canIssueDebitNote ? 7 : 6} align="center" sx={{ py: 4 }}>No purchase returns yet</TableCell></TableRow>
              )}
            </TableBody>
          </Table>
        </Box>
      </Card>

      {selectedDebitNoteId && (
        <DebitNoteDetailDrawer
          debitNoteId={selectedDebitNoteId}
          onClose={() => setSelectedDebitNoteId('')}
        />
      )}
    </Box>
  );
}

