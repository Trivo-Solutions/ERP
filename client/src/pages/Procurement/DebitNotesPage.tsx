import { useState, useMemo, useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  Box, Stack, Typography, Chip, IconButton, Tooltip, MenuItem, TextField, Button,
  Dialog, DialogTitle, DialogContent, DialogActions,
} from '@mui/material';
import { Print, Visibility, Settings, Add } from '@mui/icons-material';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useSnackbar } from 'notistack';
import { apiGet, apiPost } from '../../api/client';
import { PageHeader } from '../../components/common/PageHeader';
import { DataTable } from '../../components/common/DataTable';
import { StatusChip } from '../../components/common/StatusChip';
import { DateField } from '../../components/fields/DateField';
import { useAuthStore } from '../../store/auth.store';
import { printDebitNote } from '../../utils/printDebitNote';
import { DebitNoteDetailDrawer } from '../../components/procurement/DebitNoteDetailDrawer';
import { DebitNotePreviewDialog } from '../../components/procurement/DebitNotePreviewDialog';

const REASON_LABELS: Record<string, string> = {
  PURCHASE_RETURN: 'Purchase Return',
  PRICE_VARIANCE: 'Price Variance',
  SHORT_SUPPLY: 'Short Supply',
  QUALITY_DEDUCTION: 'Quality Deduction',
  CORRECTION_IN_GRN: 'GRN Correction',
  OTHER: 'Other',
};

function NewDebitNoteDialog({
  open,
  initialGrnId,
  onClose,
  onCreated,
}: {
  open: boolean;
  initialGrnId?: string;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const { enqueueSnackbar } = useSnackbar();
  const qc = useQueryClient();
  const [grnId, setGrnId] = useState(initialGrnId || '');
  const [reasonCode, setReasonCode] = useState('PRICE_VARIANCE');
  const [reasonNotes, setReasonNotes] = useState('');
  const [description, setDescription] = useState('Price Variance Adjustment');
  const [taxableValue, setTaxableValue] = useState('');

  useEffect(() => {
    if (open) {
      setGrnId(initialGrnId || '');
      setReasonCode('PRICE_VARIANCE');
      setReasonNotes('');
      setDescription('Price Variance Adjustment');
      setTaxableValue('');
    }
  }, [open, initialGrnId]);

  const { data: grnsData, isLoading: loadingGrns } = useQuery({
    queryKey: ['grns-lookup'],
    queryFn: () => apiGet<any[]>('/procurement/grn'),
    enabled: open,
  });

  const grns: any[] = useMemo(() => {
    if (!Array.isArray(grnsData)) return [];
    return grnsData;
  }, [grnsData]);

  const selectedGrn = grns.find((g) => g.id === grnId);

  const mutation = useMutation({
    mutationFn: () =>
      apiPost<any>('/procurement/debit-notes', {
        grnId,
        reasonCode,
        reasonNotes: reasonNotes || undefined,
        items: [
          {
            description: description || 'Debit adjustment',
            taxableValue: Number(taxableValue),
          },
        ],
      }),
    onSuccess: (res: any) => {
      qc.invalidateQueries({ queryKey: ['procurement-debit-notes'] });
      qc.invalidateQueries({ queryKey: ['grns'] });
      enqueueSnackbar('Debit Note issued successfully', { variant: 'success' });
      onClose();
      const newId = res?.id || res?.data?.id;
      if (newId) onCreated(newId);
    },
    onError: (err: any) => {
      enqueueSnackbar(err.response?.data?.error ?? 'Failed to issue Debit Note', { variant: 'error' });
    },
  });

  const parsedTaxable = Number(taxableValue) || 0;
  const estTax = Math.round(parsedTaxable * 0.03 * 100) / 100;
  const estTotal = parsedTaxable + estTax;

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle sx={{ fontWeight: 700 }}>New Standalone Debit Note</DialogTitle>
      <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 2, pt: '10px !important' }}>
        <Typography variant="body2" color="text.secondary">
          Issue a value-only debit note (price variance, short supply, quality deduction, GRN correction) against an intake GRN.
        </Typography>

        <TextField
          select
          required
          size="small"
          label="Select Goods Receipt Note (GRN)"
          value={grnId}
          onChange={(e) => setGrnId(e.target.value)}
          disabled={loadingGrns}
          helperText={
            loadingGrns
              ? 'Loading GRNs...'
              : grns.length === 0
              ? 'No GRNs available'
              : selectedGrn
              ? `Supplier: ${selectedGrn.po?.supplier?.name ?? '—'} | Bill: ${selectedGrn.invoiceNumber || 'No bill #'}`
              : 'Pick a GRN to issue a debit note against'
          }
        >
          {grns.length === 0 ? (
            <MenuItem value="" disabled>No GRNs found</MenuItem>
          ) : (
            grns.map((g) => (
              <MenuItem key={g.id} value={g.id}>
                {g.grnNumber} — {g.po?.supplier?.name} ({new Date(g.receivedDate).toLocaleDateString('en-IN')})
              </MenuItem>
            ))
          )}
        </TextField>

        <TextField
          select
          required
          size="small"
          label="Reason for Debit Note"
          value={reasonCode}
          onChange={(e) => {
            setReasonCode(e.target.value);
            if (e.target.value === 'PRICE_VARIANCE') setDescription('Price Variance Adjustment');
            else if (e.target.value === 'SHORT_SUPPLY') setDescription('Short Supply Value Adjustment');
            else if (e.target.value === 'QUALITY_DEDUCTION') setDescription('Quality Discrepancy Deduction');
            else if (e.target.value === 'CORRECTION_IN_GRN') setDescription('GRN Entry Correction Adjustment');
          }}
        >
          <MenuItem value="PRICE_VARIANCE">Price Variance / Post-Receipt Price Adjustment</MenuItem>
          <MenuItem value="SHORT_SUPPLY">Short Supply / Less Quantity Received Than Billed</MenuItem>
          <MenuItem value="QUALITY_DEDUCTION">Quality Deduction / Material Discrepancy</MenuItem>
          <MenuItem value="CORRECTION_IN_GRN">Correction in GRN Details</MenuItem>
        </TextField>

        <TextField
          size="small"
          label="Reason Notes / Remarks (Optional)"
          value={reasonNotes}
          onChange={(e) => setReasonNotes(e.target.value)}
          placeholder="e.g. Rate difference agreed with supplier"
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
          disabled={!grnId || parsedTaxable <= 0 || mutation.isPending}
          onClick={() => mutation.mutate()}
          sx={{ bgcolor: '#44C47A', '&:hover': { bgcolor: '#38A866' } }}
        >
          {mutation.isPending ? 'Issuing...' : 'Issue Debit Note'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export function DebitNotesPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const initialGrnIdParam = searchParams.get('grnId') || '';

  const [selectedId, setSelectedId] = useState('');
  const [previewNote, setPreviewNote] = useState<any>(null);
  const [createOpen, setCreateOpen] = useState(!!initialGrnIdParam);

  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [statusFilter, setStatusFilter] = useState<'ALL' | 'ACTIVE' | 'CANCELLED'>('ALL');
  const [supplierFilter, setSupplierFilter] = useState('');
  const [search, setSearch] = useState('');

  const canCreateDN = useAuthStore((s) => s.hasPermission('debitNote:create'));
  const canManageTemplates = useAuthStore((s) => s.hasPermission('debitNoteTemplate:view'));

  const rangeBad = !!from && !!to && from > to;

  const { data: suppliersData } = useQuery({
    queryKey: ['procurement-suppliers-filter'],
    queryFn: () => apiGet<any[]>('/procurement/suppliers'),
  });
  const suppliers: any[] = suppliersData ?? [];

  const { data, isLoading } = useQuery({
    queryKey: ['procurement-debit-notes', from, to, supplierFilter],
    queryFn: () =>
      apiGet<any[]>('/procurement/debit-notes', {
        ...(from && { from }),
        ...(to && { to }),
        ...(supplierFilter && { supplierId: supplierFilter }),
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
        const num = (n.debitNoteNumber || '').toLowerCase();
        const sup = (n.supplier?.name || '').toLowerCase();
        const grn = (n.grn?.grnNumber || '').toLowerCase();
        const inv = (n.supplierInvoiceNumber || '').toLowerCase();
        const ret = (n.purchaseReturn?.returnNumber || '').toLowerCase();
        if (!num.includes(q) && !sup.includes(q) && !grn.includes(q) && !inv.includes(q) && !ret.includes(q)) {
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
        title="Debit Notes"
        subtitle="Manage and print procurement Debit Notes issued to suppliers"
        actions={[
          ...(canCreateDN
            ? [
                {
                  label: 'New Debit Note',
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
                  onClick: () => navigate('/procurement/debit-note-templates'),
                },
              ]
            : []),
        ]}
      />

      {/* Filter Row */}
      <Stack direction="row" spacing={1.5} alignItems="center" flexWrap="wrap" useFlexGap sx={{ mb: 2 }}>
        <TextField
          size="small"
          placeholder="Search #, supplier, GRN, bill..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          sx={{ width: 230 }}
        />

        <TextField
          select
          size="small"
          label="Supplier"
          value={supplierFilter}
          onChange={(e) => setSupplierFilter(e.target.value)}
          sx={{ width: 200 }}
        >
          <MenuItem value="">All Suppliers</MenuItem>
          {suppliers.map((s) => (
            <MenuItem key={s.id} value={s.id}>
              {s.name}
            </MenuItem>
          ))}
        </TextField>

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

        {(from || to || search || supplierFilter || statusFilter !== 'ALL') && (
          <Button
            size="small"
            onClick={() => {
              setFrom('');
              setTo('');
              setSearch('');
              setSupplierFilter('');
              setStatusFilter('ALL');
            }}
          >
            Clear Filters
          </Button>
        )}
      </Stack>

      <DataTable
        tableId="procurement-debit-notes"
        rows={rangeBad ? [] : filteredNotes}
        isLoading={isLoading && !rangeBad}
        getRowId={(n: any) => n.id}
        onRowClick={(n: any) => setSelectedId(n.id)}
        emptyLabel="No debit notes found"
        columns={[
          {
            key: 'debitNoteNumber',
            label: 'Debit Note #',
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
                {n.debitNoteNumber}
              </Typography>
            ),
          },
          {
            key: 'debitNoteDate',
            label: 'Date',
            width: 110,
            filterValue: (n: any) => isoDay(n.debitNoteDate),
            render: (n: any) => (
              <Typography sx={{ fontSize: 12 }}>
                {new Date(n.debitNoteDate).toLocaleDateString('en-IN')}
              </Typography>
            ),
          },
          {
            key: 'supplier',
            label: 'Supplier',
            width: 190,
            filterValue: (n: any) => n.supplier?.name ?? '',
            render: (n: any) => (
              <Box>
                <Typography fontWeight={600} noWrap fontSize={13}>
                  {n.supplier?.name}
                </Typography>
                {n.supplier?.supplierCode && (
                  <Typography variant="caption" color="text.secondary" sx={{ fontFamily: 'monospace' }}>
                    {n.supplier.supplierCode}
                  </Typography>
                )}
              </Box>
            ),
          },
          {
            key: 'reference',
            label: 'Reference',
            width: 190,
            render: (n: any) => {
              const isRet = !!n.purchaseReturnId || !!n.purchaseReturn;
              return (
                <Box>
                  {n.grn?.grnNumber && (
                    <Typography variant="body2" sx={{ fontFamily: 'monospace', fontSize: 11 }}>
                      GRN: {n.grn.grnNumber}
                    </Typography>
                  )}
                  {n.supplierInvoiceNumber && (
                    <Typography variant="caption" color="text.secondary" sx={{ fontFamily: 'monospace', display: 'block' }}>
                      Bill: {n.supplierInvoiceNumber}
                    </Typography>
                  )}
                  {isRet ? (
                    <Chip
                      label={`Ret #${n.purchaseReturn?.returnNumber || 'Linked'}`}
                      size="small"
                      color="info"
                      sx={{ height: 18, fontSize: 10, mt: 0.2 }}
                    />
                  ) : (
                    <Typography variant="caption" color="text.secondary">
                      Standalone GRN Adj
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
                  <IconButton size="small" onClick={() => printDebitNote(n)}>
                    <Print fontSize="small" />
                  </IconButton>
                </Tooltip>
              </Stack>
            ),
          },
        ]}
      />

      {/* Debit Note Detail Drawer */}
      {selectedId && (
        <DebitNoteDetailDrawer
          debitNoteId={selectedId}
          onClose={() => setSelectedId('')}
        />
      )}

      {/* Direct Preview Dialog from Row Action */}
      {previewNote && (
        <DebitNotePreviewDialog
          open={!!previewNote}
          debitNote={previewNote}
          onClose={() => setPreviewNote(null)}
        />
      )}

      {/* New Standalone Debit Note Dialog */}
      <NewDebitNoteDialog
        open={createOpen}
        initialGrnId={initialGrnIdParam}
        onClose={() => setCreateOpen(false)}
        onCreated={(id) => {
          setSelectedId(id);
        }}
      />
    </Box>
  );
}
