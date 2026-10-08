import { useMemo, useRef, useState } from 'react';
import {
  Box, Card, Grid, Typography, Chip, Button, TextField, Autocomplete, Dialog, DialogTitle, DialogContent,
  DialogActions, Drawer, IconButton, Divider, Alert, Tooltip, CircularProgress, InputAdornment, LinearProgress,
} from '@mui/material';
import { Print, Close, Undo, FileDownload, Add, DeleteOutline } from '@mui/icons-material';
import { useQuery, useMutation, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { useSnackbar } from 'notistack';
import { apiGet, apiPost } from '../../api/client';
import { useAuthStore } from '../../store/auth.store';
import { PageHeader, PageActions } from '../../components/common/PageHeader';
import { DataTable, DataTableColumn } from '../../components/common/DataTable';
import { SelectField } from '../../components/fields/SelectField';
import { DateField } from '../../components/fields/DateField';
import { exportToCsv } from '../../utils/exportToCsv';
import { printAdvanceReceipt, advanceModeLabel } from '../../utils/printAdvanceReceipt';

// Customer Advances — money a customer pays BEFORE any invoice. Held as a liability and later adjusted against a
// bill; deliberately not Store Credit and not part of the customer's account balance.

const money = (n: unknown) => '₹' + Number(n ?? 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const dateTime = (v: unknown) => v ? new Date(v as string).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
const isoDay = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);

const MODES = [
  { value: 'CASH', label: 'Cash' }, { value: 'UPI', label: 'UPI' }, { value: 'CARD', label: 'Card' },
  { value: 'BANK_TRANSFER', label: 'Bank Transfer' }, { value: 'CHEQUE', label: 'Cheque' },
];
const STATUS_LABEL: Record<string, string> = {
  ACTIVE: 'Active', PARTIALLY_APPLIED: 'Partially Applied', FULLY_APPLIED: 'Fully Applied', REFUNDED: 'Refunded', REVERSED: 'Reversed',
};
const STATUS_COLOR: Record<string, 'success' | 'warning' | 'default' | 'error' | 'info'> = {
  ACTIVE: 'success', PARTIALLY_APPLIED: 'warning', FULLY_APPLIED: 'default', REFUNDED: 'info', REVERSED: 'error',
};
const errMsg = (e: any, fallback: string) => e?.response?.data?.error ?? e?.response?.data?.message ?? fallback;

const today = () => isoDay(new Date());
const thirtyDaysAgo = () => isoDay(new Date(Date.now() - 30 * 86400000));
const DEFAULT_FILTERS = () => ({ dateFrom: thirtyDaysAgo(), dateTo: today(), clientId: '', branchId: '', advanceNumber: '', mode: '', createdById: '', status: '' });

export function CustomerAdvances() {
  const qc = useQueryClient();
  const { enqueueSnackbar } = useSnackbar();
  const { hasPermission, company } = useAuthStore();
  const canCreate = hasPermission('payment:create');
  const canReverse = hasPermission('payment:reverse');
  const companyName = company?.name ?? 'Company';

  const [filters, setFilters] = useState(DEFAULT_FILTERS);
  const [newOpen, setNewOpen] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [reverseTarget, setReverseTarget] = useState<any | null>(null);
  const set = (k: keyof ReturnType<typeof DEFAULT_FILTERS>, v: string) => setFilters((f) => ({ ...f, [k]: v }));

  const { data: clients } = useQuery({ queryKey: ['clients'], queryFn: () => apiGet<any[]>('/orders/clients'), retry: false });
  const params = useMemo(() => Object.fromEntries(Object.entries(filters).filter(([, v]) => v)), [filters]);
  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['customer-advances', params],
    queryFn: () => apiGet<any>('/sales/advances', params),
    placeholderData: keepPreviousData,
  });
  const rows: any[] = data?.rows ?? [];
  const totals = data?.totals ?? { count: 0, amount: 0, applied: 0, available: 0, reversedCount: 0 };
  const branchOptions: any[] = data?.branchOptions ?? [];
  const selectedClient = (clients ?? []).find((c: any) => c.id === filters.clientId) ?? null;

  const refresh = () => qc.invalidateQueries({ queryKey: ['customer-advances'] });

  const columns: DataTableColumn[] = [
    { key: 'advanceDate', label: 'Date & Time', width: 160, render: (r) => dateTime(r.advanceDate), filterValue: (r) => dateTime(r.advanceDate), sortValue: (r) => new Date(r.advanceDate).getTime(), csvValue: (r) => dateTime(r.advanceDate) },
    { key: 'advanceNumber', label: 'Advance No.', width: 150, render: (r) => <Typography variant="body2" sx={{ fontFamily: 'monospace', fontWeight: 600 }}>{r.advanceNumber}</Typography>, filterValue: (r) => r.advanceNumber },
    { key: 'customer', label: 'Customer', width: 200, render: (r) => r.client?.name, filterValue: (r) => r.client?.name ?? '' },
    { key: 'amount', label: 'Amount', align: 'right', width: 130, render: (r) => money(r.amount), filterValue: (r) => money(r.amount), sortValue: (r) => r.amount },
    { key: 'applied', label: 'Applied', align: 'right', width: 120, render: (r) => money(r.appliedAmount), filterValue: (r) => money(r.appliedAmount), sortValue: (r) => r.appliedAmount },
    {
      key: 'available', label: 'Available', align: 'right', width: 140,
      render: (r) => <Typography variant="body2" fontWeight={700} color={r.availableAmount > 0 ? 'success.main' : 'text.disabled'}>{money(r.availableAmount)}</Typography>,
      filterValue: (r) => money(r.availableAmount), sortValue: (r) => r.availableAmount,
    },
    { key: 'mode', label: 'Payment Mode', width: 130, render: (r) => advanceModeLabel(r.mode), filterValue: (r) => advanceModeLabel(r.mode) },
    { key: 'branch', label: 'Branch', width: 140, render: (r) => r.branch?.name, filterValue: (r) => r.branch?.name ?? '' },
    { key: 'createdBy', label: 'Created By', width: 140, render: (r) => r.createdBy?.name, filterValue: (r) => r.createdBy?.name ?? '' },
    { key: 'status', label: 'Status', width: 140, render: (r) => <Chip size="small" label={STATUS_LABEL[r.status] ?? r.status} color={STATUS_COLOR[r.status] ?? 'default'} variant={r.status === 'ACTIVE' ? 'filled' : 'outlined'} />, filterValue: (r) => STATUS_LABEL[r.status] ?? r.status },
    {
      key: 'actions', label: 'Actions', width: 110, hideable: false, filterable: false,
      render: (r) => (
        <Box onClick={(e) => e.stopPropagation()} sx={{ display: 'flex' }}>
          <Tooltip title="Print receipt"><IconButton size="small" aria-label="Print receipt" onClick={() => printAdvanceReceipt(r, companyName)}><Print fontSize="small" /></IconButton></Tooltip>
          {canReverse && r.status === 'ACTIVE' && (
            <Tooltip title="Reverse (unused advances only)"><IconButton size="small" color="error" aria-label="Reverse advance" onClick={() => setReverseTarget(r)}><Undo fontSize="small" /></IconButton></Tooltip>
          )}
        </Box>
      ),
    },
  ];

  const exportCsv = () => exportToCsv(`customer-advances-${today()}`, [
    { header: 'Date & Time', value: (r: any) => dateTime(r.advanceDate) },
    { header: 'Advance No.', value: (r: any) => r.advanceNumber },
    { header: 'Customer', value: (r: any) => r.client?.name ?? '' },
    { header: 'Customer Code', value: (r: any) => r.client?.clientCode ?? '' },
    { header: 'Amount', value: (r: any) => r.amount },
    { header: 'Applied Amount', value: (r: any) => r.appliedAmount },
    { header: 'Refunded Amount', value: (r: any) => r.refundedAmount },
    { header: 'Available Amount', value: (r: any) => r.availableAmount },
    { header: 'Payment Mode', value: (r: any) => advanceModeLabel(r.mode) },
    { header: 'Reference No.', value: (r: any) => r.referenceNo ?? '' },
    { header: 'Branch', value: (r: any) => r.branch?.name ?? '' },
    { header: 'Created By', value: (r: any) => r.createdBy?.name ?? '' },
    { header: 'Status', value: (r: any) => STATUS_LABEL[r.status] ?? r.status },
    { header: 'Reversed At', value: (r: any) => (r.reversedAt ? dateTime(r.reversedAt) : '') },
    { header: 'Reversed By', value: (r: any) => r.reversedBy?.name ?? '' },
    { header: 'Reversal Reason', value: (r: any) => r.reversalReason ?? '' },
    { header: 'Notes', value: (r: any) => r.notes ?? '' },
  ], rows);

  return (
    <Box>
      <PageHeader title="Customer Advances" subtitle="Payments received in advance for future jewellery purchases — kept separate from Store Credit." />

      <Card sx={{ p: 2, mb: 2 }}>
        <Grid container spacing={1.5} alignItems="center">
          <Grid item xs={6} sm={3} md={1.8}><DateField size="small" label="Date From" value={filters.dateFrom} onChange={(e) => set('dateFrom', e.target.value)} /></Grid>
          <Grid item xs={6} sm={3} md={1.8}><DateField size="small" label="Date To" value={filters.dateTo} onChange={(e) => set('dateTo', e.target.value)} /></Grid>
          <Grid item xs={12} sm={6} md={2.4}>
            <Autocomplete
              size="small" options={clients ?? []} value={selectedClient}
              getOptionLabel={(c: any) => `${c.name}${c.phone ? ` · ${c.phone}` : ''} (${c.clientCode})`}
              onChange={(_, v: any) => set('clientId', v?.id ?? '')}
              isOptionEqualToValue={(a: any, b: any) => a.id === b.id}
              renderInput={(p) => <TextField {...p} label="Customer" InputLabelProps={{ ...p.InputLabelProps, shrink: true }} />}
            />
          </Grid>
          <Grid item xs={6} sm={3} md={1.8}><SelectField size="small" label="Branch" emptyLabel="All branches" value={filters.branchId} onChange={(e) => set('branchId', e.target.value)} options={branchOptions.map((b) => ({ value: b.id, label: b.name }))} /></Grid>
          <Grid item xs={6} sm={3} md={1.8}><TextField size="small" fullWidth label="Advance No." InputLabelProps={{ shrink: true }} value={filters.advanceNumber} onChange={(e) => set('advanceNumber', e.target.value)} /></Grid>
          <Grid item xs={6} sm={3} md={1.8}><SelectField size="small" label="Payment Mode" emptyLabel="All modes" value={filters.mode} onChange={(e) => set('mode', e.target.value)} options={MODES} /></Grid>
          <Grid item xs={6} sm={3} md={1.8}><SelectField size="small" label="Created By" emptyLabel="Everyone" value={filters.createdById} onChange={(e) => set('createdById', e.target.value)} options={(data?.createdByOptions ?? []).map((u: any) => ({ value: u.id, label: u.name }))} /></Grid>
          <Grid item xs={6} sm={3} md={1.8}><SelectField size="small" label="Status" emptyLabel="All statuses" value={filters.status} onChange={(e) => set('status', e.target.value)} options={Object.entries(STATUS_LABEL).map(([value, label]) => ({ value, label }))} /></Grid>
          <Grid item xs="auto"><Button onClick={() => setFilters(DEFAULT_FILTERS())}>Clear filters</Button></Grid>
          <Grid item sx={{ ml: 'auto' }}>
            <PageActions actions={[
              { label: 'Export CSV', icon: <FileDownload />, variant: 'outlined', onClick: exportCsv },
              ...(canCreate ? [{ label: '+ New Advance', variant: 'contained' as const, onClick: () => setNewOpen(true) }] : []),
            ]} />
          </Grid>
        </Grid>
      </Card>

      <Grid container spacing={1.5} sx={{ mb: 2 }}>
        {[
          ['Total Advances', String(totals.count), undefined],
          ['Total Amount', money(totals.amount), undefined],
          ['Total Applied', money(totals.applied), undefined],
          ['Total Available', money(totals.available), 'success.main'],
        ].map(([label, value, color]) => (
          <Grid item xs={6} md={3} key={label as string}>
            <Card sx={{ p: 1.5 }}>
              <Typography variant="caption" color="text.secondary">{label}</Typography>
              <Typography variant="h6" fontWeight={700} color={color as string | undefined}>{value}</Typography>
            </Card>
          </Grid>
        ))}
      </Grid>
      {totals.reversedCount > 0 && <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>Totals exclude {totals.reversedCount} reversed advance{totals.reversedCount > 1 ? 's' : ''}.</Typography>}

      {isError ? (
        <Alert severity="error" action={<Button color="inherit" size="small" onClick={() => refetch()}>Retry</Button>}>{errMsg(error, 'Could not load customer advances')}</Alert>
      ) : (
        <Card>
          {isLoading && <LinearProgress />}
          <DataTable
            tableId="customer-advances" columns={columns} rows={rows} isLoading={false} getRowId={(r) => r.id}
            onRowClick={(r) => setDetailId(r.id)} sortable pageSizeOptions={[25, 50, 100]}
            emptyLabel="No customer advances match these filters."
          />
        </Card>
      )}

      {newOpen && <NewAdvanceDialog clients={clients ?? []} branches={branchOptions} onClose={() => setNewOpen(false)}
        onCreated={(adv) => { setNewOpen(false); refresh(); setDetailId(adv.id); }} companyName={companyName} />}
      <AdvanceDetailDrawer id={detailId} onClose={() => setDetailId(null)} companyName={companyName} />
      {reverseTarget && <ReverseDialog advance={reverseTarget} onClose={() => setReverseTarget(null)}
        onDone={() => { setReverseTarget(null); refresh(); qc.invalidateQueries({ queryKey: ['customer-advance'] }); enqueueSnackbar('Advance reversed', { variant: 'success' }); }} />}
    </Box>
  );
}

// ─── New advance ─────────────────────────────────────────────────────────────

const MAX_PAY_LINES = 10; // matches the server cap
type PayLine = { key: number; mode: string; amount: string; referenceNo: string };

function NewAdvanceDialog({ clients, branches, onClose, onCreated, companyName }: { clients: any[]; branches: any[]; onClose: () => void; onCreated: (a: any) => void; companyName: string }) {
  const { enqueueSnackbar } = useSnackbar();
  const [client, setClient] = useState<any | null>(null);
  const [branchId, setBranchId] = useState(branches.length === 1 ? branches[0].id : '');
  // One line per payment mode (a split receipt has several, e.g. Cash + UPI); the advance is their total.
  const nextKey = useRef(1);
  const [lines, setLines] = useState<PayLine[]>([{ key: 0, mode: 'CASH', amount: '', referenceNo: '' }]);
  const setLine = (key: number, patch: Partial<PayLine>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const addLine = () => setLines((ls) => (ls.length >= MAX_PAY_LINES ? ls : [...ls, { key: nextKey.current++, mode: ls[ls.length - 1]?.mode ?? 'CASH', amount: '', referenceNo: '' }]));
  const [notes, setNotes] = useState('');
  const [touched, setTouched] = useState(false);
  const [done, setDone] = useState<any | null>(null);
  // One key per dialog: a retry after a timeout, or a double click, resolves to the same advance on the server.
  const idempotencyKey = useRef(globalThis.crypto?.randomUUID?.() ?? `adv-${Date.now()}-${Math.random()}`).current;
  const submitting = useRef(false);

  const lineError = (l: PayLine) => {
    const a = Number(l.amount);
    return !l.amount ? 'Enter the amount' : !(a > 0) ? 'Amount must be greater than zero' : Math.abs(a * 100 - Math.round(a * 100)) > 1e-6 ? 'Up to 2 decimal places' : '';
  };
  const amt = lines.reduce((sum, l) => sum + (Number(l.amount) > 0 ? Math.round(Number(l.amount) * 100) : 0), 0) / 100;
  const errors = { client: client ? '' : 'Select a customer', branch: branchId ? '' : 'Select a branch' };
  const invalid = !!(errors.client || errors.branch || lines.some((l) => lineError(l)));
  const split = lines.length > 1;

  const save = useMutation({
    mutationFn: () => apiPost<any>('/sales/advances', {
      clientId: client.id, branchId, notes: notes || undefined, idempotencyKey,
      payments: lines.map((l) => ({ mode: l.mode, amount: Number(l.amount), referenceNo: l.mode !== 'CASH' && l.referenceNo ? l.referenceNo : undefined })),
    }),
    onSuccess: (adv) => { setDone(adv); enqueueSnackbar(`Advance ${adv.advanceNumber} received`, { variant: 'success' }); },
    onError: (e: any) => enqueueSnackbar(errMsg(e, 'Could not save the advance'), { variant: 'error' }),
    onSettled: () => { submitting.current = false; },
  });
  const submit = () => {
    setTouched(true);
    if (invalid || submitting.current || save.isPending || done) return;
    submitting.current = true;
    save.mutate();
  };

  if (done) {
    return (
      <Dialog open onClose={() => onCreated(done)} maxWidth="xs" fullWidth>
        <DialogTitle>Advance received</DialogTitle>
        <DialogContent>
          <Typography>{done.advanceNumber}</Typography>
          <Typography variant="h5" fontWeight={700} sx={{ my: 1 }}>{money(done.amount)}</Typography>
          <Typography variant="body2" color="text.secondary">from {done.client?.name}. It is now available for a future purchase.</Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => onCreated(done)}>Done</Button>
          <Button variant="contained" startIcon={<Print />} onClick={() => printAdvanceReceipt(done, companyName)} autoFocus>Print Receipt</Button>
        </DialogActions>
      </Dialog>
    );
  }

  return (
    <Dialog open onClose={save.isPending ? undefined : onClose} maxWidth="sm" fullWidth>
      <form onSubmit={(e) => { e.preventDefault(); submit(); }} noValidate>
        <DialogTitle sx={{ pb: 0.5 }}>
          Receive Customer Advance
          <Typography variant="body2" color="text.secondary" fontWeight={400}>Receive payment now and keep it available for a future jewellery purchase.</Typography>
        </DialogTitle>
        <DialogContent>
          <Grid container spacing={1.75} sx={{ mt: 0 }}>
            <Grid item xs={12}>
              <Autocomplete
                autoFocus openOnFocus options={clients} value={client} onChange={(_, v) => setClient(v)}
                getOptionLabel={(c: any) => `${c.name}${c.phone ? ` · ${c.phone}` : ''} (${c.clientCode})`}
                isOptionEqualToValue={(a: any, b: any) => a.id === b.id}
                renderInput={(p) => <TextField {...p} autoFocus required label="Customer" size="small" InputLabelProps={{ ...p.InputLabelProps, shrink: true }} placeholder="Search by name, phone or code"
                  error={touched && !!errors.client} helperText={touched ? errors.client : ' '} />}
              />
            </Grid>
            <Grid item xs={12} sm={6}>
              <SelectField size="small" required label="Branch" value={branchId} onChange={(e) => setBranchId(e.target.value)} emptyLabel="Select branch"
                options={branches.map((b) => ({ value: b.id, label: b.name }))} error={touched && !!errors.branch} helperText={touched ? errors.branch : ' '} />
            </Grid>
            {lines.map((l, i) => {
              const err = lineError(l);
              return (
                <Grid item xs={12} key={l.key}>
                  <Grid container spacing={1.5} alignItems="flex-start">
                    <Grid item xs={12} sm={3.5}>
                      <SelectField size="small" required label={split ? `Payment Mode ${i + 1}` : 'Payment Mode'} value={l.mode} onChange={(e) => setLine(l.key, { mode: e.target.value })}
                        options={MODES} helperText=" " />
                    </Grid>
                    <Grid item xs={6} sm={3.5}>
                      <TextField size="small" fullWidth required label="Amount" value={l.amount} inputMode="decimal" InputLabelProps={{ shrink: true }}
                        onChange={(e) => setLine(l.key, { amount: e.target.value.replace(/[^0-9.]/g, '') })}
                        InputProps={{ startAdornment: <InputAdornment position="start">₹</InputAdornment> }}
                        error={touched && !!err} helperText={touched && err ? err : ' '} />
                    </Grid>
                    <Grid item xs={split ? 4.5 : 6} sm={split ? 4 : 5}>
                      <TextField size="small" fullWidth label={l.mode !== 'CASH' ? 'Reference No.' : 'Reference (n/a for cash)'} disabled={l.mode === 'CASH'} value={l.mode !== 'CASH' ? l.referenceNo : ''}
                        onChange={(e) => setLine(l.key, { referenceNo: e.target.value })} InputLabelProps={{ shrink: true }} helperText=" " />
                    </Grid>
                    {split && (
                      <Grid item xs={1.5} sm={1}>
                        <Tooltip title="Remove this payment"><IconButton size="small" aria-label="Remove payment" onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}><DeleteOutline fontSize="small" /></IconButton></Tooltip>
                      </Grid>
                    )}
                  </Grid>
                </Grid>
              );
            })}
            {lines.length < MAX_PAY_LINES && (
              <Grid item xs={12} sx={{ mt: -1 }}>
                <Button size="small" startIcon={<Add />} onClick={addLine}>Split payment</Button>
              </Grid>
            )}
            <Grid item xs={12}>
              <TextField size="small" fullWidth multiline minRows={2} label="Notes" value={notes} onChange={(e) => setNotes(e.target.value)} InputLabelProps={{ shrink: true }} placeholder="e.g. for wedding set, due in November" />
            </Grid>
            <Grid item xs={12}>
              <Box sx={{ p: 1.5, borderRadius: 1, bgcolor: 'action.hover' }}>
                <Box sx={{ display: 'flex', justifyContent: 'space-between' }}><Typography variant="body2">Advance Amount</Typography><Typography variant="body2" fontWeight={600}>{money(amt > 0 ? amt : 0)}</Typography></Box>
                <Box sx={{ display: 'flex', justifyContent: 'space-between' }}><Typography variant="body2">Available Immediately</Typography><Typography variant="body2" fontWeight={700} color="success.main">{money(amt > 0 ? amt : 0)}</Typography></Box>
              </Box>
            </Grid>
          </Grid>
        </DialogContent>
        <DialogActions>
          <Button onClick={onClose} disabled={save.isPending}>Cancel</Button>
          <Button type="submit" variant="contained" disabled={save.isPending} startIcon={save.isPending ? <CircularProgress size={16} color="inherit" /> : undefined}>
            {save.isPending ? 'Saving…' : 'Receive Advance'}
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  );
}

// ─── Reverse ─────────────────────────────────────────────────────────────────

function ReverseDialog({ advance, onClose, onDone }: { advance: any; onClose: () => void; onDone: () => void }) {
  const { enqueueSnackbar } = useSnackbar();
  const [reason, setReason] = useState('');
  const m = useMutation({
    mutationFn: () => apiPost(`/sales/advances/${advance.id}/reverse`, { reason }),
    onSuccess: onDone,
    onError: (e: any) => enqueueSnackbar(errMsg(e, 'Could not reverse the advance'), { variant: 'error' }),
  });
  return (
    <Dialog open onClose={m.isPending ? undefined : onClose} maxWidth="xs" fullWidth>
      <DialogTitle>Reverse advance {advance.advanceNumber}?</DialogTitle>
      <DialogContent>
        <Typography variant="body2" sx={{ mb: 1.5 }}>
          {money(advance.amount)} received from {advance.client?.name} will be taken back out of Customer Advances. The advance stays in the register, marked Reversed. This cannot be undone, and only works while nothing has been used.
        </Typography>
        <TextField autoFocus fullWidth size="small" required label="Reason" value={reason} onChange={(e) => setReason(e.target.value)} InputLabelProps={{ shrink: true }} />
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={m.isPending}>Cancel</Button>
        <Button color="error" variant="contained" disabled={!reason.trim() || m.isPending} onClick={() => m.mutate()}>Reverse Advance</Button>
      </DialogActions>
    </Dialog>
  );
}

// ─── Detail ──────────────────────────────────────────────────────────────────

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <Box sx={{ display: 'flex', justifyContent: 'space-between', gap: 2, py: 0.5 }}>
      <Typography variant="body2" color="text.secondary">{label}</Typography>
      <Typography variant="body2" fontWeight={600} sx={{ textAlign: 'right' }} component="div">{children}</Typography>
    </Box>
  );
}
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return <Box sx={{ mb: 2 }}><Typography variant="overline" color="text.secondary">{title}</Typography><Divider sx={{ mb: 0.5 }} />{children}</Box>;
}

function AdvanceDetailDrawer({ id, onClose, companyName }: { id: string | null; onClose: () => void; companyName: string }) {
  const { data: a, isLoading, isError } = useQuery({ queryKey: ['customer-advance', id], queryFn: () => apiGet<any>(`/sales/advances/${id}`), enabled: !!id });
  // Where this advance has been spent (applied to an invoice), newest first; reversed applications stay listed.
  const { data: apps } = useQuery({ queryKey: ['customer-advance-apps', id], queryFn: () => apiGet<any[]>(`/sales/advances/${id}/applications`), enabled: !!id && !!a && Number(a.appliedAmount) > 0 });
  const appRows: any[] = (apps as any)?.data ?? (Array.isArray(apps) ? apps : []);
  return (
    <Drawer anchor="right" open={!!id} onClose={onClose} PaperProps={{ sx: { width: { xs: '100%', sm: 420 } } }}>
      <Box sx={{ p: 2.5 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 1 }}>
          <Typography variant="h6" fontWeight={700}>Advance Details</Typography>
          <IconButton onClick={onClose} aria-label="Close"><Close /></IconButton>
        </Box>
        {isLoading && <LinearProgress />}
        {isError && <Alert severity="error">Could not load this advance.</Alert>}
        {a && (
          <>
            <Section title="Advance">
              <Field label="Advance No.">{a.advanceNumber}</Field>
              <Field label="Date & Time">{dateTime(a.advanceDate)}</Field>
              <Field label="Status"><Chip size="small" label={STATUS_LABEL[a.status] ?? a.status} color={STATUS_COLOR[a.status] ?? 'default'} /></Field>
              <Field label="Branch">{a.branch?.name}</Field>
            </Section>
            <Section title="Customer">
              <Field label="Name">{a.client?.name}</Field>
              <Field label="Customer Code">{a.client?.clientCode}</Field>
              {a.client?.phone && <Field label="Phone">{a.client.phone}</Field>}
            </Section>
            <Section title="Payment">
              <Field label="Advance Amount">{money(a.amount)}</Field>
              <Field label="Applied">{money(a.appliedAmount)}</Field>
              <Field label="Available Advance"><Box component="span" sx={{ color: a.availableAmount > 0 ? 'success.main' : 'text.disabled' }}>{money(a.availableAmount)}</Box></Field>
              {a.payments?.length > 1
                ? a.payments.map((p: any) => <Field key={p.id} label={advanceModeLabel(p.mode)}>{money(p.amount)}{p.referenceNo ? ` · ${p.referenceNo}` : ''}</Field>)
                : <><Field label="Payment Mode">{advanceModeLabel(a.mode)}</Field>
                  {a.referenceNo && <Field label="Reference No.">{a.referenceNo}</Field>}</>}
            </Section>
            {appRows.length > 0 && (
              <Section title="Applied to invoices">
                {appRows.map((r) => (
                  <Box key={r.id} sx={{ py: 0.75, opacity: r.reversedAt ? 0.6 : 1 }}>
                    <Box sx={{ display: 'flex', justifyContent: 'space-between' }}>
                      <Typography variant="body2" fontWeight={600}>{r.invoice?.invoiceNumber}</Typography>
                      <Typography variant="body2" fontWeight={600} sx={{ textDecoration: r.reversedAt ? 'line-through' : undefined }}>{money(r.amount)}</Typography>
                    </Box>
                    <Typography variant="caption" color="text.secondary" component="div">
                      Invoice {r.invoice?.invoiceDate ? dateTime(r.invoice.invoiceDate) : ''} · applied {dateTime(r.appliedAt)}{r.invoice?.branch?.name ? ` · ${r.invoice.branch.name}` : ''}
                    </Typography>
                    {r.reversedAt && <Chip size="small" color="warning" label={`Reversed ${dateTime(r.reversedAt)}`} sx={{ mt: 0.5 }} />}
                  </Box>
                ))}
              </Section>
            )}
            <Section title="Audit">
              <Field label="Created By">{a.createdBy?.name}</Field>
              <Field label="Created At">{dateTime(a.createdAt)}</Field>
            </Section>
            {a.notes && <Section title="Notes"><Typography variant="body2" sx={{ whiteSpace: 'pre-wrap' }}>{a.notes}</Typography></Section>}
            {a.reversedAt && (
              <Section title="Reversal">
                <Field label="Reversed At">{dateTime(a.reversedAt)}</Field>
                <Field label="Reversed By">{a.reversedBy?.name}</Field>
                <Field label="Reason">{a.reversalReason}</Field>
              </Section>
            )}
            <Button fullWidth variant="outlined" startIcon={<Print />} onClick={() => printAdvanceReceipt(a, companyName)}>{a.reversedAt ? 'Reprint Receipt' : 'Print Receipt'}</Button>
          </>
        )}
      </Box>
    </Drawer>
  );
}
