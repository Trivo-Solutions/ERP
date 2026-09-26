import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Box, Card, Table, TableHead, TableBody, TableRow, TableCell, Typography, Chip, Button,
  Grid, MenuItem, TextField, Stack, Divider, IconButton, Autocomplete, Tabs, Tab,
  Checkbox, FormControlLabel, Dialog, DialogTitle, DialogContent, DialogActions, Alert,
} from '@mui/material';
import { Add, Delete, Print, AddCircleOutline, CheckCircle, ArrowBack, PersonAdd } from '@mui/icons-material';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm, Controller } from 'react-hook-form';
import { useSnackbar } from 'notistack';
import { apiGet, apiPost } from '../../api/client';
import { PageHeader } from '../../components/common/PageHeader';
import { ClientKycDialog } from '../../components/common/ClientKycDialog';
import { SelectField } from '../../components/fields/SelectField';
import { printInvoice } from '../../utils/printInvoice';
import { findMakingCharge } from '../../utils/estimateCalc';
import { EstimateBreakdown, EstimateBreakdownDialog, estimateTotals, newRowKey } from './EstimateBreakdown';

// Statutory limits the server enforces (shared/compliance.ts) — mirrored here only to warn before submitting.
const PAN_REQUIRED_ABOVE = 200000;   // Rule 114B: PAN / Form 60 on a sale above this
const CASH_RECEIPT_LIMIT = 200000;   // Sec 269ST: cash of this much or more from one person in a day is not allowed
const GSTIN_WITH_PAN = /^\d{2}[A-Z]{5}\d{4}[A-Z][0-9A-Z]{3}$/i;

function fmt(n: number) {
  return '₹' + Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });
}

interface LineItem {
  key: string;
  tagId?: string;
  tagNumber?: string;
  productCode: string;
  description: string;
  huid?: string;
  karat?: string;
  quantity: number;
  grossWeight: number;
  netGoldWeight: number;
  stoneWeight: number;
  goldRate: number;
  makingCharge: number;
  wastagePercent: number;
  stoneValue: number;
  categoryId?: string;
  categoryName?: string;
  // A line loaded from an estimate keeps its material rows + MC/VA so they can be edited; its price is derived
  // from them, and it goes to the server as a flat (FIXED) amount. `quotedTotal` is what the estimate said.
  estimateId?: string;
  estimateNumber?: string;
  quotedTotal?: number;
  estimate?: EstimateBreakdown;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

function lineTotal(l: LineItem) {
  if (l.estimate) return round2(estimateTotals(l.estimate).total);
  const effectiveMaking = Number(l.makingCharge) * (1 + Number(l.wastagePercent || 0) / 100);
  const unit = Number(l.netGoldWeight) * Number(l.goldRate) + effectiveMaking + Number(l.stoneValue);
  return unit * Number(l.quantity || 1);
}

// The invoice line for an estimate-backed row: the piece itself at the (possibly edited) estimate total.
function estimateInvoiceLine(l: LineItem) {
  const t = estimateTotals(l.estimate!);
  return {
    productCode: l.productCode || l.tagNumber || 'ITEM',
    description: l.description,
    huid: l.huid || undefined,
    karat: l.karat || undefined,
    quantity: 1,
    grossWeight: Number(l.grossWeight) || 0,
    netGoldWeight: t.metalWeight || Number(l.netGoldWeight) || 0,
    stoneWeight: Number(l.stoneWeight) || 0,
    rateType: 'FIXED',
    goldRate: round2(t.total),          // FIXED: this IS the decided price
    makingCharge: round2(t.making),     // informational on a FIXED line
    wastagePercent: 0,
    stoneValue: round2(t.otherMaterials),
    tagId: l.tagId,
    categoryId: l.categoryId || undefined,
  };
}

// A single payment split — one sale can be paid across several modes (e.g. part cash, part UPI).
// Each split gets its own server-generated transaction number (PMT-YYYY-NNNNNN) at creation time.
interface PaymentSplit {
  key: string;
  paymentDate: string;
  amount: number;
  mode: string;
  referenceNo: string;
  notes: string;
}

// ─── Quick-add Client dialog ────────────────────────────────────────────────────

function QuickAddClientDialog({ open, onClose, onCreated }: {
  open: boolean; onClose: () => void; onCreated: (client: any) => void;
}) {
  const { enqueueSnackbar } = useSnackbar();
  const qc = useQueryClient();
  const { control, handleSubmit, reset } = useForm({
    defaultValues: { name: '', phone: '', panNumber: '', type: 'RETAIL' },
  });

  const mutation = useMutation({
    mutationFn: (data: any) => apiPost('/orders/clients', data),
    onSuccess: (res: any) => {
      const client = res?.data ?? res;
      qc.invalidateQueries({ queryKey: ['clients-list'] });
      enqueueSnackbar(`Client ${client.clientCode} created`, { variant: 'success' });
      onCreated(client);
      reset();
    },
    onError: (e: any) => enqueueSnackbar(e.response?.data?.error ?? 'Failed to create client', { variant: 'error' }),
  });

  return (
    <Dialog open={open} onClose={onClose} maxWidth="xs" fullWidth>
      <form onSubmit={handleSubmit((d) => mutation.mutate(d))}>
        <DialogTitle fontWeight={700}>New Client</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ pt: 1 }}>
            <Controller name="name" control={control} rules={{ required: true }}
              render={({ field, fieldState }) => (
                <TextField {...field} fullWidth label="Name *" autoFocus
                  error={!!fieldState.error} helperText={fieldState.error && 'Required'} />
              )} />
            <Controller name="phone" control={control}
              render={({ field }) => <TextField {...field} fullWidth label="Phone" />} />
            <Controller name="panNumber" control={control}
              rules={{ pattern: { value: /^[A-Za-z]{5}[0-9]{4}[A-Za-z]$/, message: 'PAN looks like ABCDE1234F' } }}
              render={({ field, fieldState }) => (
                <TextField {...field} fullWidth label="PAN (optional)" inputProps={{ maxLength: 10, style: { textTransform: 'uppercase' } }}
                  error={!!fieldState.error} helperText={fieldState.error?.message ?? 'Needed if the sale is above ₹2,00,000'} />
              )} />
            <Controller name="type" control={control}
              render={({ field }) => (
                <TextField {...field} select fullWidth label="Type">
                  <MenuItem value="RETAIL">Retail</MenuItem>
                  <MenuItem value="WHOLESALE">Wholesale</MenuItem>
                </TextField>
              )} />
          </Stack>
        </DialogContent>
        <DialogActions sx={{ p: 2 }}>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="contained" disabled={mutation.isPending}>Create</Button>
        </DialogActions>
      </form>
    </Dialog>
  );
}

// ─── Main page ──────────────────────────────────────────────────────────────────

export function NewSalePage() {
  const navigate = useNavigate();
  const { enqueueSnackbar } = useSnackbar();
  const qc = useQueryClient();
  const [activeTab, setActiveTab] = useState(0);
  const [tagSearch, setTagSearch] = useState('');
  const [lines, setLines] = useState<LineItem[]>([]);
  const [quickAddOpen, setQuickAddOpen] = useState(false);
  const [createdInvoice, setCreatedInvoice] = useState<any>(null);
  const [collectPayment, setCollectPayment] = useState(false);
  const [paymentSplits, setPaymentSplits] = useState<PaymentSplit[]>([]);
  const keySeq = useRef(0);
  const nextKey = () => String(++keySeq.current);
  const paySeq = useRef(0);
  const nextPayKey = () => String(++paySeq.current);

  // Estimate loader: an estimate the estimator sent to billing is found here, converted to a line (after asking
  // who the sales person is), and can then be re-priced through the breakdown editor.
  const [estimateSearch, setEstimateSearch] = useState('');
  const [pendingEstimate, setPendingEstimate] = useState<any>(null);
  const [pendingStaffId, setPendingStaffId] = useState('');
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [kycOpen, setKycOpen] = useState(false);

  const { data: clients } = useQuery({ queryKey: ['clients-list'], queryFn: () => apiGet<any>('/orders/clients') });
  const clientList: any[] = (clients as any)?.clients ?? (clients as any)?.data ?? clients ?? [];

  const { data: staff } = useQuery({ queryKey: ['sales-staff'], queryFn: () => apiGet<any>('/sales/staff') });
  const staffList: any[] = (staff as any)?.data ?? staff ?? [];

  const { data: branches } = useQuery({ queryKey: ['sales-branches'], queryFn: () => apiGet<any[]>('/sales/branches') });
  const branchList: any[] = (branches as any)?.data ?? branches ?? [];

  const { data: estimateResults } = useQuery({
    queryKey: ['billable-estimates', estimateSearch],
    queryFn: () => apiGet<any[]>('/sales/estimates', { q: estimateSearch }),
    enabled: activeTab === 1,
  });
  const estimateOptions: any[] = (estimateResults as any)?.data ?? estimateResults ?? [];

  const { data: categories } = useQuery({ queryKey: ['product-categories'], queryFn: () => apiGet<any>('/masters/categories') });
  const categoryList: any[] = (categories as any)?.data ?? categories ?? [];

  const { data: tagResults } = useQuery({
    queryKey: ['tag-search-sale', tagSearch],
    queryFn: () => apiGet<any>('/tagging/tags/search', { q: tagSearch, status: 'IN_STOCK' }),
    enabled: tagSearch.length >= 1,
  });
  const searchOptions: any[] = (tagResults as any)?.data ?? tagResults ?? [];

  // C2: today's rate per karat, for auto-filling a picked tag's goldRate — same source
  // MetalRates.tsx already shows at Product Design > Metal Rates. Still editable per line;
  // if a karat has no rate yet, goldRate is left at 0 and the server (which resolves the
  // same way at submit time) will reject an unresolvable PER_GRAM line with a clear error.
  const { data: metalRates } = useQuery({
    queryKey: ['metal-rates'],
    queryFn: () => apiGet<any[]>('/designs/rates/latest'),
  });
  const latestRateByKarat: Record<string, number> = {};
  (metalRates ?? []).forEach((r: any) => {
    if (!(r.karat in latestRateByKarat)) latestRateByKarat[r.karat] = Number(r.ratePerGram);
  });

  // C3: making-charge/wastage master, for auto-filling a picked tag's makingCharge/wastagePercent
  // — same master NewTagPage.tsx already reads, matched here by karat + category + tag makeType
  // (the server resolves the same way at submit time if these are left out; this is convenience
  // only). Mirror of sales.service.ts's findMakingCharge — most-specific-match-wins across the
  // three dimensions: a master row only matches when every field IT has pinned (non-null) agrees
  // with the tag, and among matches the row pinning the most dimensions wins.
  const { data: makingChargesData } = useQuery({
    queryKey: ['master-making-charges'], queryFn: () => apiGet<any>('/masters/making-charges'),
  });
  const makingChargesList: any[] = (makingChargesData as any)?.data ?? makingChargesData ?? [];

  const { control, handleSubmit, reset, watch, setValue } = useForm({
    defaultValues: {
      clientId: '',
      branchId: '',
      invoiceType: 'RETAIL',
      invoiceDate: new Date().toISOString().split('T')[0],
      currency: 'INR',
      discountAmount: 0,
      otherCharges: 0,
      salesPersonId: '',
      terms: 'IMMEDIATE',
      notes: '',
    },
  });
  const currency = watch('currency');
  const discountAmount = Number(watch('discountAmount')) || 0;
  const otherCharges = Number(watch('otherCharges')) || 0;
  const selectedClientId = watch('clientId');
  const selectedClient = clientList.find((c: any) => c.id === selectedClientId);
  const branchId = watch('branchId');

  // An invoice is booked against a branch. With exactly one branch there is nothing to choose.
  useEffect(() => {
    if (!branchId && branchList.length === 1) setValue('branchId', branchList[0].id);
  }, [branchId, branchList.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const addTagLine = (tag: any) => {
    const netGoldWeight = Number(tag.netWeight ?? 0);
    // Prefer whatever MC rate/VA% was actually decided for this piece at tagging time (see
    // JewelryTag's schema comment) over a fresh master lookup — only a tag that predates that
    // column (both null) falls back to the master, so a later master-rate change never silently
    // re-prices a piece an executive already settled on.
    const tagMcRate = tag.saleMcRate != null ? Number(tag.saleMcRate) : undefined;
    const tagVaPercent = tag.saleVaPercent != null ? Number(tag.saleVaPercent) : undefined;
    const masterCharge = (tagMcRate === undefined || tagVaPercent === undefined)
      ? findMakingCharge(makingChargesList, tag.metalKarat, tag.category?.id, tag.makeType)
      : undefined;
    const makingCharge = tagMcRate !== undefined
      ? tagMcRate * netGoldWeight
      : masterCharge
        ? (masterCharge.makingChargeType === 'PER_GRAM'
            ? Number(masterCharge.makingCharge) * netGoldWeight
            : Number(masterCharge.makingCharge))
        : 0;
    const wastagePercent = tagVaPercent !== undefined
      ? tagVaPercent
      : masterCharge ? Number(masterCharge.saleWastagePercent) : 0;
    setLines((p) => [...p, {
      key: nextKey(),
      tagId: tag.id,
      tagNumber: tag.tagNumber,
      productCode: tag.tagNumber,
      description: tag.name,
      huid: tag.huid ?? undefined,
      karat: tag.metalKarat ?? undefined,
      quantity: 1,
      grossWeight: Number(tag.grossWeight ?? 0),
      netGoldWeight,
      stoneWeight: Number(tag.stoneWeight ?? 0),
      goldRate: (tag.metalKarat && latestRateByKarat[tag.metalKarat]) || 0,
      makingCharge,
      wastagePercent,
      stoneValue: 0,
      categoryId: tag.category?.id ?? undefined,
      categoryName: tag.category?.name ?? undefined,
    }]);
    setTagSearch('');
  };

  const addEstimateLine = (est: any) => {
    const tag = est.tag;
    const breakdown: EstimateBreakdown = {
      rows: (est.items ?? []).map((i: any) => ({
        key: newRowKey(), code: i.code, materialType: i.materialType, name: i.name || i.code,
        weight: Number(i.weight), unit: i.unit, rate: Number(i.saleRate ?? 0),
      })),
      mcRate: Number(est.saleMcRate ?? 0),
      vaPercent: Number(est.saleVaPercent ?? 0),
    };
    setLines((p) => [...p, {
      key: nextKey(),
      tagId: tag.id, tagNumber: tag.tagNumber, productCode: tag.tagNumber,
      description: tag.name, huid: tag.huid ?? undefined, karat: tag.metalKarat ?? undefined,
      quantity: 1,
      grossWeight: Number(tag.grossWeight ?? 0), netGoldWeight: Number(tag.netWeight ?? 0), stoneWeight: Number(tag.stoneWeight ?? 0),
      goldRate: 0, makingCharge: 0, wastagePercent: 0, stoneValue: 0,
      categoryId: tag.category?.id ?? undefined, categoryName: tag.category?.name ?? undefined,
      estimateId: est.id, estimateNumber: est.estimateNumber, quotedTotal: Number(est.totalSaleAmount),
      estimate: breakdown,
    }]);
    setEstimateSearch('');
  };

  // Loading an estimate is the conversion: ask who the sales person is, then add the line.
  const pickEstimate = (est: any) => {
    if (currency !== 'INR') { enqueueSnackbar('Estimates are priced in INR — set the invoice currency to INR first', { variant: 'warning' }); return; }
    const staffIds = new Set(staffList.map((x: any) => x.id));
    const current = watch('salesPersonId');
    setPendingStaffId(current || (est.createdBy?.id && staffIds.has(est.createdBy.id) ? est.createdBy.id : ''));
    setPendingEstimate(est);
  };
  const confirmEstimate = () => {
    if (!pendingEstimate || !pendingStaffId) return;
    setValue('salesPersonId', pendingStaffId);
    addEstimateLine(pendingEstimate);
    setPendingEstimate(null);
  };

  const addCustomLine = () => {
    setLines((p) => [...p, {
      key: nextKey(),
      productCode: '', description: '', quantity: 1,
      grossWeight: 0, netGoldWeight: 0, stoneWeight: 0,
      goldRate: 0, makingCharge: 0, wastagePercent: 0, stoneValue: 0,
    }]);
  };

  const updateLine = (key: string, field: keyof LineItem, value: any) => {
    setLines((p) => p.map((l) => (l.key === key ? { ...l, [field]: value } : l)));
  };

  const removeLine = (key: string) => setLines((p) => p.filter((l) => l.key !== key));

  const subtotal = lines.reduce((s, l) => s + lineTotal(l), 0);
  const taxableAmount = Math.max(subtotal + otherCharges - discountAmount, 0);
  const taxRate = currency === 'INR' ? 0.03 : 0;
  const taxAmount = taxableAmount * taxRate;
  const total = taxableAmount + taxAmount;

  // Rule 114B — the server refuses a sale above ₹2,00,000 for a client with no PAN / Form 60 / GSTIN; say so up front.
  const panOnFile = !!selectedClient && (!!selectedClient.panNumber || !!selectedClient.form60Received || GSTIN_WITH_PAN.test(selectedClient.gstNumber ?? ''));
  const panBlocked = currency === 'INR' && !!selectedClient && total > PAN_REQUIRED_ABOVE && !panOnFile;

  const addPaymentSplit = (prefillAmount?: number) => {
    setPaymentSplits((p) => [...p, {
      key: nextPayKey(),
      paymentDate: new Date().toISOString().split('T')[0],
      amount: prefillAmount ?? 0,
      mode: 'CASH',
      referenceNo: '',
      notes: '',
    }]);
  };
  const updatePaymentSplit = (key: string, field: keyof PaymentSplit, value: any) => {
    setPaymentSplits((p) => p.map((s) => (s.key === key ? { ...s, [field]: value } : s)));
  };
  const removePaymentSplit = (key: string) => setPaymentSplits((p) => p.filter((s) => s.key !== key));
  const paymentSplitsTotal = paymentSplits.reduce((s, p) => s + (Number(p.amount) || 0), 0);

  // Sec 269ST — cash taken from one person in a day must stay under ₹2,00,000 (the server also adds up cash already
  // taken from this client earlier that day, which this screen cannot see).
  const cashByDay = collectPayment
    ? paymentSplits.filter((x) => x.mode === 'CASH').reduce((m: Record<string, number>, x) => {
        m[x.paymentDate] = (m[x.paymentDate] ?? 0) + (Number(x.amount) || 0);
        return m;
      }, {})
    : {};
  const cashBlocked = Object.values(cashByDay).some((v) => v >= CASH_RECEIPT_LIMIT);

  const categoryTotals = lines.reduce((acc: Record<string, { pieces: number; netWeight: number; amount: number }>, l) => {
    const key = l.categoryName ?? 'Uncategorized';
    const bucket = acc[key] ?? { pieces: 0, netWeight: 0, amount: 0 };
    bucket.pieces += Number(l.quantity) || 1;
    bucket.netWeight += Number(l.netGoldWeight) || 0;
    bucket.amount += lineTotal(l);
    acc[key] = bucket;
    return acc;
  }, {});
  const categoryRows = Object.entries(categoryTotals);

  const mutation = useMutation({
    mutationFn: (data: any) => apiPost('/sales/invoices', {
      ...data,
      invoiceDate: new Date(data.invoiceDate),
      discountAmount: Number(data.discountAmount) || 0,
      otherCharges: Number(data.otherCharges) || 0,
      salesPersonId: data.salesPersonId || undefined,
      terms: data.terms || undefined,
      estimateIds: lines.filter((l) => l.estimateId).map((l) => l.estimateId),
      payments: collectPayment && paymentSplits.length > 0
        ? paymentSplits
            .filter((p) => Number(p.amount) > 0)
            .map((p) => ({
              paymentDate: new Date(p.paymentDate),
              amount: Number(p.amount),
              mode: p.mode,
              referenceNo: p.referenceNo || undefined,
              notes: p.notes || undefined,
            }))
        : undefined,
      items: lines.map((l) => (l.estimate ? estimateInvoiceLine(l) : {
        productCode: l.productCode || l.tagNumber || 'ITEM',
        description: l.description,
        huid: l.huid || undefined,
        karat: l.karat || undefined,
        quantity: Number(l.quantity) || 1,
        grossWeight: Number(l.grossWeight) || 0,
        netGoldWeight: Number(l.netGoldWeight) || 0,
        stoneWeight: Number(l.stoneWeight) || 0,
        rateType: 'PER_GRAM',
        // Omit (rather than send 0) when unset so the server resolves today's MetalRate for
        // `karat` (C2) instead of pricing the line at zero.
        goldRate: Number(l.goldRate) || undefined,
        // Omit (rather than send 0) when unset so the server pulls the MakingCharge master's rate
        // for the line's category (C3) instead of pricing the making charge at zero. wastagePercent
        // stays an always-explicit 0 default — unlike goldRate/makingCharge, a genuine 0% wastage
        // is a common, deliberate value, not a "field left blank" signal.
        makingCharge: Number(l.makingCharge) || undefined,
        wastagePercent: Number(l.wastagePercent) || 0,
        stoneValue: Number(l.stoneValue) || 0,
        tagId: l.tagId,
        categoryId: l.categoryId || undefined,
      })),
    }),
    onSuccess: (res: any) => {
      const inv = res?.data ?? res;
      qc.invalidateQueries({ queryKey: ['sales-invoices'] });
      setCreatedInvoice(inv);
      enqueueSnackbar(`Invoice ${inv?.invoiceNumber ?? ''} created`, { variant: 'success' });
    },
    onError: (e: any) => enqueueSnackbar(e.response?.data?.error ?? 'Failed to create invoice', { variant: 'error' }),
  });

  const handleSaveAndNew = () => {
    setCreatedInvoice(null);
    reset({
      clientId: '', branchId, invoiceType: 'RETAIL', invoiceDate: new Date().toISOString().split('T')[0], currency: 'INR',
      discountAmount: 0, otherCharges: 0, salesPersonId: '', terms: 'IMMEDIATE', notes: '',
    });
    setLines([]);
    setCollectPayment(false);
    setPaymentSplits([]);
    setActiveTab(0);
  };

  const tab1Ready = !!selectedClientId && !!branchId;
  const tab2Ready = tab1Ready && lines.length > 0;

  return (
    <Box>
      <PageHeader title="New Sale"
        breadcrumbs={[{ label: 'Sales', path: '/sales/invoices' }, { label: 'Invoices', path: '/sales/invoices' }, { label: 'New Sale' }]}
        actions={[{ label: 'Back to Invoices', icon: <ArrowBack />, onClick: () => navigate('/sales/invoices'), variant: 'outlined' as const }]} />

      <Grid container spacing={3} alignItems="flex-start">
        <Grid item xs={12} md={activeTab === 1 ? 12 : 8}>
          <Card sx={{ p: 0 }}>
            {createdInvoice ? (
              <Box sx={{ p: 3 }}>
                <Alert severity="success" icon={<CheckCircle />} sx={{ mb: 2 }}>
                  <Typography fontWeight={700}>Invoice {createdInvoice.invoiceNumber} created!</Typography>
                </Alert>
                <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5}>
                  <Button variant="contained" size="large" startIcon={<Print />}
                    onClick={() => printInvoice(createdInvoice)} sx={{ flex: 1 }}>
                    Print Invoice
                  </Button>
                  <Button variant="outlined" size="large" startIcon={<AddCircleOutline />} onClick={handleSaveAndNew} sx={{ flex: 1 }}>
                    New Sale
                  </Button>
                  <Button variant="text" size="large" onClick={() => navigate('/sales/invoices')} sx={{ flex: 1 }}>
                    View All Invoices
                  </Button>
                </Stack>
              </Box>
            ) : (
              <form onSubmit={handleSubmit((d) => mutation.mutate(d))}>
                <Tabs value={activeTab} onChange={(_, v) => setActiveTab(v)} sx={{ borderBottom: 1, borderColor: 'divider', px: 2 }}>
                  <Tab label="1 · Sale Details" />
                  <Tab label="2 · Items" disabled={!tab1Ready} />
                  <Tab label="3 · Charges & Payment" disabled={!tab2Ready} />
                </Tabs>

                {/* ── Tab 1: Sale Details ── */}
                {activeTab === 0 && (
                  <Box sx={{ p: 3 }}>
                    <Grid container spacing={2}>
                      <Grid item xs={12} sm={7}>
                        <Stack direction="row" spacing={1} alignItems="flex-start">
                          <Controller name="clientId" control={control} rules={{ required: true }}
                            render={({ field, fieldState }) => (
                              <TextField {...field} select fullWidth label="Client *" error={!!fieldState.error}>
                                {clientList.map((c: any) => (
                                  <MenuItem key={c.id} value={c.id}>{c.clientCode} — {c.name}</MenuItem>
                                ))}
                              </TextField>
                            )} />
                          <IconButton title="New Client" onClick={() => setQuickAddOpen(true)} sx={{ mt: 1 }}>
                            <PersonAdd />
                          </IconButton>
                        </Stack>
                        {selectedClient && (
                          <Chip
                            size="small" sx={{ mt: 0.5 }}
                            label={selectedClient.gstNumber ? `GST Registered — ${selectedClient.gstNumber}` : 'Unregistered (B2C)'}
                            color={selectedClient.gstNumber ? 'success' : 'default'}
                          />
                        )}
                      </Grid>
                      <Grid item xs={6} sm={2.5}>
                        <Controller name="invoiceType" control={control}
                          render={({ field }) => (
                            <TextField {...field} select fullWidth label="Type">
                              <MenuItem value="RETAIL">Retail</MenuItem>
                              <MenuItem value="WHOLESALE">Wholesale</MenuItem>
                            </TextField>
                          )} />
                      </Grid>
                      <Grid item xs={6} sm={2.5}>
                        <Controller name="currency" control={control}
                          render={({ field }) => (
                            <TextField {...field} select fullWidth label="Currency">
                              <MenuItem value="INR">INR</MenuItem>
                              <MenuItem value="USD">USD</MenuItem>
                            </TextField>
                          )} />
                      </Grid>
                      <Grid item xs={6} sm={4}>
                        <Controller name="branchId" control={control} rules={{ required: true }}
                          render={({ field, fieldState }) => (
                            <SelectField {...field} label="Branch *" emptyLabel="Select branch…" error={!!fieldState.error}
                              options={branchList.map((b: any) => ({ value: b.id, label: b.name }))} />
                          )} />
                      </Grid>
                      <Grid item xs={6} sm={4}>
                        <Controller name="invoiceDate" control={control}
                          render={({ field }) => (
                            <TextField {...field} fullWidth label="Invoice Date" type="date" InputLabelProps={{ shrink: true }} />
                          )} />
                      </Grid>
                      <Grid item xs={6} sm={4}>
                        <Controller name="salesPersonId" control={control}
                          render={({ field }) => (
                            <TextField {...field} select fullWidth label="Sales Executive">
                              <MenuItem value="">— None —</MenuItem>
                              {staffList.map((s: any) => (
                                <MenuItem key={s.id} value={s.id}>{s.name}{s.employeeId ? ` (${s.employeeId})` : ''}</MenuItem>
                              ))}
                            </TextField>
                          )} />
                      </Grid>
                      <Grid item xs={12} sm={4}>
                        <Controller name="terms" control={control}
                          render={({ field }) => (
                            <TextField {...field} select fullWidth label="Terms">
                              <MenuItem value="IMMEDIATE">Immediate</MenuItem>
                              <MenuItem value="COD">Cash on Delivery</MenuItem>
                              <MenuItem value="NET_7">Net 7</MenuItem>
                              <MenuItem value="NET_15">Net 15</MenuItem>
                              <MenuItem value="NET_30">Net 30</MenuItem>
                            </TextField>
                          )} />
                      </Grid>
                      <Grid item xs={12}>
                        <Controller name="notes" control={control}
                          render={({ field }) => <TextField {...field} fullWidth label="Notes" size="small" />} />
                      </Grid>
                    </Grid>

                    <Stack direction="row" justifyContent="flex-end" sx={{ mt: 3 }}>
                      <Button variant="contained" size="large" disabled={!tab1Ready} onClick={() => setActiveTab(1)}>
                        Next: Add Items →
                      </Button>
                    </Stack>
                  </Box>
                )}

                {/* ── Tab 2: Items ── */}
                {activeTab === 1 && (
                  <Box sx={{ p: 3 }}>
                    <Grid container spacing={2}>
                      <Grid item xs={8}>
                        <Autocomplete
                          options={searchOptions.filter((o) => !lines.find((l) => l.tagId === o.id))}
                          getOptionLabel={(o) => `${o.tagNumber} — ${o.name} (${o.metalKarat ?? ''}, ${Number(o.netWeight).toFixed(3)}g)`}
                          filterOptions={(x) => x}
                          inputValue={tagSearch}
                          onInputChange={(_, v) => setTagSearch(v)}
                          onChange={(_, val) => { if (val) addTagLine(val); }}
                          renderInput={(params) => (
                            <TextField {...params} label="Add IN_STOCK piece (search by tag number, name or HUID)" />
                          )}
                          noOptionsText={tagSearch.length < 1 ? 'Type to search IN_STOCK tags' : 'No tags found'}
                        />
                      </Grid>
                      <Grid item xs={4} sx={{ display: 'flex', alignItems: 'center' }}>
                        <Button startIcon={<Add />} onClick={addCustomLine}>Add custom line</Button>
                      </Grid>

                      <Grid item xs={12}>
                        <Autocomplete
                          options={estimateOptions.filter((e) => !lines.find((l) => l.estimateId === e.id))}
                          getOptionLabel={(e) => `${e.estimateNumber} — ${e.tag?.name ?? ''}${e.customerName ? ` — ${e.customerName}` : ''} — ₹${Number(e.totalSaleAmount).toLocaleString('en-IN')}`}
                          filterOptions={(x) => x}
                          inputValue={estimateSearch}
                          onInputChange={(_, v, reason) => { if (reason !== 'reset') setEstimateSearch(v); }}
                          onChange={(_, val) => { if (val) pickEstimate(val); }}
                          value={null}
                          renderOption={(props, e) => (
                            <li {...props} key={e.id}>
                              <Stack sx={{ width: '100%' }}>
                                <Stack direction="row" justifyContent="space-between">
                                  <Typography sx={{ fontFamily: 'monospace', fontWeight: 700 }}>{e.estimateNumber}</Typography>
                                  <Typography sx={{ fontFamily: 'monospace' }}>₹{Number(e.totalSaleAmount).toLocaleString('en-IN')} + GST</Typography>
                                </Stack>
                                <Typography variant="caption" color="text.secondary">
                                  {e.tag?.tagNumber} · {e.tag?.name}{e.customerName ? ` · ${e.customerName}` : ''}{e.customerPhone ? ` (${e.customerPhone})` : ''}
                                  {e.expired ? ' · quote expired' : ''}
                                </Typography>
                              </Stack>
                            </li>
                          )}
                          renderInput={(params) => (
                            <TextField {...params} size="small" label="Bill an estimate (search by estimate number, item name or customer name)" />
                          )}
                          noOptionsText={estimateSearch ? 'No estimate sent to billing matches' : 'No estimates waiting at billing'}
                        />
                      </Grid>

                      {lines.length > 0 && (
                        <Grid item xs={12}>
                          <Box sx={{ overflowX: 'auto' }}>
                            <Table size="small" sx={{ '& .MuiTableCell-root': { px: 1 } }}>
                              <TableHead>
                                <TableRow>
                                  <TableCell>Item</TableCell>
                                  <TableCell sx={{ minWidth: 82 }}>Category</TableCell>
                                  <TableCell align="right" sx={{ minWidth: 66 }}>Net Wt (g)</TableCell>
                                  <TableCell align="right" sx={{ minWidth: 74 }}>Gold Rate (₹/g)</TableCell>
                                  <TableCell align="right" sx={{ minWidth: 66 }}>Making (₹)</TableCell>
                                  <TableCell align="right" sx={{ minWidth: 48 }}>VA %</TableCell>
                                  <TableCell align="right" sx={{ minWidth: 66 }}>Stones (₹)</TableCell>
                                  <TableCell align="right" sx={{ minWidth: 44 }}>Qty</TableCell>
                                  <TableCell align="right">Line Total</TableCell>
                                  <TableCell />
                                </TableRow>
                              </TableHead>
                              <TableBody>
                                {lines.map((l) => (
                                  <TableRow key={l.key}>
                                    <TableCell>
                                      {l.tagId ? (
                                        <>
                                          <Typography sx={{ fontFamily: 'monospace', fontSize: 11, color: '#44C47A', fontWeight: 700 }}>
                                            {l.tagNumber}
                                          </Typography>
                                          <Typography variant="caption" color="text.secondary">{l.description}</Typography>
                                          {l.estimateNumber && (
                                            <Chip size="small" color="info" variant="outlined" label={l.estimateNumber} sx={{ ml: 0.5, height: 18, fontSize: 10, fontFamily: 'monospace' }} />
                                          )}
                                        </>
                                      ) : (
                                        <TextField size="small" placeholder="Description" value={l.description}
                                          onChange={(e) => updateLine(l.key, 'description', e.target.value)} />
                                      )}
                                    </TableCell>
                                    <TableCell>
                                      {l.tagId ? (
                                        <Typography variant="body2">{l.categoryName ?? '—'}</Typography>
                                      ) : (
                                        <TextField size="small" select value={l.categoryId ?? ''} sx={{ minWidth: 76 }}
                                          onChange={(e) => {
                                            const cat = categoryList.find((c: any) => c.id === e.target.value);
                                            updateLine(l.key, 'categoryId', e.target.value);
                                            updateLine(l.key, 'categoryName', cat?.name);
                                          }}>
                                          <MenuItem value="">—</MenuItem>
                                          {categoryList.map((c: any) => (
                                            <MenuItem key={c.id} value={c.id}>{c.name}</MenuItem>
                                          ))}
                                        </TextField>
                                      )}
                                    </TableCell>
                                    <TableCell align="right">
                                      {l.tagId ? Number(l.netGoldWeight).toFixed(3) : (
                                        <TextField size="small" type="number" value={l.netGoldWeight}
                                          inputProps={{ step: 0.001, min: 0, style: { textAlign: 'right', width: 50 } }}
                                          onChange={(e) => updateLine(l.key, 'netGoldWeight', Number(e.target.value))} />
                                      )}
                                    </TableCell>
                                    {l.estimate ? (
                                      <TableCell colSpan={4} align="right">
                                        <Stack direction="row" spacing={1} justifyContent="flex-end" alignItems="center">
                                          <Typography variant="caption" color="text.secondary">
                                            {l.estimate.rows.length} row{l.estimate.rows.length === 1 ? '' : 's'} · MC {l.estimate.mcRate}/g · VA {l.estimate.vaPercent}%
                                            {Math.abs(lineTotal(l) - (l.quotedTotal ?? 0)) > 0.005 ? ` · quoted ₹${Number(l.quotedTotal).toLocaleString('en-IN')}` : ''}
                                          </Typography>
                                          <Button size="small" variant="outlined" onClick={() => setEditingKey(l.key)}>Edit rates / rows</Button>
                                        </Stack>
                                      </TableCell>
                                    ) : (<>
                                    <TableCell align="right">
                                      <TextField size="small" type="number" value={l.goldRate}
                                        inputProps={{ step: 0.01, min: 0, style: { textAlign: 'right', width: 58 } }}
                                        onChange={(e) => updateLine(l.key, 'goldRate', Number(e.target.value))} />
                                    </TableCell>
                                    <TableCell align="right">
                                      <TextField size="small" type="number" value={l.makingCharge}
                                        inputProps={{ step: 0.01, min: 0, style: { textAlign: 'right', width: 52 } }}
                                        onChange={(e) => updateLine(l.key, 'makingCharge', Number(e.target.value))} />
                                    </TableCell>
                                    <TableCell align="right">
                                      <TextField size="small" type="number" value={l.wastagePercent}
                                        inputProps={{ step: 0.1, min: 0, style: { textAlign: 'right', width: 36 } }}
                                        onChange={(e) => updateLine(l.key, 'wastagePercent', Number(e.target.value))} />
                                    </TableCell>
                                    <TableCell align="right">
                                      <TextField size="small" type="number" value={l.stoneValue}
                                        inputProps={{ step: 0.01, min: 0, style: { textAlign: 'right', width: 50 } }}
                                        onChange={(e) => updateLine(l.key, 'stoneValue', Number(e.target.value))} />
                                    </TableCell>
                                    </>)}
                                    <TableCell align="right">
                                      <TextField size="small" type="number" value={l.quantity} disabled={!!l.estimate}
                                        inputProps={{ step: 1, min: 1, style: { textAlign: 'right', width: 30 } }}
                                        onChange={(e) => updateLine(l.key, 'quantity', Number(e.target.value))} />
                                    </TableCell>
                                    <TableCell align="right" sx={{ fontFamily: 'monospace', fontWeight: 700 }}>
                                      {fmt(lineTotal(l))}
                                    </TableCell>
                                    <TableCell>
                                      <IconButton size="small" color="error" onClick={() => removeLine(l.key)}>
                                        <Delete fontSize="small" />
                                      </IconButton>
                                    </TableCell>
                                  </TableRow>
                                ))}
                              </TableBody>
                            </Table>
                          </Box>

                          {categoryRows.length > 0 && (
                            <Box sx={{ mt: 2 }}>
                              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.5 }}>
                                By Category
                              </Typography>
                              <Table size="small" sx={{ width: 'auto' }}>
                                <TableHead>
                                  <TableRow>
                                    <TableCell>Category</TableCell>
                                    <TableCell align="right">Pieces</TableCell>
                                    <TableCell align="right">Net Wt (g)</TableCell>
                                    <TableCell align="right">Amount</TableCell>
                                  </TableRow>
                                </TableHead>
                                <TableBody>
                                  {categoryRows.map(([name, t]) => (
                                    <TableRow key={name}>
                                      <TableCell>{name}</TableCell>
                                      <TableCell align="right">{t.pieces}</TableCell>
                                      <TableCell align="right" sx={{ fontFamily: 'monospace' }}>{t.netWeight.toFixed(3)}</TableCell>
                                      <TableCell align="right" sx={{ fontFamily: 'monospace' }}>{fmt(t.amount)}</TableCell>
                                    </TableRow>
                                  ))}
                                </TableBody>
                              </Table>
                            </Box>
                          )}
                        </Grid>
                      )}
                    </Grid>

                    <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mt: 3 }}>
                      <Button variant="text" onClick={() => setActiveTab(0)}>← Back</Button>
                      {lines.length > 0 && (
                        <Typography sx={{ fontFamily: 'monospace' }}>
                          {lines.length} line{lines.length === 1 ? '' : 's'} · Subtotal <b>{fmt(subtotal)}</b>
                        </Typography>
                      )}
                      <Button variant="contained" size="large" disabled={!tab2Ready} onClick={() => setActiveTab(2)}>
                        Next: Charges & Payment →
                      </Button>
                    </Stack>
                  </Box>
                )}

                {/* ── Tab 3: Charges & Payment ── */}
                {activeTab === 2 && (
                  <Box sx={{ p: 3 }}>
                    <Grid container spacing={2}>
                      <Grid item xs={6} sm={3}>
                        <Controller name="discountAmount" control={control}
                          render={({ field }) => (
                            <TextField {...field} fullWidth label="Discount" type="number" inputProps={{ step: 0.01, min: 0 }} />
                          )} />
                      </Grid>
                      <Grid item xs={6} sm={4}>
                        <Controller name="otherCharges" control={control}
                          render={({ field }) => (
                            <TextField {...field} fullWidth label="Shipping / Other Charges" type="number" inputProps={{ step: 0.01, min: 0 }} />
                          )} />
                      </Grid>
                    </Grid>

                    <Box sx={{ display: 'flex', justifyContent: 'flex-end', mt: 2 }}>
                      <Stack spacing={0.5} sx={{ minWidth: 280 }}>
                        <Stack direction="row" justifyContent="space-between">
                          <Typography variant="body2" color="text.secondary">Subtotal</Typography>
                          <Typography sx={{ fontFamily: 'monospace' }}>{fmt(subtotal)}</Typography>
                        </Stack>
                        <Stack direction="row" justifyContent="space-between">
                          <Typography variant="body2" color="text.secondary">Shipping / Other Charges</Typography>
                          <Typography sx={{ fontFamily: 'monospace' }}>+{fmt(otherCharges)}</Typography>
                        </Stack>
                        <Stack direction="row" justifyContent="space-between">
                          <Typography variant="body2" color="text.secondary">Discount</Typography>
                          <Typography sx={{ fontFamily: 'monospace' }}>-{fmt(discountAmount)}</Typography>
                        </Stack>
                        <Stack direction="row" justifyContent="space-between">
                          <Typography variant="body2" color="text.secondary">GST ({(taxRate * 100).toFixed(0)}%)</Typography>
                          <Typography sx={{ fontFamily: 'monospace' }}>{fmt(taxAmount)}</Typography>
                        </Stack>
                        <Divider />
                        <Stack direction="row" justifyContent="space-between">
                          <Typography fontWeight={700}>Total</Typography>
                          <Typography fontWeight={700} sx={{ fontFamily: 'monospace' }}>{fmt(total)}</Typography>
                        </Stack>
                      </Stack>
                    </Box>

                    {panBlocked && (
                      <Alert severity="warning" sx={{ mt: 2 }}
                        action={<Button color="inherit" size="small" onClick={() => setKycOpen(true)}>Add PAN / Form 60</Button>}>
                        This sale is {fmt(total)}, above ₹2,00,000. {selectedClient?.name} needs a PAN (or a Form 60 on file) before the invoice can be created.
                      </Alert>
                    )}

                    <Box sx={{ mt: 2 }}>
                      <FormControlLabel
                        control={<Checkbox checked={collectPayment} onChange={(e) => {
                          setCollectPayment(e.target.checked);
                          if (e.target.checked && paymentSplits.length === 0) addPaymentSplit(total);
                        }} />}
                        label="Collect payment now"
                      />
                      {collectPayment && (
                        <Box sx={{ mt: 1 }}>
                          <Box sx={{ overflowX: 'auto' }}>
                            <Table size="small">
                              <TableHead>
                                <TableRow>
                                  <TableCell>Transaction Date</TableCell>
                                  <TableCell align="right">Amount</TableCell>
                                  <TableCell>Mode</TableCell>
                                  <TableCell>Reference #</TableCell>
                                  <TableCell>Remarks</TableCell>
                                  <TableCell />
                                </TableRow>
                              </TableHead>
                              <TableBody>
                                {paymentSplits.map((p) => (
                                  <TableRow key={p.key}>
                                    <TableCell>
                                      <TextField size="small" type="date" value={p.paymentDate}
                                        InputLabelProps={{ shrink: true }} sx={{ width: 145 }}
                                        onChange={(e) => updatePaymentSplit(p.key, 'paymentDate', e.target.value)} />
                                    </TableCell>
                                    <TableCell align="right">
                                      <TextField size="small" type="number" value={p.amount}
                                        inputProps={{ step: 0.01, min: 0, style: { textAlign: 'right', width: 100 } }}
                                        onChange={(e) => updatePaymentSplit(p.key, 'amount', Number(e.target.value))} />
                                    </TableCell>
                                    <TableCell>
                                      <TextField size="small" select value={p.mode} sx={{ width: 130 }}
                                        onChange={(e) => updatePaymentSplit(p.key, 'mode', e.target.value)}>
                                        <MenuItem value="CASH">Cash</MenuItem>
                                        <MenuItem value="CARD">Card</MenuItem>
                                        <MenuItem value="UPI">UPI</MenuItem>
                                        <MenuItem value="BANK_TRANSFER">Bank Transfer</MenuItem>
                                        <MenuItem value="CHEQUE">Cheque</MenuItem>
                                      </TextField>
                                    </TableCell>
                                    <TableCell>
                                      <TextField size="small" value={p.referenceNo} sx={{ width: 130 }}
                                        onChange={(e) => updatePaymentSplit(p.key, 'referenceNo', e.target.value)} />
                                    </TableCell>
                                    <TableCell>
                                      <TextField size="small" value={p.notes} sx={{ width: 150 }}
                                        onChange={(e) => updatePaymentSplit(p.key, 'notes', e.target.value)} />
                                    </TableCell>
                                    <TableCell>
                                      <IconButton size="small" color="error" onClick={() => removePaymentSplit(p.key)}>
                                        <Delete fontSize="small" />
                                      </IconButton>
                                    </TableCell>
                                  </TableRow>
                                ))}
                              </TableBody>
                            </Table>
                          </Box>
                          {cashBlocked && (
                            <Alert severity="error" sx={{ mt: 1 }}>
                              Cash of ₹2,00,000 or more from one customer in a day is not allowed (Sec 269ST). Take the rest by UPI, card, cheque or bank transfer.
                            </Alert>
                          )}
                          <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mt: 1 }}>
                            <Button size="small" startIcon={<Add />} onClick={() => addPaymentSplit()}>
                              Add split (e.g. part cash, part UPI)
                            </Button>
                            <Typography variant="body2" sx={{ fontFamily: 'monospace' }}>
                              Collecting <b>{fmt(paymentSplitsTotal)}</b> of {fmt(total)}
                              {paymentSplitsTotal > total && (
                                <Typography component="span" color="error.main" sx={{ ml: 1 }}>(exceeds total)</Typography>
                              )}
                            </Typography>
                          </Stack>
                        </Box>
                      )}
                    </Box>

                    <Stack direction="row" justifyContent="space-between" sx={{ mt: 3 }}>
                      <Button variant="text" onClick={() => setActiveTab(1)}>← Back</Button>
                      <Button type="submit" variant="contained" size="large" disabled={mutation.isPending || panBlocked || cashBlocked}>
                        {mutation.isPending ? 'Creating…' : 'Create Invoice'}
                      </Button>
                    </Stack>
                  </Box>
                )}
              </form>
            )}
          </Card>
        </Grid>

        {/* ── Right: running summary — hidden on the Items tab so its table gets the full
             row width instead of needing to scroll sideways within a narrower column. ── */}
        {activeTab !== 1 && (
          <Grid item xs={12} md={4}>
            <Typography variant="caption" color="text.secondary"
              sx={{ display: 'block', mb: 1, ml: 0.5, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 1 }}>
              Summary
            </Typography>
            <Card sx={{ p: 2.5 }}>
              <Stack spacing={1.5}>
                <Box>
                  <Typography variant="caption" color="text.secondary">Client</Typography>
                  <Typography fontWeight={700}>{selectedClient?.name ?? '— not selected —'}</Typography>
                </Box>
                <Box>
                  <Typography variant="caption" color="text.secondary">Items</Typography>
                  <Typography fontWeight={700}>{lines.length} line{lines.length === 1 ? '' : 's'}</Typography>
                </Box>
                <Divider />
                <Stack direction="row" justifyContent="space-between">
                  <Typography variant="body2" color="text.secondary">Subtotal</Typography>
                  <Typography sx={{ fontFamily: 'monospace' }}>{fmt(subtotal)}</Typography>
                </Stack>
                <Stack direction="row" justifyContent="space-between">
                  <Typography fontWeight={700}>Total</Typography>
                  <Typography fontWeight={700} sx={{ fontFamily: 'monospace' }}>{fmt(total)}</Typography>
                </Stack>
                {collectPayment && (
                  <Stack direction="row" justifyContent="space-between">
                    <Typography variant="body2" color="text.secondary">Collecting now</Typography>
                    <Typography sx={{ fontFamily: 'monospace', color: 'success.main' }}>
                      {fmt(paymentSplitsTotal)}
                    </Typography>
                  </Stack>
                )}
              </Stack>
            </Card>
          </Grid>
        )}
      </Grid>

      {/* Converting an estimate asks who made the sale. */}
      <Dialog open={!!pendingEstimate} onClose={() => setPendingEstimate(null)} maxWidth="xs" fullWidth>
        <DialogTitle fontWeight={700}>
          Bill estimate {pendingEstimate?.estimateNumber}
          <Typography variant="caption" display="block" color="text.secondary">
            {pendingEstimate?.tag?.name} · ₹{Number(pendingEstimate?.totalSaleAmount ?? 0).toLocaleString('en-IN')} + GST
            {pendingEstimate?.expired ? ' · this quote has expired' : ''}
          </Typography>
        </DialogTitle>
        <DialogContent sx={{ pt: 2 }}>
          <SelectField label="Sales person *" autoFocus value={pendingStaffId} emptyLabel="Select…"
            onChange={(e) => setPendingStaffId(e.target.value)}
            options={staffList.map((x: any) => ({ value: x.id, label: `${x.name}${x.employeeId ? ` (${x.employeeId})` : ''}` }))} />
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
            You can change the rates or rows of this estimate on the bill, and add or remove other items.
          </Typography>
        </DialogContent>
        <DialogActions sx={{ p: 2 }}>
          <Button onClick={() => setPendingEstimate(null)}>Cancel</Button>
          <Button variant="contained" disabled={!pendingStaffId} onClick={confirmEstimate}>Add to bill</Button>
        </DialogActions>
      </Dialog>

      {editingKey && (() => {
        const l = lines.find((x) => x.key === editingKey);
        if (!l?.estimate) return null;
        return (
          <EstimateBreakdownDialog
            title={`${l.estimateNumber} — ${l.description}`}
            quotedTotal={l.quotedTotal ?? 0}
            value={l.estimate}
            onClose={() => setEditingKey(null)}
            onSave={(b) => { setLines((p) => p.map((x) => (x.key === l.key ? { ...x, estimate: b } : x))); setEditingKey(null); }}
          />
        );
      })()}

      <ClientKycDialog client={kycOpen ? selectedClient ?? null : null} onClose={() => setKycOpen(false)} />

      <QuickAddClientDialog
        open={quickAddOpen}
        onClose={() => setQuickAddOpen(false)}
        onCreated={(client) => { setValue('clientId', client.id); setQuickAddOpen(false); }}
      />
    </Box>
  );
}
