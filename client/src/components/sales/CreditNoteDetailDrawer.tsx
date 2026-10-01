import { useState } from 'react';
import {
  Drawer, Box, Typography, Stack, IconButton, Button, Grid, Divider, Table, TableHead,
  TableBody, TableRow, TableCell, Chip, Alert, CircularProgress, Dialog, DialogTitle,
  DialogContent, DialogActions, TextField, Tooltip,
} from '@mui/material';
import { Print, Visibility, Close, Block } from '@mui/icons-material';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useSnackbar } from 'notistack';
import { apiGet, apiPost } from '../../api/client';
import { useAuthStore } from '../../store/auth.store';
import { printCreditNote } from '../../utils/printCreditNote';
import { CreditNotePreviewDialog } from './CreditNotePreviewDialog';

interface Props {
  creditNoteId: string;
  onClose: () => void;
}

const REASON_LABELS: Record<string, string> = {
  SALES_RETURN: 'Sales Return / Goods Returned',
  POST_SALE_DISCOUNT: 'Post-Sale Discount / Price Adjustment',
  DEFICIENCY_IN_SERVICE: 'Deficiency in Service / Waived Charges',
  CORRECTION_IN_INVOICE: 'Correction in Invoice Details',
  CHANGE_IN_POS: 'Correction in Place of Supply',
  OTHER: 'Other / Mutual Agreement',
};

const fmt = (n: unknown) =>
  `₹ ${Number(n ?? 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const wt = (n: unknown) =>
  n != null ? `${Number(n).toFixed(3)} g` : '—';

export function CreditNoteDetailDrawer({ creditNoteId, onClose }: Props) {
  const { enqueueSnackbar } = useSnackbar();
  const qc = useQueryClient();
  const [previewOpen, setPreviewOpen] = useState(false);
  const [cancelDialogOpen, setCancelDialogOpen] = useState(false);
  const [cancelReason, setCancelReason] = useState('');

  const canCancel = useAuthStore((s) => s.hasPermission('creditNote:cancel'));

  const { data, isLoading } = useQuery({
    queryKey: ['credit-note-detail', creditNoteId],
    queryFn: () => apiGet<any>(`/sales/credit-notes/${creditNoteId}`),
    enabled: !!creditNoteId,
  });

  const note = data;
  const isCancelled = note?.status === 'CANCELLED';
  const isReturnLinked = !!note?.salesReturnId || !!note?.salesReturn;
  const isInterState = Number(note?.igst ?? 0) > 0;

  const cancelMutation = useMutation({
    mutationFn: (reason: string) => apiPost(`/sales/credit-notes/${creditNoteId}/cancel`, { reason }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['credit-note-detail', creditNoteId] });
      qc.invalidateQueries({ queryKey: ['sales-credit-notes'] });
      enqueueSnackbar('Credit note successfully cancelled', { variant: 'success' });
      setCancelDialogOpen(false);
      setCancelReason('');
    },
    onError: (err: any) => {
      enqueueSnackbar(err.response?.data?.error ?? 'Failed to cancel credit note', { variant: 'error' });
    },
  });

  return (
    <>
      <Drawer anchor="right" open={!!creditNoteId} onClose={onClose} PaperProps={{ sx: { width: { xs: '100%', sm: 680 } } }}>
        <Box sx={{ p: 3, height: '100%', overflow: 'auto' }}>
          {/* Header Bar */}
          <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 2 }}>
            <Box>
              <Typography variant="caption" sx={{ textTransform: 'uppercase', letterSpacing: '0.08em', color: 'text.secondary', fontWeight: 700 }}>
                GST Document
              </Typography>
              <Typography variant="h6" fontWeight={800}>
                Credit Note
              </Typography>
            </Box>
            <Stack direction="row" spacing={1} alignItems="center">
              {note && (
                <>
                  <Button size="small" variant="outlined" startIcon={<Visibility />} onClick={() => setPreviewOpen(true)}>
                    Preview
                  </Button>
                  <Button size="small" variant="contained" startIcon={<Print />} onClick={() => printCreditNote(note)}
                    sx={{ bgcolor: '#44C47A', '&:hover': { bgcolor: '#38A866' } }}>
                    Print
                  </Button>
                  {canCancel && !isCancelled && !isReturnLinked && (
                    <Button size="small" variant="outlined" color="error" startIcon={<Block />} onClick={() => setCancelDialogOpen(true)}>
                      Cancel
                    </Button>
                  )}
                  {canCancel && !isCancelled && isReturnLinked && (
                    <Tooltip title="A return-linked Credit Note is append-only and cannot be cancelled independently.">
                      <span>
                        <Button size="small" variant="outlined" disabled startIcon={<Block />}>
                          Cancel
                        </Button>
                      </span>
                    </Tooltip>
                  )}
                </>
              )}
              <IconButton onClick={onClose} size="small"><Close /></IconButton>
            </Stack>
          </Stack>

          {isLoading && (
            <Box sx={{ display: 'flex', justifyContent: 'center', py: 8 }}>
              <CircularProgress />
            </Box>
          )}

          {note && (
            <Stack spacing={2.5}>
              {/* Cancellation Alert */}
              {isCancelled && (
                <Alert severity="error" sx={{ fontWeight: 600 }}>
                  <Typography variant="subtitle2" fontWeight={800} color="error.dark">
                    CANCELLED CREDIT NOTE
                  </Typography>
                  <Typography variant="body2" sx={{ mt: 0.5 }}>
                    This Credit Note was cancelled on {new Date(note.cancelledAt).toLocaleString('en-IN')}
                    {note.cancelledBy?.name ? ` by ${note.cancelledBy.name}` : ''}.
                  </Typography>
                  {note.cancelReason && (
                    <Typography variant="body2" sx={{ fontStyle: 'italic', mt: 0.5 }}>
                      Reason: "{note.cancelReason}"
                    </Typography>
                  )}
                </Alert>
              )}

              {/* Status & Key Meta Grid */}
              <Grid container spacing={2} sx={{ bgcolor: isCancelled ? '#FFF5F5' : '#F9FBF9', p: 2, borderRadius: 2, border: `1px solid ${isCancelled ? '#FFCDD2' : '#E8F5E9'}` }}>
                <Grid item xs={6}>
                  <Typography variant="caption" color="text.secondary">Credit Note Number</Typography>
                  <Typography fontWeight={900} fontFamily="monospace" fontSize={16} color={isCancelled ? 'error.main' : '#44C47A'}>
                    {note.creditNoteNumber}
                  </Typography>
                </Grid>
                <Grid item xs={6}>
                  <Typography variant="caption" color="text.secondary">Status</Typography>
                  <Box sx={{ mt: 0.5 }}>
                    <Chip
                      label={isCancelled ? 'CANCELLED' : 'ACTIVE'}
                      color={isCancelled ? 'error' : 'success'}
                      size="small"
                      sx={{ fontWeight: 800, fontSize: 11 }}
                    />
                  </Box>
                </Grid>
                <Grid item xs={6}>
                  <Typography variant="caption" color="text.secondary">Document Date</Typography>
                  <Typography fontWeight={600}>
                    {new Date(note.creditNoteDate).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}
                  </Typography>
                </Grid>
                <Grid item xs={6}>
                  <Typography variant="caption" color="text.secondary">Financial Year</Typography>
                  <Typography fontWeight={600}>FY {note.financialYear}-{note.financialYear + 1}</Typography>
                </Grid>
              </Grid>

              {/* Customer Section */}
              <Box sx={{ p: 2, borderRadius: 2, border: '1px solid #EEEEEE' }}>
                <Typography variant="subtitle2" fontWeight={700} color="text.secondary" sx={{ textTransform: 'uppercase', fontSize: 11, mb: 1 }}>
                  Customer Details
                </Typography>
                <Grid container spacing={1.5}>
                  <Grid item xs={7}>
                    <Typography fontWeight={700} fontSize={15}>
                      {note.buyerName || note.client?.name}
                    </Typography>
                    {note.client?.clientCode && (
                      <Typography variant="caption" color="text.secondary" sx={{ fontFamily: 'monospace' }}>
                        Code: {note.client.clientCode}
                      </Typography>
                    )}
                    {(note.buyerAddress || note.client?.address) && (
                      <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
                        {[note.buyerAddress || note.client?.address, note.buyerCity || note.client?.city, note.buyerState || note.client?.state, note.buyerPincode].filter(Boolean).join(', ')}
                      </Typography>
                    )}
                  </Grid>
                  <Grid item xs={5}>
                    {(note.client?.phone || note.buyerPhone) && (
                      <Box sx={{ mb: 0.5 }}>
                        <Typography variant="caption" color="text.secondary">Phone:</Typography>
                        <Typography variant="body2" fontWeight={600}>{note.client?.phone || note.buyerPhone}</Typography>
                      </Box>
                    )}
                    {note.buyerGstin && (
                      <Box sx={{ mb: 0.5 }}>
                        <Typography variant="caption" color="text.secondary">GSTIN:</Typography>
                        <Typography variant="body2" sx={{ fontFamily: 'monospace' }}>{note.buyerGstin}</Typography>
                      </Box>
                    )}
                    {note.buyerPan && (
                      <Box>
                        <Typography variant="caption" color="text.secondary">PAN:</Typography>
                        <Typography variant="body2" sx={{ fontFamily: 'monospace' }}>{note.buyerPan}</Typography>
                      </Box>
                    )}
                  </Grid>
                </Grid>
              </Box>

              {/* Reference Section */}
              <Box sx={{ p: 2, borderRadius: 2, border: '1px solid #EEEEEE' }}>
                <Typography variant="subtitle2" fontWeight={700} color="text.secondary" sx={{ textTransform: 'uppercase', fontSize: 11, mb: 1 }}>
                  Reference & Statutory
                </Typography>
                <Grid container spacing={1.5}>
                  <Grid item xs={6}>
                    <Typography variant="caption" color="text.secondary">Original Invoice</Typography>
                    <Typography fontWeight={700} sx={{ fontFamily: 'monospace' }}>{note.originalInvoiceNumber}</Typography>
                    <Typography variant="caption" color="text.secondary">
                      Date: {new Date(note.originalInvoiceDate).toLocaleDateString('en-IN')}
                    </Typography>
                  </Grid>
                  <Grid item xs={6}>
                    <Typography variant="caption" color="text.secondary">Nature of Credit Note</Typography>
                    <Box sx={{ mt: 0.5 }}>
                      {isReturnLinked ? (
                        <Chip
                          label={`Return-Linked (Ret #${note.salesReturn?.returnNumber || 'Linked'})`}
                          color="info"
                          size="small"
                          sx={{ fontWeight: 700 }}
                        />
                      ) : (
                        <Chip
                          label="Standalone Adjustment"
                          variant="outlined"
                          size="small"
                          sx={{ fontWeight: 700 }}
                        />
                      )}
                    </Box>
                  </Grid>
                  <Grid item xs={6}>
                    <Typography variant="caption" color="text.secondary">Reason</Typography>
                    <Typography fontWeight={600}>{REASON_LABELS[note.reasonCode] ?? note.reasonCode}</Typography>
                    {note.reasonNotes && (
                      <Typography variant="body2" color="text.secondary" sx={{ fontStyle: 'italic' }}>
                        "{note.reasonNotes}"
                      </Typography>
                    )}
                  </Grid>
                  <Grid item xs={6}>
                    <Typography variant="caption" color="text.secondary">Place of Supply</Typography>
                    <Typography fontWeight={600}>
                      {note.placeOfSupply || '—'} {isInterState ? '(Inter-State)' : '(Intra-State)'}
                    </Typography>
                  </Grid>
                </Grid>

                {isReturnLinked && (
                  <Alert severity="info" sx={{ mt: 1.5, py: 0.5, fontSize: 12 }}>
                    Customer ledger movement is accounted via <b>Sales Return #{note.salesReturn?.returnNumber || ''}</b>. This document provides statutory GST compliance without duplicate ledger entries.
                  </Alert>
                )}
              </Box>

              {/* Line Items */}
              <Box>
                <Typography variant="subtitle2" fontWeight={700} sx={{ mb: 1 }}>
                  Credit Note Items
                </Typography>
                <Table size="small" sx={{ border: '1px solid #EEEEEE', borderRadius: 1 }}>
                  <TableHead sx={{ bgcolor: '#F8F9FA' }}>
                    <TableRow>
                      <TableCell sx={{ fontSize: 11, fontWeight: 700 }}>Description</TableCell>
                      <TableCell sx={{ fontSize: 11, fontWeight: 700 }}>HSN</TableCell>
                      <TableCell align="right" sx={{ fontSize: 11, fontWeight: 700 }}>Net Wt</TableCell>
                      <TableCell align="right" sx={{ fontSize: 11, fontWeight: 700 }}>Taxable</TableCell>
                      <TableCell align="right" sx={{ fontSize: 11, fontWeight: 700 }}>GST</TableCell>
                      <TableCell align="right" sx={{ fontSize: 11, fontWeight: 700 }}>Total</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {(note.items ?? []).map((item: any) => (
                      <TableRow key={item.id}>
                        <TableCell>
                          <Typography variant="body2" fontWeight={600}>{item.description}</Typography>
                          {item.karat && <Typography variant="caption" color="text.secondary">Karat: {item.karat}</Typography>}
                        </TableCell>
                        <TableCell sx={{ fontFamily: 'monospace', fontSize: 11 }}>
                          {item.hsnCode?.code || item.hsnCodeId || '—'}
                        </TableCell>
                        <TableCell align="right" sx={{ fontFamily: 'monospace', fontSize: 11 }}>
                          {wt(item.netWeight)}
                        </TableCell>
                        <TableCell align="right" sx={{ fontFamily: 'monospace' }}>
                          {fmt(item.taxableValue)}
                        </TableCell>
                        <TableCell align="right" sx={{ fontFamily: 'monospace', fontSize: 11 }}>
                          {fmt(isInterState ? item.igstAmount : Number(item.cgstAmount ?? 0) + Number(item.sgstAmount ?? 0))}
                        </TableCell>
                        <TableCell align="right" sx={{ fontFamily: 'monospace', fontWeight: 700 }}>
                          {fmt(item.totalValue)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </Box>

              {/* Amounts & Financial Breakdown */}
              <Box sx={{ bgcolor: '#FAFAF8', p: 2, borderRadius: 2, border: '1px solid #E5E8EC' }}>
                <Typography variant="subtitle2" fontWeight={700} color="text.secondary" sx={{ textTransform: 'uppercase', fontSize: 11, mb: 1.5 }}>
                  Financial Breakdown (Persisted Backend Values)
                </Typography>
                <Stack spacing={1}>
                  <Stack direction="row" justifyContent="space-between">
                    <Typography variant="body2" color="text.secondary">Taxable Amount</Typography>
                    <Typography variant="body2" sx={{ fontFamily: 'monospace' }}>{fmt(note.taxableAmount)}</Typography>
                  </Stack>
                  {!isInterState ? (
                    <>
                      <Stack direction="row" justifyContent="space-between">
                        <Typography variant="body2" color="text.secondary">CGST</Typography>
                        <Typography variant="body2" sx={{ fontFamily: 'monospace' }}>{fmt(note.cgst)}</Typography>
                      </Stack>
                      <Stack direction="row" justifyContent="space-between">
                        <Typography variant="body2" color="text.secondary">SGST</Typography>
                        <Typography variant="body2" sx={{ fontFamily: 'monospace' }}>{fmt(note.sgst)}</Typography>
                      </Stack>
                    </>
                  ) : (
                    <Stack direction="row" justifyContent="space-between">
                      <Typography variant="body2" color="text.secondary">IGST</Typography>
                      <Typography variant="body2" sx={{ fontFamily: 'monospace' }}>{fmt(note.igst)}</Typography>
                    </Stack>
                  )}
                  <Stack direction="row" justifyContent="space-between">
                    <Typography variant="body2" color="text.secondary">Total Tax</Typography>
                    <Typography variant="body2" sx={{ fontFamily: 'monospace' }}>{fmt(note.totalTax)}</Typography>
                  </Stack>
                  <Divider sx={{ my: 0.5 }} />
                  <Stack direction="row" justifyContent="space-between" alignItems="center">
                    <Typography variant="subtitle1" fontWeight={800}>Total Credit Value</Typography>
                    <Typography variant="h6" fontWeight={900} sx={{ fontFamily: 'monospace', color: isCancelled ? 'error.main' : '#44C47A' }}>
                      {fmt(note.totalAmount)}
                    </Typography>
                  </Stack>
                </Stack>
              </Box>
            </Stack>
          )}
        </Box>
      </Drawer>

      {/* Preview Dialog */}
      {note && (
        <CreditNotePreviewDialog
          open={previewOpen}
          creditNote={note}
          onClose={() => setPreviewOpen(false)}
        />
      )}

      {/* Cancel Confirmation Dialog */}
      <Dialog open={cancelDialogOpen} onClose={() => setCancelDialogOpen(false)} maxWidth="xs" fullWidth>
        <DialogTitle sx={{ fontWeight: 700, color: 'error.main' }}>
          Cancel Credit Note
        </DialogTitle>
        <DialogContent>
          <Typography variant="body2" sx={{ mb: 2 }}>
            Are you sure you want to cancel Credit Note <b>{note?.creditNoteNumber}</b>?
            This will record an inverse journal entry and restore the customer balance.
          </Typography>
          <TextField
            autoFocus
            fullWidth
            required
            size="small"
            label="Cancellation Reason"
            value={cancelReason}
            onChange={(e) => setCancelReason(e.target.value)}
            helperText="A clear reason is required for statutory compliance audit."
          />
        </DialogContent>
        <DialogActions sx={{ p: 2 }}>
          <Button onClick={() => setCancelDialogOpen(false)} disabled={cancelMutation.isPending}>
            Keep Active
          </Button>
          <Button
            onClick={() => cancelMutation.mutate(cancelReason)}
            variant="contained"
            color="error"
            disabled={!cancelReason.trim() || cancelMutation.isPending}
          >
            {cancelMutation.isPending ? 'Cancelling...' : 'Confirm Cancellation'}
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
}
