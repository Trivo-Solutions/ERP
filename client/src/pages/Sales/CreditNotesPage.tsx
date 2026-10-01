import { useState, useMemo, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Box, Stack, Typography, Chip, IconButton, Tooltip, MenuItem, TextField, Button,
  Dialog, DialogTitle, DialogContent, DialogActions,
} from '@mui/material';
import { Print, Visibility, Settings, Add } from '@mui/icons-material';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useSnackbar } from 'notistack';
import { apiGet, apiPost } from '../../api/client';
import { PageHeader } from '../../components/common/PageHeader';
import { PageActions } from '../../components/common/PageHeader';
import { DataTable } from '../../components/common/DataTable';
import { StatusChip } from '../../components/common/StatusChip';
import { DateField } from '../../components/fields/DateField';
import { useAuthStore } from '../../store/auth.store';
import { printCreditNote } from '../../utils/printCreditNote';
import { CreditNoteDetailDrawer } from '../../components/sales/CreditNoteDetailDrawer';
import { CreditNotePreviewDialog } from '../../components/sales/CreditNotePreviewDialog';

const REASON_LABELS: Record<string, string> = {
  SALES_RETURN: 'Sales Return',
  POST_SALE_DISCOUNT: 'Post-Sale Discount',
  DEFICIENCY_IN_SERVICE: 'Service Deficiency',
  CORRECTION_IN_INVOICE: 'Invoice Correction',
  CHANGE_IN_POS: 'POS Correction',
  OTHER: 'Other',
};

function NewCreditNoteDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const { enqueueSnackbar } = useSnackbar();
  const qc = useQueryClient();
  const [invoiceId, setInvoiceId] = useState('');
  const [reasonCode, setReasonCode] = useState('POST_SALE_DISCOUNT');
  const [reasonNotes, setReasonNotes] = useState('');
  const [description, setDescription] = useState('Post-Sale Discount Adjustment');
  const [taxableValue, setTaxableValue] = useState('');

  useEffect(() => {
    if (open) {
      setInvoiceId('');
      setReasonCode('POST_SALE_DISCOUNT');
      setReasonNotes('');
      setDescription('Post-Sale Discount Adjustment');
      setTaxableValue('');
    }
  }, [open]);

  const { data: invoicesData, isLoading: loadingInvoices } = useQuery({
    queryKey: ['sales-invoices-lookup'],
    queryFn: () => apiGet<any[]>('/sales/invoices'),
    enabled: open,
  });

  const invoices: any[] = useMemo(() => {
    if (!Array.isArray(invoicesData)) return [];
    return invoicesData.filter((inv) => inv.status !== 'VOID');
  }, [invoicesData]);

  const selectedInvoice = invoices.find((inv) => inv.id === invoiceId);

  const mutation = useMutation({
    mutationFn: () =>
      apiPost<any>('/sales/credit-notes', {
        invoiceId,
        reasonCode,
        reasonNotes: reasonNotes || undefined,
        items: [
          {
            description: description || 'Credit adjustment',
            taxableValue: Number(taxableValue),
          },
        ],
      }),
    onSuccess: (res: any) => {
      qc.invalidateQueries({ queryKey: ['sales-credit-notes'] });
      if (invoiceId) {
        qc.invalidateQueries({ queryKey: ['invoice-credit-notes', invoiceId] });
      }
      enqueueSnackbar('Credit Note created successfully', { variant: 'success' });
      onClose();
      const newId = res?.id || res?.data?.id;
      if (newId) onCreated(newId);
    },
    onError: (err: any) => {
      enqueueSnackbar(err.response?.data?.error ?? 'Failed to create Credit Note', { variant: 'error' });
    },
  });

  const parsedTaxable = Number(taxableValue) || 0;
  const estTax = Math.round(parsedTaxable * 0.03 * 100) / 100;
  const estTotal = parsedTaxable + estTax;
  const isOtherAndEmpty = reasonCode === 'OTHER' && !reasonNotes.trim();

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle sx={{ fontWeight: 700 }}>New Standalone Credit Note</DialogTitle>
      <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 2, pt: '10px !important' }}>
        <Typography variant="body2" color="text.secondary">
          Issue a value-only credit note (price correction, post-sale discount, service deficiency) against an issued invoice.
        </Typography>

        <TextField
          select
          required
          size="small"
          label="Select Invoice"
          value={invoiceId}
          onChange={(e) => setInvoiceId(e.target.value)}
          disabled={loadingInvoices}
          helperText={
            loadingInvoices
              ? 'Loading invoices...'
              : invoices.length === 0
              ? 'No active invoices found to credit'
              : selectedInvoice
              ? `Client: ${selectedInvoice.client?.name} | Invoice Total: ₹${Number(selectedInvoice.totalAmount).toLocaleString('en-IN')}`
              : 'Pick an invoice to credit'
          }
        >
          {invoices.length === 0 ? (
            <MenuItem value="" disabled>No active invoices available</MenuItem>
          ) : (
            invoices.map((inv) => (
              <MenuItem key={inv.id} value={inv.id}>
                {inv.invoiceNumber} — {inv.client?.name} (₹{Number(inv.totalAmount).toLocaleString('en-IN')})
              </MenuItem>
            ))
          )}
        </TextField>

        <TextField
          select
          required
          size="small"
          label="Reason for Credit Note"
          value={reasonCode}
          onChange={(e) => {
            setReasonCode(e.target.value);
            if (e.target.value === 'POST_SALE_DISCOUNT') setDescription('Post-Sale Discount Adjustment');
            else if (e.target.value === 'DEFICIENCY_IN_SERVICE') setDescription('Service / Charge Waiver Adjustment');
            else if (e.target.value === 'CORRECTION_IN_INVOICE') setDescription('Invoicing Correction Adjustment');
          }}
        >
          <MenuItem value="POST_SALE_DISCOUNT">Post-Sale Discount / Price Adjustment</MenuItem>
          <MenuItem value="DEFICIENCY_IN_SERVICE">Deficiency in Service / Waived Charges</MenuItem>
          <MenuItem value="CORRECTION_IN_INVOICE">Correction in Invoice Details</MenuItem>
          <MenuItem value="CHANGE_IN_POS">Correction in Place of Supply</MenuItem>
          <MenuItem value="OTHER">Other / Mutual Agreement</MenuItem>
        </TextField>

        <TextField
          size="small"
          required={reasonCode === 'OTHER'}
          error={isOtherAndEmpty}
          label={reasonCode === 'OTHER' ? 'Reason Notes (Required for Other)' : 'Reason Notes / Remarks (Optional)'}
          value={reasonNotes}
          onChange={(e) => setReasonNotes(e.target.value)}
          placeholder="e.g. Agreed festival promotional discount"
          helperText={isOtherAndEmpty ? 'Reason description is mandatory when selecting Other' : undefined}
        />

        <TextField
          required
          size="small"
          label="Line Description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />

        <TextField
          required
          size="small"
          type="number"
          label="Taxable Amount (₹)"
          value={taxableValue}
          onChange={(e) => setTaxableValue(e.target.value)}
          inputProps={{ min: 0.01, step: 0.01 }}
          helperText={
            parsedTaxable > 0
              ? `Est. 3% GST: ₹${estTax.toLocaleString('en-IN')} | Est. Total: ₹${estTotal.toLocaleString('en-IN')}`
              : 'Enter the taxable value before GST'
          }
        />
      </DialogContent>
      <DialogActions sx={{ p: 2 }}>
        <Button onClick={onClose} disabled={mutation.isPending}>
          Cancel
        </Button>
        <Button
          variant="contained"
          disabled={!invoiceId || parsedTaxable <= 0 || isOtherAndEmpty || mutation.isPending}
          onClick={() => mutation.mutate()}
          sx={{ bgcolor: '#44C47A', '&:hover': { bgcolor: '#38A866' } }}
        >
          {mutation.isPending ? 'Issuing...' : 'Issue Credit Note'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export function CreditNotesPage() {
  const navigate = useNavigate();
  const [selectedId, setSelectedId] = useState('');
  const [previewNote, setPreviewNote] = useState<any>(null);
  const [createOpen, setCreateOpen] = useState(false);

  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [statusFilter, setStatusFilter] = useState<'ALL' | 'ACTIVE' | 'CANCELLED'>('ALL');
  const [search, setSearch] = useState('');

  const canCreateCN = useAuthStore((s) => s.hasPermission('creditNote:create'));
  const canManageTemplates = useAuthStore((s) => s.hasPermission('creditNoteTemplate:view'));

  const rangeBad = !!from && !!to && from > to;

  const { data, isLoading } = useQuery({
    queryKey: ['sales-credit-notes', from, to],
    queryFn: () =>
      apiGet<any[]>('/sales/credit-notes', {
        ...(from && { from }),
        ...(to && { to }),
      }),
    enabled: !rangeBad,
  });

  const notes = data ?? [];

  // Filter client-side by status and search text
  const filteredNotes = useMemo(() => {
    return notes.filter((n) => {
      if (statusFilter === 'ACTIVE' && n.status === 'CANCELLED') return false;
      if (statusFilter === 'CANCELLED' && n.status !== 'CANCELLED') return false;

      if (search.trim()) {
        const q = search.toLowerCase();
        const num = (n.creditNoteNumber || '').toLowerCase();
        const client = (n.client?.name || n.buyerName || '').toLowerCase();
        const inv = (n.originalInvoiceNumber || '').toLowerCase();
        const ret = (n.salesReturn?.returnNumber || '').toLowerCase();
        if (!num.includes(q) && !client.includes(q) && !inv.includes(q) && !ret.includes(q)) {
          return false;
        }
      }
      return true;
    });
  }, [notes, statusFilter, search]);

  const money = (n: number) => Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2 });
  const isoDay = (d: string) => (d ? new Date(d).toISOString().slice(0, 10) : '');

  return (
    <Box>
      <PageHeader
        title="Credit Notes"
        subtitle="Manage and print statutory GST Credit Notes"
        actions={[
          ...(canCreateCN
            ? [
                {
                  label: 'New Credit Note',
                  icon: <Add />,
                  onClick: () => setCreateOpen(true),
                },
              ]
            : []),
          ...(canManageTemplates
            ? [
                {
                  label: 'Print Templates',
                  icon: <Settings />,
                  onClick: () => navigate('/sales/credit-note-templates'),
                },
              ]
            : []),
        ]}
      />

      {/* Filter Row */}
      <Stack direction="row" spacing={1.5} alignItems="center" flexWrap="wrap" useFlexGap sx={{ mb: 2 }}>
        <TextField
          size="small"
          placeholder="Search #, client, invoice..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          sx={{ width: 220 }}
        />

        <TextField
          select
          size="small"
          label="Status"
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as any)}
          sx={{ width: 140 }}
        >
          <MenuItem value="ALL">All Statuses</MenuItem>
          <MenuItem value="ACTIVE">Active Only</MenuItem>
          <MenuItem value="CANCELLED">Cancelled</MenuItem>
        </TextField>

        <DateField
          size="small"
          fullWidth={false}
          label="From"
          value={from}
          sx={{ width: 150 }}
          onChange={(e) => setFrom(e.target.value)}
        />
        <DateField
          size="small"
          fullWidth={false}
          label="To"
          value={to}
          error={rangeBad}
          helperText={rangeBad ? 'Must not be before From' : undefined}
          sx={{ width: 150 }}
          onChange={(e) => setTo(e.target.value)}
        />

        {(from || to || search || statusFilter !== 'ALL') && (
          <Button
            size="small"
            onClick={() => {
              setFrom('');
              setTo('');
              setSearch('');
              setStatusFilter('ALL');
            }}
          >
            Clear Filters
          </Button>
        )}
      </Stack>

      <DataTable
        tableId="sales-credit-notes"
        rows={rangeBad ? [] : filteredNotes}
        isLoading={isLoading && !rangeBad}
        getRowId={(n: any) => n.id}
        onRowClick={(n: any) => setSelectedId(n.id)}
        emptyLabel="No credit notes found"
        columns={[
          {
            key: 'creditNoteNumber',
            label: 'Credit Note #',
            width: 160,
            render: (n: any) => (
              <Typography
                sx={{
                  fontFamily: 'monospace',
                  fontWeight: 700,
                  color: n.status === 'CANCELLED' ? 'error.main' : '#44C47A',
                  fontSize: 13,
                  cursor: 'pointer',
                  textDecoration: n.status === 'CANCELLED' ? 'line-through' : 'none',
                }}
              >
                {n.creditNoteNumber}
              </Typography>
            ),
          },
          {
            key: 'creditNoteDate',
            label: 'Date',
            width: 110,
            filterValue: (n: any) => isoDay(n.creditNoteDate),
            render: (n: any) => (
              <Typography sx={{ fontSize: 12 }}>
                {new Date(n.creditNoteDate).toLocaleDateString('en-IN')}
              </Typography>
            ),
          },
          {
            key: 'client',
            label: 'Client',
            width: 190,
            filterValue: (n: any) => n.client?.name ?? n.buyerName ?? '',
            render: (n: any) => (
              <Box>
                <Typography fontWeight={600} noWrap fontSize={13}>
                  {n.client?.name || n.buyerName}
                </Typography>
                {n.client?.clientCode && (
                  <Typography variant="caption" color="text.secondary" sx={{ fontFamily: 'monospace' }}>
                    {n.client.clientCode}
                  </Typography>
                )}
              </Box>
            ),
          },
          {
            key: 'reference',
            label: 'Reference',
            width: 180,
            render: (n: any) => {
              const isRet = !!n.salesReturnId || !!n.salesReturn;
              return (
                <Box>
                  <Typography variant="body2" sx={{ fontFamily: 'monospace', fontSize: 11 }}>
                    Inv: {n.originalInvoiceNumber}
                  </Typography>
                  {isRet ? (
                    <Chip
                      label={`Ret #${n.salesReturn?.returnNumber || 'Linked'}`}
                      size="small"
                      color="info"
                      sx={{ height: 18, fontSize: 10, mt: 0.2 }}
                    />
                  ) : (
                    <Typography variant="caption" color="text.secondary">
                      Standalone
                    </Typography>
                  )}
                </Box>
              );
            },
          },
          {
            key: 'reasonCode',
            label: 'Reason',
            width: 140,
            render: (n: any) => (
              <Typography variant="body2" fontSize={12} noWrap title={n.reasonNotes || ''}>
                {REASON_LABELS[n.reasonCode] ?? n.reasonCode}
              </Typography>
            ),
          },
          {
            key: 'taxableAmount',
            label: 'Taxable',
            align: 'right',
            width: 120,
            render: (n: any) => (
              <Typography sx={{ fontFamily: 'monospace', fontSize: 12 }}>
                ₹ {money(n.taxableAmount)}
              </Typography>
            ),
          },
          {
            key: 'totalTax',
            label: 'Tax',
            align: 'right',
            width: 100,
            render: (n: any) => (
              <Typography sx={{ fontFamily: 'monospace', fontSize: 12, color: 'text.secondary' }}>
                ₹ {money(n.totalTax)}
              </Typography>
            ),
          },
          {
            key: 'totalAmount',
            label: 'Total Value',
            align: 'right',
            width: 130,
            render: (n: any) => (
              <Typography
                sx={{
                  fontFamily: 'monospace',
                  fontWeight: 700,
                  fontSize: 13,
                  color: n.status === 'CANCELLED' ? 'text.secondary' : '#44C47A',
                }}
              >
                ₹ {money(n.totalAmount)}
              </Typography>
            ),
          },
          {
            key: 'status',
            label: 'Status',
            width: 120,
            render: (n: any) => (
              <StatusChip status={n.status === 'CANCELLED' ? 'CANCELLED' : 'ACTIVE'} />
            ),
          },
          {
            key: 'actions',
            label: 'Actions',
            width: 100,
            align: 'center',
            hideable: false,
            filterable: false,
            render: (n: any) => (
              <Stack direction="row" spacing={0.5} justifyContent="center" onClick={(e) => e.stopPropagation()}>
                <Tooltip title="Preview Document">
                  <IconButton size="small" onClick={() => setPreviewNote(n)}>
                    <Visibility fontSize="small" />
                  </IconButton>
                </Tooltip>
                <Tooltip title="Print / PDF">
                  <IconButton size="small" onClick={() => printCreditNote(n)}>
                    <Print fontSize="small" />
                  </IconButton>
                </Tooltip>
              </Stack>
            ),
          },
        ]}
      />

      {/* Credit Note Detail Drawer */}
      {selectedId && (
        <CreditNoteDetailDrawer
          creditNoteId={selectedId}
          onClose={() => setSelectedId('')}
        />
      )}

      {/* Direct Preview Dialog from Row Action */}
      {previewNote && (
        <CreditNotePreviewDialog
          open={!!previewNote}
          creditNote={previewNote}
          onClose={() => setPreviewNote(null)}
        />
      )}

      {/* New Standalone Credit Note Dialog */}
      <NewCreditNoteDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={(id) => {
          setSelectedId(id);
        }}
      />
    </Box>
  );
}
