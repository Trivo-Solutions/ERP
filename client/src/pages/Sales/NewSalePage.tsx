import { Fragment, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  Box, Card, Table, TableHead, TableBody, TableRow, TableCell, Typography, Chip, Button,
  Grid, MenuItem, TextField, Stack, Divider, IconButton, Autocomplete, Tabs, Tab,
  Checkbox, FormControlLabel, Dialog, DialogTitle, DialogContent, DialogActions, Alert, Switch,
  ToggleButton, ToggleButtonGroup, Tooltip, Badge,
} from '@mui/material';
import { Add, Delete, Print, AddCircleOutline, CheckCircle, ArrowBack, PersonAdd, Tune } from '@mui/icons-material';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm, Controller } from 'react-hook-form';
import { useSnackbar } from 'notistack';
import { apiGet, apiPost, apiPatch, apiPut } from '../../api/client';
import { PageHeader } from '../../components/common/PageHeader';
import { ClientKycDialog } from '../../components/common/ClientKycDialog';
import { SelectField } from '../../components/fields/SelectField';
import { printInvoice } from '../../utils/printInvoice';
import { findMakingCharge } from '../../utils/estimateCalc';
import { EstimateBreakdown, estimateTotals, newRowKey } from './EstimateBreakdown';
import { CustomerMismatchDialog } from './CustomerMismatchDialog';
import { isEstimateCustomerMismatch } from '../../utils/estimateCustomer';
import { MaterialPricingDialog, MaterialPricingEntry } from './MaterialPricingDialog';
import { SaleSummary, SaleFigures } from './SaleSummary';
import { useAuthStore } from '../../store/auth.store';
import { usePageShortcuts, focusFirstField } from '../../hooks/usePageShortcuts';

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
  salesPersonId?: string; // the employee credited with this line (blank = the bill's own sales employee)
  hsnCode?: string;   // billed under this HSN (its GST rate comes from the HSN master); blank = the default
  // A line loaded from an estimate keeps its material rows + MC/VA so they can be edited; its price is derived
  // from them, and it goes to the server as a flat (FIXED) amount. `quotedTotal` is what the estimate said.
  estimateId?: string;
  estimateNumber?: string;
  quotedTotal?: number;
  estimate?: EstimateBreakdown;
  // Edit mode only: the stored InvoiceItem this row came from (sent back so it is updated in place), and how it was priced —
  // a FIXED line's goldRate is its flat price, not a per-gram rate.
  invoiceItemId?: string;
  rateType?: string;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

function lineTotal(l: LineItem) {
  if (l.estimate) return round2(estimateTotals(l.estimate).total);
  if (l.rateType === 'FIXED') return Number(l.goldRate) * Number(l.quantity || 1);
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
    ...(l.invoiceItemId && { id: l.invoiceItemId }),
    rateType: 'FIXED',
    goldRate: round2(t.total),          // FIXED: this IS the decided price (the server recomputes it from the breakdown)
    makingCharge: round2(t.making),     // informational on a FIXED line
    wastagePercent: 0,
    stoneValue: round2(t.otherMaterials),
    // The bill's own copy of the material rows + MC/VA — stored on the invoice line, never written back to the tag.
    materialBreakdown: {
      rows: l.estimate!.rows.map(({ code, materialType, name, weight, unit, rate }) => ({
        code, materialType, name, weight: Number(weight) || 0, unit, rate: Number(rate) || 0,
      })),
      mcRate: Number(l.estimate!.mcRate) || 0,
      vaPercent: Number(l.estimate!.vaPercent) || 0,
    },
    tagId: l.tagId,
    categoryId: l.categoryId || undefined,
    hsnCode: l.hsnCode || undefined,
    salesPersonId: l.salesPersonId || undefined,
  };
}

// A single payment split — one sale can be paid across several modes (e.g. part cash, part UPI).
// Each split gets its own server-generated transaction number (PMT-YYYY-NNNNNN) at creation time.
interface PaymentSplit {
  key: string;
  paymentDate: string;
  amount: number;
  // CASH / CARD / UPI / BANK_TRANSFER / CHEQUE take money. OLD_GOLD (the customer's old metal, valued and melted in on
  // this bill) and STORE_CREDIT (credit already on their account from a return or an earlier exchange) settle the bill
  // from credit instead — see sales.service.ts createInvoice.
  mode: string;
  referenceNo: string;
  notes: string;
  // OLD_GOLD only. The amount is not typed: the server values net weight x today's rate for the karat, less deduction %.
  og: { description: string; karat: string; gross: string; stone: string; deduction: string };
}

const PAYMENT_MODES: Array<{ value: string; label: string }> = [
  { value: 'CASH', label: 'Cash' }, { value: 'CARD', label: 'Card' }, { value: 'UPI', label: 'UPI' },
  { value: 'BANK_TRANSFER', label: 'Bank Transfer' }, { value: 'CHEQUE', label: 'Cheque' },
];

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
  // Quick-adding a client from inside the sale screen is a genuinely separate capability
  // (client:create) from billing itself (invoice:create/invoice:edit, already enforced by this
  // page's route guard — see pageRoutes.tsx).
  const canCreateClient = useAuthStore((s) => s.hasPermission('client:create'));
  const [activeTab, setActiveTab] = useState(0);
  const [tagSearch, setTagSearch] = useState('');
  const [lines, setLines] = useState<LineItem[]>([]);
  const [quickAddOpen, setQuickAddOpen] = useState(false);
  const [createdInvoice, setCreatedInvoice] = useState<any>(null);
  const [collectPayment, setCollectPayment] = useState(false);
  const [paymentSplits, setPaymentSplits] = useState<PaymentSplit[]>([]);
  const keySeq = useRef(0);
  const formRef = useRef<HTMLFormElement>(null);
  const nextKey = () => String(++keySeq.current);
  const paySeq = useRef(0);
  const nextPayKey = () => String(++paySeq.current);

  // Estimate loader: an estimate the estimator sent to billing is found here, converted to a line (after asking
  // who the sales person is), and can then be re-priced through the breakdown editor.
  const [estimateSearch, setEstimateSearch] = useState('');
  const [pendingEstimate, setPendingEstimate] = useState<any>(null);
  const [mismatchOpen, setMismatchOpen] = useState(false);
  const [pendingStaffId, setPendingStaffId] = useState('');
  const [matSession, setMatSession] = useState<{ entries: MaterialPricingEntry[]; startKey: string } | null>(null);
  const [matLoading, setMatLoading] = useState(false);
  const [kycOpen, setKycOpen] = useState(false);
  // Bill adjustments the biller can edit: discount as a flat amount or a % of the gross, and the round-off — automatic
  // to the nearest rupee, or keyed by hand.
  const [discountMode, setDiscountMode] = useState<'AMOUNT' | 'PERCENT'>('AMOUNT');
  const [discountPercent, setDiscountPercent] = useState<number | ''>('');
  const [roundMode, setRoundMode] = useState<'AUTO' | 'MANUAL'>('AUTO');
  const [roundManual, setRoundManual] = useState<number | ''>('');
  const [gstOpen, setGstOpen] = useState(false);
  const [adjustOpen, setAdjustOpen] = useState(false);

  const { data: clients } = useQuery({ queryKey: ['clients-list'], queryFn: () => apiGet<any>('/orders/clients') });
  const clientList: any[] = (clients as any)?.clients ?? (clients as any)?.data ?? clients ?? [];

  const { data: staff } = useQuery({ queryKey: ['sales-staff'], queryFn: () => apiGet<any>('/sales/staff') });
  const staffList: any[] = (staff as any)?.data ?? staff ?? [];

  const { data: branches } = useQuery({ queryKey: ['sales-branches'], queryFn: () => apiGet<any[]>('/sales/branches') });
  const branchList: any[] = (branches as any)?.data ?? branches ?? [];

  const { data: estimateResults } = useQuery({
    queryKey: ['billable-estimates', estimateSearch],
    queryFn: () => apiGet<any[]>('/sales/estimates', { q: estimateSearch }),
    enabled: activeTab === 0,
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

  // Karats for the Old Gold payment's purity picker (same master the standalone Old Gold Exchange screen uses).
  const { data: karatsData } = useQuery({ queryKey: ['karats'], queryFn: () => apiGet<any>('/masters/karats') });
  const karatList: any[] = (karatsData as any)?.data ?? karatsData ?? [];

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

  const { control, handleSubmit, reset, watch, setValue, getValues } = useForm({
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

  // HSN codes/rates and whether this customer is same-state (CGST + SGST) or inter-state (IGST) — what the server will
  // apply, so the bill can be previewed before it exists. Falls back to 3% / inter-state until it arrives.
  const { data: taxCtxRes } = useQuery({
    queryKey: ['sales-tax-context', selectedClientId],
    queryFn: () => apiGet<any>('/sales/tax-context', selectedClientId ? { clientId: selectedClientId } : undefined),
  });
  const taxCtx: any = (taxCtxRes as any)?.data ?? taxCtxRes ?? {};
  const hsnList: Array<{ code: string; description?: string; gstRate: number }> = taxCtx.hsnCodes ?? [];
  const defaultHsn: string = taxCtx.defaultHsnCode ?? '7113';

  // Credit this customer already holds (a sales return / earlier old-gold exchange) that can pay this bill as "Store
  // Credit". Read fresh from the server — the cached client list's balance can be stale.
  const { data: creditRes } = useQuery({
    queryKey: ['client-credit', selectedClientId],
    queryFn: () => apiGet<any>(`/sales/clients/${selectedClientId}/credit`),
    enabled: !!selectedClientId,
    staleTime: 0,
  });
  const creditAvailable: number = Number(((creditRes as any)?.data ?? creditRes)?.available) || 0;
  const sameState = !!taxCtx.sameState;

  // An invoice is booked against a branch. With exactly one branch there is nothing to choose.
  useEffect(() => {
    if (!branchId && branchList.length === 1) setValue('branchId', branchList[0].id);
  }, [branchId, branchList.length]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Edit mode (/sales/invoices/:id/edit) ─────────────────────────────────────────────────────────────────────
  // The same screen, loaded with an issued invoice and saved with PUT (sales.service.ts amendInvoice). Payments are
  // not touched here (they stay as recorded); returned lines are locked, as the server enforces.
  const { id: editId } = useParams();
  const isEdit = !!editId;
  const { data: editInvoice } = useQuery({
    queryKey: ['invoice-detail', editId], queryFn: () => apiGet<any>(`/sales/invoices/${editId}`), enabled: isEdit,
  });
  const { data: editReturnsData } = useQuery({
    queryKey: ['invoice-returns', editId], queryFn: () => apiGet<any[]>('/sales/returns', { invoiceId: editId }), enabled: isEdit,
  });
  const returnedItemIds = new Set<string>(((editReturnsData as any[]) ?? []).flatMap((r: any) => r.items.map((i: any) => i.invoiceItemId)));
  const isLocked = (l: LineItem) => !!l.invoiceItemId && returnedItemIds.has(l.invoiceItemId);
  const editPaid = isEdit ? Number(editInvoice?.paidAmount) || 0 : 0;
  const editLocksClient = isEdit && ((editInvoice?.payments?.length ?? 0) > 0 || (editReturnsData?.length ?? 0) > 0);
  const [editReason, setEditReason] = useState('');
  const editLoaded = useRef(false);
  useEffect(() => {
    if (!isEdit || !editInvoice || editLoaded.current) return;
    editLoaded.current = true;
    const inv = editInvoice;
    reset({
      clientId: inv.clientId, branchId: inv.branchId, invoiceType: inv.invoiceType,
      invoiceDate: String(inv.invoiceDate).slice(0, 10), currency: inv.currency,
      discountAmount: Number(inv.discountAmount), otherCharges: Number(inv.otherCharges),
      salesPersonId: inv.salesPersonId ?? '', terms: inv.terms ?? 'IMMEDIATE', notes: inv.notes ?? '',
    });
    setLines((inv.items ?? []).map((it: any): LineItem => ({
      key: nextKey(), invoiceItemId: it.id, rateType: it.rateType,
      tagId: it.tagId ?? undefined, tagNumber: it.tagId ? it.productCode : undefined,
      productCode: it.productCode, description: it.description, huid: it.huid ?? undefined, karat: it.karat ?? undefined,
      quantity: Number(it.quantity), grossWeight: Number(it.grossWeight), netGoldWeight: Number(it.netGoldWeight),
      stoneWeight: Number(it.stoneWeight), goldRate: Number(it.goldRate), makingCharge: Number(it.makingCharge),
      wastagePercent: Number(it.wastagePercent), stoneValue: Number(it.stoneValue),
      categoryId: it.categoryId ?? undefined, categoryName: it.category?.name ?? undefined, hsnCode: it.hsnCode?.code ?? undefined,
      salesPersonId: it.salesPersonId ?? undefined,
      // A line billed from edited material rows reopens with them.
      ...(it.materialBreakdown && {
        estimate: {
          rows: (it.materialBreakdown.rows ?? []).map((r: any) => ({ ...r, key: newRowKey() })),
          mcRate: Number(it.materialBreakdown.mcRate) || 0, vaPercent: Number(it.materialBreakdown.vaPercent) || 0,
        } as EstimateBreakdown,
        quotedTotal: Number(it.totalPrice),
      }),
    })));
    // Keep the round-off as it was: automatic if that is what the bill had (nearest rupee), else the figure that was keyed.
    const stored = Number(inv.roundOff);
    const pre = Number(inv.totalAmount) - stored;
    const auto = inv.currency === 'INR' ? Math.round(pre) - pre : 0;
    if (Math.abs(auto - stored) < 0.006) setRoundMode('AUTO');
    else { setRoundMode('MANUAL'); setRoundManual(stored); }
  }, [isEdit, editInvoice]); // eslint-disable-line react-hooks/exhaustive-deps

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

  const addEstimateLine = (est: any, salesPersonId?: string) => {
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
      estimate: breakdown, salesPersonId,
    }]);
    setEstimateSearch('');
  };

  // Material Pricing (shortcut F4 / the row buttons): one session over every eligible tagged line — tagged, not locked by
  // a return. Each piece opens with its saved breakdown (from an estimate or an earlier edit) or one built from the tag's
  // own material rows. The session only edits drafts; "Apply to bill" copies the changed ones onto their lines, and the
  // server re-prices each from what is stored. The tag, its rows and its cost are never written.
  const isMaterialLine = (l: LineItem) => !!l.tagId && !isLocked(l);

  const buildTagBreakdown = async (l: LineItem): Promise<EstimateBreakdown> => {
    const tag = await apiGet<any>(`/tagging/tags/${l.tagId}`);
    const todaysRate = (l.karat && latestRateByKarat[l.karat]) || Number(l.goldRate) || 0;
    let rows: EstimateBreakdown['rows'] = (tag.materials ?? []).map((m: any) => ({
      key: newRowKey(), code: m.code, materialType: m.materialType, name: m.code,
      weight: Number(m.weight), unit: m.unit,
      rate: m.saleRate != null ? Number(m.saleRate) : m.materialType === 'METAL' ? todaysRate : 0,
    }));
    if (rows.length === 0) {
      rows = [{ key: newRowKey(), code: l.karat ?? 'METAL', materialType: 'METAL', name: l.karat ?? 'Metal', weight: Number(l.netGoldWeight) || 0, unit: 'GM', rate: todaysRate }];
    }
    const net = Number(l.netGoldWeight) || 0;
    return {
      rows,
      mcRate: tag.saleMcRate != null ? Number(tag.saleMcRate) : net > 0 ? round2(Number(l.makingCharge) / net) : 0,
      vaPercent: tag.saleVaPercent != null ? Number(tag.saleVaPercent) : Number(l.wastagePercent) || 0,
    };
  };

  const openMaterials = async (startKey: string) => {
    if (matLoading || matSession) return;
    const eligible = lines.filter(isMaterialLine);
    if (!eligible.some((x) => x.key === startKey)) return;
    if (currency !== 'INR') { enqueueSnackbar('Material pricing is in INR — set the invoice currency to INR first', { variant: 'warning' }); return; }
    setMatLoading(true);
    try {
      const entries: MaterialPricingEntry[] = await Promise.all(eligible.map(async (l) => ({
        key: l.key, tagNumber: l.tagNumber ?? l.productCode, description: l.description,
        initial: l.estimate ?? await buildTagBreakdown(l),
        currentLineTotal: round2(lineTotal(l)),
      })));
      setMatSession({ entries, startKey });
    } catch {
      enqueueSnackbar('Could not load the materials of the tagged pieces', { variant: 'error' });
    } finally {
      setMatLoading(false);
    }
  };

  const applyMaterials = (changed: Array<{ key: string; breakdown: EstimateBreakdown; quotedTotal: number }>) => {
    const byKey = new Map(changed.map((c) => [c.key, c]));
    setLines((p) => p.map((x) => {
      const c = byKey.get(x.key);
      // An estimate line keeps what the estimate quoted; any other line is compared with what the grid showed before.
      return c ? { ...x, estimate: c.breakdown, quotedTotal: x.estimateId ? x.quotedTotal : c.quotedTotal } : x;
    }));
    setMatSession(null);
  };

  // Loading an estimate is the conversion: ask who the sales person is, then add the line.
  const pickEstimate = (est: any) => {
    if (currency !== 'INR') { enqueueSnackbar('Estimates are priced in INR — set the invoice currency to INR first', { variant: 'warning' }); return; }
    const staffIds = new Set(staffList.map((x: any) => x.id));
    const current = watch('salesPersonId');
    // The sales employee the estimator recorded at the hand-off wins; then whatever is already on the bill.
    const recorded = est.salesPerson?.id && staffIds.has(est.salesPerson.id) ? est.salesPerson.id : '';
    setPendingStaffId(recorded || current || (est.createdBy?.id && staffIds.has(est.createdBy.id) ? est.createdBy.id : ''));
    setPendingEstimate(est);
  };

  // The customer the estimator took at the hand-off becomes the bill's customer: found by mobile number among
  // the existing clients (never overwriting what is already on file — only blanks are filled), else created.
  // An already-chosen customer on this bill is left alone.
  const adoptEstimateCustomer = async (est: any) => {
    if (watch('clientId') || !est.customerName) return;
    const last10 = (v?: string) => (v ?? '').replace(/\D/g, '').slice(-10);
    const phone = last10(est.customerPhone);
    const dob = est.customerDob ? String(est.customerDob).slice(0, 10) : undefined;
    const existing = phone ? clientList.find((c: any) => last10(c.phone) === phone) : undefined;
    try {
      if (existing) {
        const fill: Record<string, any> = {};
        if (!existing.panNumber && est.customerPan) fill.panNumber = est.customerPan;
        if (!existing.address && est.customerAddress) fill.address = est.customerAddress;
        if (!existing.dateOfBirth && dob) fill.dateOfBirth = dob;
        if (Object.keys(fill).length > 0) await apiPatch(`/orders/clients/${existing.id}`, fill);
        qc.invalidateQueries({ queryKey: ['clients-list'] });
        setValue('clientId', existing.id);
        return;
      }
      const res: any = await apiPost('/orders/clients', {
        name: est.customerName, type: 'RETAIL', phone: est.customerPhone || undefined,
        panNumber: est.customerPan || undefined, address: est.customerAddress || undefined, dateOfBirth: dob,
      });
      const created = res?.data ?? res;
      await qc.invalidateQueries({ queryKey: ['clients-list'] });
      setValue('clientId', created.id);
      enqueueSnackbar(`Customer ${created.name} (${created.clientCode}) added from the estimate`, { variant: 'info' });
    } catch (e: any) {
      enqueueSnackbar(`Could not add the customer from the estimate — pick or add them manually. ${e.response?.data?.error ?? ''}`.trim(), { variant: 'warning' });
    }
  };

  // Warn first if the bill already has a customer and the estimate is for someone else (by mobile number).
  const requestConfirmEstimate = () => {
    if (!pendingEstimate || !pendingStaffId) return;
    const billClientId = watch('clientId');
    const billClient = billClientId ? clientList.find((c: any) => c.id === billClientId) : undefined;
    if (isEstimateCustomerMismatch(billClient?.phone, pendingEstimate.customerPhone, !!billClientId)) {
      setMismatchOpen(true);
      return;
    }
    void confirmEstimate();
  };

  const confirmEstimate = async () => {
    if (!pendingEstimate || !pendingStaffId) return;
    setMismatchOpen(false);
    const est = pendingEstimate;
    // The employee picked for THIS estimate is credited on its line. The bill's own sales employee is only set when it
    // has none yet — adding a second estimate (another employee's sale) must not overwrite it.
    if (!getValues('salesPersonId')) setValue('salesPersonId', pendingStaffId);
    addEstimateLine(est, pendingStaffId);
    setPendingEstimate(null);
    await adoptEstimateCustomer(est);
    if (activeTab === 0 && getValues('clientId') && getValues('branchId')) setActiveTab(1); // straight on to the items
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
    setLines((p) => p.map((l) => (l.key === key && !isLocked(l) ? { ...l, [field]: value } : l)));
  };

  const removeLine = (key: string) => setLines((p) => p.filter((l) => l.key !== key || isLocked(l)));

  // All of this mirrors createInvoice (sales.service.ts), which recomputes it authoritatively at save time.
  const subtotal = lines.reduce((s, l) => s + lineTotal(l), 0);
  // Discount: a flat amount, or a % of the gross — never more than the gross.
  const discount = Math.min(
    discountMode === 'PERCENT' ? round2(subtotal * (Number(discountPercent) || 0) / 100) : discountAmount,
    subtotal,
  );
  const taxableAmount = Math.max(subtotal + otherCharges - discount, 0);
  // GST: each line at its own HSN rate, scaled by the discount; shipping/other at the default HSN rate.
  const rateOfHsn = (code?: string) => {
    const h = hsnList.find((x) => x.code === (code || defaultHsn));
    return h ? Number(h.gstRate) : 0.03;
  };
  const discountScale = subtotal > 0 ? (subtotal - discount) / subtotal : 0;
  const gstByRate = new Map<number, number>();
  if (currency === 'INR') {
    lines.forEach((l) => { const r = rateOfHsn(l.hsnCode); gstByRate.set(r, (gstByRate.get(r) ?? 0) + lineTotal(l) * discountScale * r); });
    if (otherCharges > 0) { const r = rateOfHsn(); gstByRate.set(r, (gstByRate.get(r) ?? 0) + otherCharges * r); }
  }
  const gstRows = Array.from(gstByRate.entries()).filter(([, a]) => a > 0.0005).sort(([a], [b]) => a - b).map(([rate, amount]) => ({ rate, amount }));
  const taxAmount = gstRows.reduce((s, g) => s + g.amount, 0);
  const preRoundTotal = taxableAmount + taxAmount;
  // Round off: automatic to the nearest rupee on an INR bill, or a figure keyed by hand (the server allows ±₹10).
  const MAX_ROUND_OFF = 10;
  const roundOff = roundMode === 'MANUAL' ? (Number(roundManual) || 0) : currency === 'INR' ? Math.round(preRoundTotal) - preRoundTotal : 0;
  const roundBad = roundMode === 'MANUAL' && Math.abs(Number(roundManual) || 0) > MAX_ROUND_OFF;
  const total = preRoundTotal + roundOff;

  // What the bill is made of, for the Summary card.
  const figures: SaleFigures = (() => {
    let gold = 0, stone = 0, mc = 0, va = 0, grossWeight = 0;
    for (const l of lines) {
      const q = Number(l.quantity) || 1;
      if (l.estimate) {
        const t = estimateTotals(l.estimate);
        gold += t.metalAmount; stone += t.otherMaterials; mc += t.mcAmount; va += t.vaAmount;
        grossWeight += Number(l.grossWeight) || 0;
      } else if (l.rateType === 'FIXED') {
        gold += Number(l.goldRate) * q; // a flat price: the whole amount is the line (no separate making / stone split)
        grossWeight += (Number(l.grossWeight) || 0) * q;
      } else {
        gold += Number(l.netGoldWeight) * Number(l.goldRate) * q;
        stone += Number(l.stoneValue) * q;
        // On a plain line VA marks up the making charge (as createInvoice prices it): MC is the charge itself.
        mc += Number(l.makingCharge) * q;
        va += Number(l.makingCharge) * (Number(l.wastagePercent || 0) / 100) * q;
        grossWeight += (Number(l.grossWeight) || 0) * q;
      }
    }
    return { grossWeight, gold, stone, mc, va, subtotal, otherCharges, discount, taxable: taxableAmount, gst: gstRows, sameState, currency, roundOff, total };
  })();

  // Rule 114B — the server refuses a sale above ₹2,00,000 for a client with no PAN / Form 60 / GSTIN; say so up front.
  const panOnFile = !!selectedClient && (!!selectedClient.panNumber || !!selectedClient.form60Received || GSTIN_WITH_PAN.test(selectedClient.gstNumber ?? ''));
  const panBlocked = currency === 'INR' && !!selectedClient && total > PAN_REQUIRED_ABOVE && !panOnFile;

  const addPaymentSplit = (prefillAmount?: number, mode = 'CASH') => {
    setPaymentSplits((p) => [...p, {
      key: nextPayKey(),
      paymentDate: new Date().toISOString().split('T')[0],
      amount: prefillAmount ?? 0,
      mode,
      referenceNo: '',
      notes: '',
      og: { description: 'Old gold', karat: '', gross: '', stone: '', deduction: '' },
    }]);
  };
  const updatePaymentSplit = (key: string, field: keyof PaymentSplit, value: any) => {
    setPaymentSplits((p) => p.map((s) => (s.key === key ? { ...s, [field]: value } : s)));
  };
  const updateOldGold = (key: string, field: keyof PaymentSplit['og'], value: string) => {
    setPaymentSplits((p) => p.map((s) => (s.key === key ? { ...s, og: { ...s.og, [field]: value } } : s)));
  };
  const removePaymentSplit = (key: string) => setPaymentSplits((p) => p.filter((s) => s.key !== key));

  // Old gold: net weight x today's rate for the karat, less the deduction % — the same figure the server books
  // (it re-values on its own; this is the live preview). 0 until karat, weight and a rate are all there.
  const oldGoldValue = (s: PaymentSplit) => {
    const gross = Number(s.og.gross) || 0;
    const rate = latestRateByKarat[s.og.karat];
    if (!(gross > 0) || !rate) return 0;
    const net = Math.max(gross - (Number(s.og.stone) || 0), 0);
    return Math.round(net * rate * (1 - (Number(s.og.deduction) || 0) / 100) * 100) / 100;
  };
  const splitAmount = (s: PaymentSplit) => (s.mode === 'OLD_GOLD' ? oldGoldValue(s) : Number(s.amount) || 0);
  const paymentSplitsTotal = paymentSplits.reduce((s, p) => s + splitAmount(p), 0);

  // Picking a mode. Store Credit pre-fills what the customer can spend, capped at what is still due on the bill.
  const changePaymentMode = (split: PaymentSplit, mode: string) => {
    const others = paymentSplits.filter((x) => x.key !== split.key).reduce((s, x) => s + splitAmount(x), 0);
    setPaymentSplits((p) => p.map((s) => (s.key === split.key ? {
      ...s, mode,
      amount: mode === 'STORE_CREDIT' ? Math.round(Math.min(creditAvailable, Math.max(total - others, 0)) * 100) / 100 : s.amount,
    } : s)));
  };
  // "Use credit" shortcut: one Store Credit split for as much as the customer has (not already used) and the bill
  // needs, taken off the last money split so the bill is not collected twice.
  const useStoreCredit = () => {
    setCollectPayment(true);
    const creditSplit = (x: PaymentSplit) => x.mode === 'STORE_CREDIT' || x.mode === 'OLD_GOLD';
    const settledByCredit = paymentSplits.filter(creditSplit).reduce((s, x) => s + splitAmount(x), 0);
    const alreadyStoreCredit = paymentSplits.filter((x) => x.mode === 'STORE_CREDIT').reduce((s, x) => s + (Number(x.amount) || 0), 0);
    const use = Math.round(Math.max(Math.min(creditAvailable - alreadyStoreCredit, total - settledByCredit), 0) * 100) / 100;
    if (use <= 0) return;
    setPaymentSplits((prev) => {
      let overshoot = Math.max(prev.reduce((s, x) => s + splitAmount(x), 0) + use - total, 0);
      const trimmed = [...prev];
      for (let i = trimmed.length - 1; i >= 0 && overshoot > 0.005; i--) {
        if (creditSplit(trimmed[i])) continue;
        const cut = Math.min(Number(trimmed[i].amount) || 0, overshoot);
        trimmed[i] = { ...trimmed[i], amount: Math.round(((Number(trimmed[i].amount) || 0) - cut) * 100) / 100 };
        overshoot -= cut;
      }
      return [...trimmed, {
        key: nextPayKey(), paymentDate: new Date().toISOString().split('T')[0], amount: use, mode: 'STORE_CREDIT',
        referenceNo: '', notes: '', og: { description: 'Old gold', karat: '', gross: '', stone: '', deduction: '' },
      }];
    });
  };

  // Store credit cannot be spent beyond what the account holds; old gold needs its metal details and a rate for the karat.
  const storeCreditUsed = collectPayment ? paymentSplits.filter((x) => x.mode === 'STORE_CREDIT').reduce((s, x) => s + (Number(x.amount) || 0), 0) : 0;
  const creditBlocked = storeCreditUsed > creditAvailable + 0.005;
  const oldGoldSplits = collectPayment ? paymentSplits.filter((x) => x.mode === 'OLD_GOLD') : [];
  const oldGoldIncomplete = oldGoldSplits.some((x) => !x.og.description.trim() || !x.og.karat || !((Number(x.og.gross) || 0) > 0)
    || (Number(x.og.stone) || 0) > (Number(x.og.gross) || 0) || oldGoldValue(x) <= 0);
  // More metal than the bill needs is allowed — the surplus stays as credit on the customer's account.
  const oldGoldTotal = oldGoldSplits.reduce((s, x) => s + oldGoldValue(x), 0);
  // What is still owed after what is being collected now (the whole bill when nothing is collected: it goes on the customer's account).
  // (Editing an issued invoice: what it has already received stays as recorded, so the balance is what is left of the new total.)
  const collected = isEdit ? editPaid : collectPayment ? paymentSplitsTotal : 0;
  const pending = isEdit ? total - editPaid : Math.max(total - collected, 0);

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
    mutationFn: (data: any) => (isEdit ? apiPut(`/sales/invoices/${editId}`, { ...buildBody(data), payments: undefined, estimateIds: undefined, reason: editReason.trim() || undefined })
      : apiPost('/sales/invoices', buildBody(data))),
    onSuccess: (res: any) => {
      const inv = res?.data ?? res;
      qc.invalidateQueries({ queryKey: ['sales-invoices'] });
      qc.invalidateQueries({ queryKey: ['invoice-detail'] });
      // Credit was spent (or old gold left some behind) and the customer's balance moved.
      qc.invalidateQueries({ queryKey: ['client-credit'] });
      qc.invalidateQueries({ queryKey: ['clients-list'] });
      setCreatedInvoice(inv);
      enqueueSnackbar(`Invoice ${inv?.invoiceNumber ?? ''} ${isEdit ? 'updated' : 'created'}`, { variant: 'success' });
    },
    onError: (e: any) => enqueueSnackbar(e.response?.data?.error ?? (isEdit ? 'Failed to update invoice' : 'Failed to create invoice'), { variant: 'error' }),
  });

  // The invoice as the server takes it (POST to create; PUT to amend sends the same bill plus each line's `id`).
  function buildBody(data: any) {
    return {
      ...data,
      invoiceDate: new Date(data.invoiceDate),
      discountAmount: discount,
      otherCharges: Number(data.otherCharges) || 0,
      // Left out on AUTO so the server rounds to the rupee itself; a keyed figure (0 = none) is sent as typed.
      roundOff: roundMode === 'MANUAL' ? Number(roundManual) || 0 : undefined,
      // Editing: a cleared field must go through as null (undefined would mean "leave as it was").
      salesPersonId: data.salesPersonId || (isEdit ? null : undefined),
      terms: data.terms || (isEdit ? null : undefined),
      notes: isEdit ? (data.notes || null) : data.notes,
      estimateIds: lines.filter((l) => l.estimateId).map((l) => l.estimateId),
      payments: collectPayment && paymentSplits.length > 0
        ? paymentSplits
            .filter((p) => p.mode === 'OLD_GOLD' || Number(p.amount) > 0)
            .map((p) => ({
              paymentDate: new Date(p.paymentDate),
              // Old gold: the server values the metal itself — this is only the preview figure.
              amount: splitAmount(p),
              mode: p.mode,
              referenceNo: p.referenceNo || undefined,
              notes: p.notes || undefined,
              ...(p.mode === 'OLD_GOLD' && {
                oldGold: {
                  description: p.og.description.trim(),
                  karat: p.og.karat,
                  grossWeight: Number(p.og.gross),
                  stoneWeight: Number(p.og.stone) || undefined,
                  deductionPercent: Number(p.og.deduction) || undefined,
                },
              }),
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
        ...(l.invoiceItemId && { id: l.invoiceItemId }),
        rateType: l.rateType ?? 'PER_GRAM',
        // Omit (rather than send 0) when unset so the server resolves today's MetalRate for
        // `karat` (C2) instead of pricing the line at zero. (A stored line being edited always sends its figures.)
        goldRate: l.invoiceItemId ? Number(l.goldRate) : Number(l.goldRate) || undefined,
        // Omit (rather than send 0) when unset so the server pulls the MakingCharge master's rate
        // for the line's category (C3) instead of pricing the making charge at zero. wastagePercent
        // stays an always-explicit 0 default — unlike goldRate/makingCharge, a genuine 0% wastage
        // is a common, deliberate value, not a "field left blank" signal.
        makingCharge: l.invoiceItemId ? Number(l.makingCharge) : Number(l.makingCharge) || undefined,
        wastagePercent: Number(l.wastagePercent) || 0,
        stoneValue: Number(l.stoneValue) || 0,
        tagId: l.tagId,
        categoryId: l.categoryId || undefined,
        hsnCode: l.hsnCode || undefined,
        salesPersonId: l.salesPersonId || undefined,
      })),
    };
  }

  const handleSaveAndNew = () => {
    setCreatedInvoice(null);
    reset({
      clientId: '', branchId, invoiceType: 'RETAIL', invoiceDate: new Date().toISOString().split('T')[0], currency: 'INR',
      discountAmount: 0, otherCharges: 0, salesPersonId: '', terms: 'IMMEDIATE', notes: '',
    });
    setLines([]);
    setCollectPayment(false);
    setPaymentSplits([]);
    setDiscountMode('AMOUNT'); setDiscountPercent(''); setRoundMode('AUTO'); setRoundManual('');
    setActiveTab(0);
  };

  // Loading an estimate lives on the first tab only: it supplies the customer, so it must not sit behind the
  // 'pick a client' gate that locks the Items tab.
  const renderEstimatePicker = () => (
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
  );

  const tab1Ready = !!selectedClientId && !!branchId;
  const tab2Ready = tab1Ready && lines.length > 0;

  // Keyboard: Ctrl+Enter = next tab (create on the last), Alt+←/→ = previous/next tab (a locked tab is skipped
  // with a hint), Alt+D = discount/charges/tax, Ctrl+S = jump to the last ready tab, or create when already on it.
  // The invoice is only ever created through the real submit button, so every on-screen guard still applies.
  const goTab = (n: number) => { setActiveTab(n); focusFirstField(formRef.current); };
  const tryTab = (n: number) => {
    if (n === 1 && !tab1Ready) enqueueSnackbar('Pick a customer and branch first', { variant: 'warning' });
    else if (n === 2 && !tab2Ready) enqueueSnackbar('Add at least one item first', { variant: 'warning' });
    else goTab(n);
  };
  const submitFromKeyboard = () => {
    const btn = formRef.current?.querySelector<HTMLButtonElement>('button[type="submit"]');
    if (btn && !btn.disabled) btn.click();
    else enqueueSnackbar('Cannot save yet — check the warnings on this tab', { variant: 'warning' });
  };
  usePageShortcuts({
    'ctrl+enter': () => {
      if (createdInvoice) { if (!isEdit) handleSaveAndNew(); }
      else if (activeTab < 2) tryTab(activeTab + 1);
      else submitFromKeyboard();
    },
    'ctrl+s': () => {
      if (createdInvoice) return;
      if (activeTab === 2) submitFromKeyboard();
      else tryTab(tab2Ready ? 2 : tab1Ready ? 1 : 0);
    },
    'alt+arrowright': () => { if (!createdInvoice && activeTab < 2) tryTab(activeTab + 1); },
    'alt+arrowleft': () => { if (!createdInvoice && activeTab > 0) goTab(activeTab - 1); },
    'alt+d': () => { if (!createdInvoice && tab2Ready) setAdjustOpen(true); },
    // F4: Material Pricing, starting at the focused line (else the last eligible tagged line).
    'f4': () => {
      if (createdInvoice || activeTab !== 1) return;
      const focusedKey = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>('[data-line-key]')?.dataset.lineKey;
      const eligible = lines.filter(isMaterialLine);
      const target = eligible.find((x) => x.key === focusedKey)?.key ?? eligible[eligible.length - 1]?.key;
      if (target) void openMaterials(target);
    },
    'alt+p': () => { if (createdInvoice) printInvoice(createdInvoice); },
  });

  return (
    <Box>
      <PageHeader title={isEdit ? `Edit Invoice ${editInvoice?.invoiceNumber ?? ''}`.trim() : 'New Sale'} />

      <Grid container spacing={3} alignItems="flex-start">
        <Grid item xs={12} md={activeTab === 1 ? 12 : 8}>
          <Card sx={{ p: 0 }}>
            {createdInvoice ? (
              <Box sx={{ p: 3 }}>
                <Alert severity="success" icon={<CheckCircle />} sx={{ mb: 2 }}>
                  <Typography fontWeight={700}>Invoice {createdInvoice.invoiceNumber} {isEdit ? 'updated' : 'created'}!</Typography>
                </Alert>
                <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5}>
                  <Button variant="contained" size="large" startIcon={<Print />}
                    onClick={() => printInvoice(createdInvoice)} sx={{ flex: 1 }}>
                    Print Invoice
                  </Button>
                  {!isEdit && (
                    <Button variant="outlined" size="large" startIcon={<AddCircleOutline />} onClick={handleSaveAndNew} sx={{ flex: 1 }}>
                      New Sale
                    </Button>
                  )}
                  <Button variant="text" size="large" onClick={() => navigate('/sales/invoices')} sx={{ flex: 1 }}>
                    View All Invoices
                  </Button>
                </Stack>
              </Box>
            ) : (
              <form ref={formRef} onSubmit={handleSubmit((d) => mutation.mutate(d))}>
                {/* The way back sits on the tab row — it used to cost a header line of its own. */}
                <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 2, borderBottom: 1, borderColor: 'divider', px: 2 }}>
                  <Tabs value={activeTab} onChange={(_, v) => setActiveTab(v)}>
                    <Tab label="1 · Sale Details" />
                    <Tab label="2 · Items" disabled={!tab1Ready} />
                    <Tab label="3 · Charges & Payment" disabled={!tab2Ready} />
                  </Tabs>
                  <Stack direction="row" spacing={1} alignItems="center" sx={{ flexShrink: 0 }}>
                    <Tooltip title={tab2Ready ? 'Discount, charges & tax' : 'Add items first'}>
                      <span>
                        <IconButton color="primary" size="small" disabled={!tab2Ready} aria-label="Discount, charges and tax"
                          onClick={() => setAdjustOpen(true)}
                          sx={{ border: 1, borderColor: 'divider', borderRadius: 2, p: 0.75 }}>
                          {/* a dot when anything has been changed off the plain bill */}
                          <Badge variant="dot" color="secondary"
                            invisible={!(discount > 0.005 || otherCharges > 0 || roundMode === 'MANUAL' || lines.some((l) => l.hsnCode))}>
                            <Tune fontSize="small" />
                          </Badge>
                        </IconButton>
                      </span>
                    </Tooltip>
                    <Button variant="outlined" size="small" startIcon={<ArrowBack />} sx={{ whiteSpace: 'nowrap' }}
                      onClick={() => navigate('/sales/invoices')}>Back to Invoices</Button>
                  </Stack>
                </Box>

                {/* ── Tab 1: Sale Details ── */}
                {activeTab === 0 && (
                  <Box sx={{ p: 3 }}>
                    <Grid container spacing={2}>
                      {!isEdit && <Grid item xs={12}>{renderEstimatePicker()}</Grid>}
                      <Grid item xs={12} sm={7}>
                        <Stack direction="row" spacing={1} alignItems="flex-start">
                          <Controller name="clientId" control={control} rules={{ required: true }}
                            render={({ field, fieldState }) => (
                              <TextField {...field} select fullWidth label="Client *" error={!!fieldState.error} disabled={editLocksClient}
                                helperText={editLocksClient ? 'Fixed — a payment or return is already recorded on this invoice' : undefined}>
                                {clientList.map((c: any) => (
                                  <MenuItem key={c.id} value={c.id}>{c.clientCode} — {c.name}</MenuItem>
                                ))}
                              </TextField>
                            )} />
                          {canCreateClient && (
                            <IconButton title="New Client" onClick={() => setQuickAddOpen(true)} sx={{ mt: 1 }}>
                              <PersonAdd />
                            </IconButton>
                          )}
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
                            <TextField {...field} select fullWidth label="Currency" disabled={isEdit}>
                              <MenuItem value="INR">INR</MenuItem>
                              <MenuItem value="USD">USD</MenuItem>
                            </TextField>
                          )} />
                      </Grid>
                      <Grid item xs={6} sm={4}>
                        <Controller name="branchId" control={control} rules={{ required: true }}
                          render={({ field, fieldState }) => (
                            <SelectField {...field} label="Branch *" emptyLabel="Select branch…" error={!!fieldState.error} disabled={isEdit}
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
                        <Button variant="outlined" startIcon={<Add />} onClick={addCustomLine} sx={{ whiteSpace: 'nowrap' }}>Add custom line</Button>
                      </Grid>


                      {lines.length > 0 && (
                        <Grid item xs={12}>
                          <Box sx={{ overflowX: 'auto' }}>
                            <Table size="small" sx={{ tableLayout: 'fixed', minWidth: 940, '& .MuiTableCell-root': { px: 1, py: 1, verticalAlign: 'middle' }, '& .MuiTableCell-head': { whiteSpace: 'nowrap' } }}>
                              <TableHead>
                                <TableRow>
                                  <TableCell sx={{ width: '22%' }}>Item</TableCell>
                                  <TableCell sx={{ width: '11%' }}>Category</TableCell>
                                  <TableCell align="right" sx={{ width: '9%' }}>Net Wt (g)</TableCell>
                                  <TableCell align="right" sx={{ width: '11%' }}>Gold Rate (₹/g)</TableCell>
                                  <TableCell align="right" sx={{ width: '10%' }}>Making (₹)</TableCell>
                                  <TableCell align="right" sx={{ width: '7%' }}>VA %</TableCell>
                                  <TableCell align="right" sx={{ width: '10%' }}>Stones (₹)</TableCell>
                                  <TableCell align="right" sx={{ width: '6%' }}>Qty</TableCell>
                                  <TableCell align="right" sx={{ width: '12%' }}>Line Total</TableCell>
                                  <TableCell sx={{ width: 48 }} />
                                </TableRow>
                              </TableHead>
                              <TableBody>
                                {lines.map((l) => (
                                  <TableRow key={l.key} data-line-key={l.key} sx={isLocked(l) ? { opacity: 0.6 } : undefined}>
                                    <TableCell>
                                      {l.tagId ? (
                                        <Box>
                                          <Stack direction="row" spacing={0.75} alignItems="center" flexWrap="wrap" useFlexGap>
                                            <Typography sx={{ fontFamily: 'monospace', fontSize: 12, color: '#44C47A', fontWeight: 700 }}>
                                              {l.tagNumber}
                                            </Typography>
                                            {isLocked(l) && <Chip size="small" color="warning" label="Returned — locked" sx={{ height: 18, fontSize: 10 }} />}
                                            {l.rateType === 'FIXED' && <Chip size="small" variant="outlined" label="Flat price" sx={{ height: 18, fontSize: 10 }} title="Rate column is this line's flat price, not ₹/g" />}
                                            {l.estimateNumber && (
                                              <Chip size="small" color="info" variant="outlined" label={l.estimateNumber} sx={{ height: 18, fontSize: 10, fontFamily: 'monospace' }} />
                                            )}
                                          </Stack>
                                          <Typography variant="body2" color="text.secondary" noWrap title={l.description}>{l.description}</Typography>
                                          {!l.estimate && !isLocked(l) && (
                                            <Button size="small" sx={{ p: 0, minWidth: 0, fontSize: 11 }} disabled={matLoading} onClick={() => void openMaterials(l.key)}>Materials (F4)</Button>
                                          )}
                                        </Box>
                                      ) : (
                                        <TextField size="small" fullWidth placeholder="Description" value={l.description} disabled={isLocked(l)}
                                          onChange={(e) => updateLine(l.key, 'description', e.target.value)} />
                                      )}
                                    </TableCell>
                                    <TableCell>
                                      {l.tagId ? (
                                        <Typography variant="body2">{l.categoryName ?? '—'}</Typography>
                                      ) : (
                                        <TextField size="small" select fullWidth value={l.categoryId ?? ''} disabled={isLocked(l)}
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
                                      {l.tagId ? <Typography component="span" variant="body2" sx={{ fontFamily: 'monospace' }}>{Number(l.netGoldWeight).toFixed(3)}</Typography> : (
                                        <TextField size="small" fullWidth type="number" value={l.netGoldWeight} disabled={isLocked(l)}
                                          inputProps={{ step: 0.001, min: 0, style: { textAlign: 'right', width: 50 } }}
                                          onChange={(e) => updateLine(l.key, 'netGoldWeight', Number(e.target.value))} />
                                      )}
                                    </TableCell>
                                    {l.estimate ? (
                                      <TableCell colSpan={4}>
                                        <Stack direction="row" spacing={1.5} justifyContent="space-between" alignItems="center"
                                          sx={{ bgcolor: 'action.hover', borderRadius: 1.5, px: 1.5, py: 0.75 }}>
                                          <Box sx={{ minWidth: 0 }}>
                                            <Typography variant="caption" fontWeight={700} display="block">{l.estimateNumber ? 'Priced from estimate' : 'Priced from material rows'}</Typography>
                                            <Typography variant="caption" color="text.secondary" display="block">
                                              {l.estimate.rows.length} row{l.estimate.rows.length === 1 ? '' : 's'} · MC ₹{l.estimate.mcRate}/g · VA {l.estimate.vaPercent}%
                                              {Math.abs(lineTotal(l) - (l.quotedTotal ?? 0)) > 0.005 ? ` · quoted ₹${Number(l.quotedTotal).toLocaleString('en-IN')}` : ''}
                                            </Typography>
                                          </Box>
                                          <Button size="small" variant="outlined" sx={{ whiteSpace: 'nowrap', flexShrink: 0 }} disabled={isLocked(l) || matLoading} onClick={() => void openMaterials(l.key)}>Edit rates / rows (F4)</Button>
                                        </Stack>
                                      </TableCell>
                                    ) : (<>
                                    <TableCell align="right">
                                      <TextField size="small" fullWidth type="number" value={l.goldRate} disabled={isLocked(l)}
                                        inputProps={{ step: 0.01, min: 0, style: { textAlign: 'right' } }}
                                        onChange={(e) => updateLine(l.key, 'goldRate', Number(e.target.value))} />
                                    </TableCell>
                                    <TableCell align="right">
                                      <TextField size="small" fullWidth type="number" value={l.makingCharge} disabled={isLocked(l) || l.rateType === 'FIXED'}
                                        inputProps={{ step: 0.01, min: 0, style: { textAlign: 'right' } }}
                                        onChange={(e) => updateLine(l.key, 'makingCharge', Number(e.target.value))} />
                                    </TableCell>
                                    <TableCell align="right">
                                      <TextField size="small" fullWidth type="number" value={l.wastagePercent} disabled={isLocked(l) || l.rateType === 'FIXED'}
                                        inputProps={{ step: 0.1, min: 0, style: { textAlign: 'right' } }}
                                        onChange={(e) => updateLine(l.key, 'wastagePercent', Number(e.target.value))} />
                                    </TableCell>
                                    <TableCell align="right">
                                      <TextField size="small" fullWidth type="number" value={l.stoneValue} disabled={isLocked(l) || l.rateType === 'FIXED'}
                                        inputProps={{ step: 0.01, min: 0, style: { textAlign: 'right' } }}
                                        onChange={(e) => updateLine(l.key, 'stoneValue', Number(e.target.value))} />
                                    </TableCell>
                                    </>)}
                                    <TableCell align="right">
                                      <TextField size="small" fullWidth type="number" value={l.quantity} disabled={!!l.estimate || isLocked(l)}
                                        inputProps={{ step: 1, min: 1, style: { textAlign: 'right' } }}
                                        onChange={(e) => updateLine(l.key, 'quantity', Number(e.target.value))} />
                                    </TableCell>
                                    <TableCell align="right" sx={{ fontFamily: 'monospace', fontWeight: 700, whiteSpace: 'nowrap' }}>
                                      {fmt(lineTotal(l))}
                                    </TableCell>
                                    <TableCell>
                                      <IconButton size="small" color="error" disabled={isLocked(l)} onClick={() => removeLine(l.key)}>
                                        <Delete fontSize="small" />
                                      </IconButton>
                                    </TableCell>
                                  </TableRow>
                                ))}
                              </TableBody>
                            </Table>
                          </Box>

                          {categoryRows.length > 0 && (
                            <Box sx={{ mt: 2.5, ml: 'auto', maxWidth: 460 }}>
                              <Typography variant="overline" color="text.secondary" sx={{ display: 'block', lineHeight: 1.8 }}>
                                By category
                              </Typography>
                              <Table size="small" sx={{ border: 1, borderColor: 'divider', borderRadius: 1, '& .MuiTableCell-root': { px: 1.5 } }}>
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
                      <Stack direction="row" spacing={3} alignItems="center">
                        {lines.length > 0 && (
                          <Typography sx={{ fontFamily: 'monospace' }}>
                            {lines.length} line{lines.length === 1 ? '' : 's'} · Subtotal <b>{fmt(subtotal)}</b>
                          </Typography>
                        )}
                        <Button variant="contained" size="large" disabled={!tab2Ready} onClick={() => setActiveTab(2)}>
                          Next: Charges & Payment →
                        </Button>
                      </Stack>
                    </Stack>
                  </Box>
                )}

                {/* ── Tab 3: Charges & Payment ── */}
                {activeTab === 2 && (
                  <Box sx={{ p: 3 }}>
                    {panBlocked && (
                      <Alert severity="warning" sx={{ mb: 2 }}
                        action={<Button color="inherit" size="small" onClick={() => setKycOpen(true)}>Add PAN / Form 60</Button>}>
                        This sale is {fmt(total)}, above ₹2,00,000. {selectedClient?.name} needs a PAN (or a Form 60 on file) before the invoice can be created.
                      </Alert>
                    )}

                    {!isEdit && creditAvailable > 0 && (
                      <Alert severity="info" sx={{ mb: 1 }}
                        action={<Button color="inherit" size="small" onClick={useStoreCredit}>Use credit</Button>}>
                        {selectedClient?.name} has <b>{fmt(creditAvailable)}</b> credit on account (from a sales return or old gold exchange). Pay with it using the Store Credit mode.
                      </Alert>
                    )}

                    {isEdit ? (
                    <Box sx={{ mt: 2 }}>
                      <Alert severity="warning" sx={{ mb: 2 }}>
                        You are editing an issued invoice. Stock, GST and {selectedClient?.name ?? 'the customer'}'s balance are adjusted to the new bill; the
                        original ledger entries stay and a correcting entry is added. Payments already recorded ({fmt(editPaid)}) are not changed —
                        the balance is recalculated from them.
                      </Alert>
                      <TextField fullWidth size="small" label="Reason for the change (kept in the audit log)" value={editReason}
                        onChange={(e) => setEditReason(e.target.value)} />
                    </Box>
                    ) : (
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
                                  <Fragment key={p.key}>
                                  <TableRow>
                                    <TableCell>
                                      <TextField size="small" type="date" value={p.paymentDate}
                                        InputLabelProps={{ shrink: true }} sx={{ width: 145 }}
                                        onChange={(e) => updatePaymentSplit(p.key, 'paymentDate', e.target.value)} />
                                    </TableCell>
                                    <TableCell align="right">
                                      {p.mode === 'OLD_GOLD' ? (
                                        // Not typed: valued from the metal below.
                                        <Typography sx={{ fontFamily: 'monospace', fontWeight: 700 }}>{fmt(oldGoldValue(p))}</Typography>
                                      ) : (
                                        <TextField size="small" type="number" value={p.amount}
                                          inputProps={{ step: 0.01, min: 0, style: { textAlign: 'right', width: 100 } }}
                                          error={p.mode === 'STORE_CREDIT' && creditBlocked}
                                          onChange={(e) => updatePaymentSplit(p.key, 'amount', Number(e.target.value))} />
                                      )}
                                    </TableCell>
                                    <TableCell>
                                      {/* Native select: arrow keys / type-ahead change it without opening it (CLAUDE.md §10). */}
                                      <SelectField size="small" fullWidth={false} value={p.mode} sx={{ width: 170 }}
                                        onChange={(e) => changePaymentMode(p, e.target.value)}>
                                        {PAYMENT_MODES.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
                                        <option value="OLD_GOLD">Old Gold (metal)</option>
                                        <option value="STORE_CREDIT" disabled={creditAvailable <= 0 && p.mode !== 'STORE_CREDIT'}>
                                          {creditAvailable > 0 ? `Store Credit (${fmt(creditAvailable)})` : 'Store Credit (none)'}
                                        </option>
                                      </SelectField>
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
                                  {p.mode === 'OLD_GOLD' && (
                                    <TableRow sx={{ '& td': { bgcolor: 'action.hover' } }}>
                                      <TableCell colSpan={6}>
                                        <Stack direction="row" spacing={1.5} alignItems="center" flexWrap="wrap" useFlexGap>
                                          <TextField size="small" label="Old item" value={p.og.description} sx={{ width: 170 }}
                                            InputLabelProps={{ shrink: true }}
                                            onChange={(e) => updateOldGold(p.key, 'description', e.target.value)} />
                                          <SelectField size="small" fullWidth={false} label="Karat" value={p.og.karat} sx={{ width: 110 }}
                                            emptyLabel="—" onChange={(e) => updateOldGold(p.key, 'karat', e.target.value)}>
                                            {karatList.map((k: any) => <option key={k.code} value={k.code}>{k.code}</option>)}
                                          </SelectField>
                                          <TextField size="small" type="number" label="Gross wt (g)" value={p.og.gross} sx={{ width: 120 }}
                                            InputLabelProps={{ shrink: true }} inputProps={{ step: 0.001, min: 0 }}
                                            onChange={(e) => updateOldGold(p.key, 'gross', e.target.value)} />
                                          <TextField size="small" type="number" label="Stone wt (g)" value={p.og.stone} sx={{ width: 120 }}
                                            InputLabelProps={{ shrink: true }} inputProps={{ step: 0.001, min: 0 }}
                                            onChange={(e) => updateOldGold(p.key, 'stone', e.target.value)} />
                                          <TextField size="small" type="number" label="Deduction %" value={p.og.deduction} sx={{ width: 110 }}
                                            InputLabelProps={{ shrink: true }} inputProps={{ step: 0.1, min: 0, max: 100 }}
                                            onChange={(e) => updateOldGold(p.key, 'deduction', e.target.value)} />
                                          <Typography variant="body2" color="text.secondary" sx={{ fontFamily: 'monospace' }}>
                                            Net {Math.max((Number(p.og.gross) || 0) - (Number(p.og.stone) || 0), 0).toFixed(3)} g
                                            {p.og.karat && (latestRateByKarat[p.og.karat]
                                              ? ` × ${fmt(latestRateByKarat[p.og.karat])}/g today`
                                              : ' — no rate for this karat today')}
                                          </Typography>
                                        </Stack>
                                      </TableCell>
                                    </TableRow>
                                  )}
                                  </Fragment>
                                ))}
                              </TableBody>
                            </Table>
                          </Box>
                          {cashBlocked && (
                            <Alert severity="error" sx={{ mt: 1 }}>
                              Cash of ₹2,00,000 or more from one customer in a day is not allowed (Sec 269ST). Take the rest by UPI, card, cheque or bank transfer.
                            </Alert>
                          )}
                          {creditBlocked && (
                            <Alert severity="error" sx={{ mt: 1 }}>
                              {selectedClient?.name} has {fmt(creditAvailable)} of store credit, but {fmt(storeCreditUsed)} is entered.
                            </Alert>
                          )}
                          {oldGoldIncomplete && (
                            <Alert severity="warning" sx={{ mt: 1 }}>
                              Old gold needs a description, a karat with today's rate, and a weight (stone weight cannot exceed gross) to be valued.
                            </Alert>
                          )}
                          <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mt: 1 }}>
                            <Button size="small" startIcon={<Add />} onClick={() => addPaymentSplit()}>
                              Add split (e.g. part cash, part UPI)
                            </Button>
                            <Typography variant="body2" sx={{ fontFamily: 'monospace' }}>
                              Collecting <b>{fmt(paymentSplitsTotal)}</b> of {fmt(total)}
                              {paymentSplitsTotal > total + 0.005 && paymentSplitsTotal - total <= oldGoldTotal + 0.005 ? (
                                <Typography component="span" color="info.main" sx={{ ml: 1.5 }}>
                                  {fmt(paymentSplitsTotal - total)} of old gold stays as credit on the account
                                </Typography>
                              ) : paymentSplitsTotal > total + 0.005 ? (
                                <Typography component="span" color="error.main" sx={{ ml: 1 }}>(exceeds total)</Typography>
                              ) : pending > 0.005 ? (
                                <Typography component="span" color="warning.main" sx={{ ml: 1.5 }}>Pending <b>{fmt(pending)}</b></Typography>
                              ) : (
                                <Typography component="span" color="success.main" sx={{ ml: 1.5 }}>Fully collected</Typography>
                              )}
                            </Typography>
                          </Stack>
                        </Box>
                      )}
                    </Box>
                    )}

                    <Stack direction="row" justifyContent="space-between" sx={{ mt: 3 }}>
                      <Button variant="text" onClick={() => setActiveTab(1)}>← Back</Button>
                      <Button type="submit" variant="contained" size="large" disabled={mutation.isPending || panBlocked || cashBlocked || roundBad || creditBlocked || oldGoldIncomplete}>
                        {mutation.isPending ? (isEdit ? 'Saving…' : 'Creating…') : isEdit ? 'Save Changes' : 'Create Invoice'}
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
            {activeTab === 2 ? (
              <>
                <SaleSummary f={figures} />
                {/* Under the Net Amount: what is being taken now, and what is still owed. */}
                <Card sx={{ mt: 1.5, px: 2, py: 1.25 }}>
                  <Stack spacing={0.5}>
                    <Stack direction="row" justifyContent="space-between">
                      <Typography variant="body2" color="text.secondary">{isEdit ? 'Already paid' : 'Collecting now'}</Typography>
                      <Typography variant="body2" sx={{ fontFamily: 'monospace', color: 'success.main' }}>{fmt(collected)}</Typography>
                    </Stack>
                    <Stack direction="row" justifyContent="space-between">
                      <Typography variant="body2" fontWeight={700}>{isEdit ? (pending < -0.005 ? 'Over-paid by' : 'Balance due') : 'Pending'}</Typography>
                      <Typography variant="body2" fontWeight={700} sx={{ fontFamily: 'monospace', color: pending > 0.005 ? 'warning.main' : 'success.main' }}>
                        {fmt(isEdit ? Math.abs(pending) : pending)}
                      </Typography>
                    </Stack>
                  </Stack>
                </Card>
                <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1, ml: 0.5 }}>
                  {selectedClient?.name ?? '— no customer —'} · {lines.length} line{lines.length === 1 ? '' : 's'}
                </Typography>
              </>
            ) : (<>
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
                  <>
                    <Stack direction="row" justifyContent="space-between">
                      <Typography variant="body2" color="text.secondary">Collecting now</Typography>
                      <Typography sx={{ fontFamily: 'monospace', color: 'success.main' }}>
                        {fmt(paymentSplitsTotal)}
                      </Typography>
                    </Stack>
                    <Stack direction="row" justifyContent="space-between">
                      <Typography variant="body2" color="text.secondary">Pending</Typography>
                      <Typography sx={{ fontFamily: 'monospace', color: pending > 0.005 ? 'warning.main' : 'success.main' }}>{fmt(pending)}</Typography>
                    </Stack>
                  </>
                )}
              </Stack>
            </Card>
            </>)}
          </Grid>
        )}
      </Grid>

      {/* Discount, shipping, GST and round-off — everything that moves the bill off the gross, all editable. The Summary
          on the payment tab updates live behind it. */}
      <Dialog open={adjustOpen} onClose={() => setAdjustOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle fontWeight={700}>Discount, charges &amp; tax</DialogTitle>
        <DialogContent>
                <Table size="small" sx={{ '& .MuiTableCell-root': { px: 1.5, py: 1, verticalAlign: 'middle' } }}>
                  <TableHead>
                    <TableRow>
                      <TableCell sx={{ width: '22%' }}>Prompt</TableCell>
                      <TableCell>Value</TableCell>
                      <TableCell align="right" sx={{ width: '24%' }}>Amount</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    <TableRow>
                      <TableCell>Discount</TableCell>
                      <TableCell>
                        <Stack direction="row" spacing={1} alignItems="center">
                          <ToggleButtonGroup exclusive size="small" value={discountMode}
                            onChange={(_, v) => { if (v) setDiscountMode(v); }} aria-label="Discount type">
                            <ToggleButton value="AMOUNT" sx={{ px: 1.5 }}>₹</ToggleButton>
                            <ToggleButton value="PERCENT" sx={{ px: 1.5 }}>%</ToggleButton>
                          </ToggleButtonGroup>
                          {discountMode === 'AMOUNT' ? (
                            <Controller name="discountAmount" control={control}
                              render={({ field }) => (
                                <TextField {...field} size="small" type="number" sx={{ width: 150 }}
                                  inputProps={{ step: 0.01, min: 0, 'aria-label': 'Discount amount' }} />
                              )} />
                          ) : (
                            <TextField size="small" type="number" sx={{ width: 150 }} value={discountPercent}
                              onChange={(e) => setDiscountPercent(e.target.value === '' ? '' : Number(e.target.value))}
                              inputProps={{ step: 0.01, min: 0, max: 100, 'aria-label': 'Discount percent' }} />
                          )}
                        </Stack>
                      </TableCell>
                      <TableCell align="right" sx={{ fontFamily: 'monospace' }}>− {fmt(discount)}</TableCell>
                    </TableRow>
                    <TableRow>
                      <TableCell>Shipping / Other</TableCell>
                      <TableCell>
                        <Controller name="otherCharges" control={control}
                          render={({ field }) => (
                            <TextField {...field} size="small" type="number" sx={{ width: 150 }}
                              inputProps={{ step: 0.01, min: 0, 'aria-label': 'Shipping or other charges' }} />
                          )} />
                      </TableCell>
                      <TableCell align="right" sx={{ fontFamily: 'monospace' }}>+ {fmt(otherCharges)}</TableCell>
                    </TableRow>
                    <TableRow>
                      <TableCell>GST</TableCell>
                      <TableCell>
                        <Stack direction="row" spacing={1.5} alignItems="center">
                          <Typography variant="body2" color="text.secondary">
                            {currency !== 'INR' ? 'Not charged on a non-INR bill'
                              : gstRows.length === 0 ? '—'
                              : gstRows.map((g) => `${Number((g.rate * 100).toFixed(3))}%`).join(' · ')}
                            {currency === 'INR' && gstRows.length > 0 && (sameState ? ' · CGST + SGST' : ' · IGST')}
                          </Typography>
                          <Button size="small" variant="outlined" disabled={currency !== 'INR' || lines.length === 0}
                            onClick={() => setGstOpen(true)}>Edit GST (HSN)</Button>
                        </Stack>
                      </TableCell>
                      <TableCell align="right" sx={{ fontFamily: 'monospace' }}>+ {fmt(taxAmount)}</TableCell>
                    </TableRow>
                    <TableRow>
                      <TableCell>Round off</TableCell>
                      <TableCell>
                        <Stack direction="row" spacing={1.5} alignItems="center">
                          <FormControlLabel sx={{ mr: 0 }}
                            control={<Switch size="small" checked={roundMode === 'AUTO'}
                              onChange={(e) => {
                                if (e.target.checked) { setRoundMode('AUTO'); return; }
                                setRoundManual(Math.round(roundOff * 100) / 100); // start the manual figure from what auto gave
                                setRoundMode('MANUAL');
                              }} />}
                            label={<Typography variant="body2">Auto (nearest ₹1)</Typography>} />
                          {roundMode === 'MANUAL' && (
                            <TextField size="small" type="number" sx={{ width: 130 }} value={roundManual}
                              onChange={(e) => setRoundManual(e.target.value === '' ? '' : Number(e.target.value))}
                              error={roundBad} helperText={roundBad ? `Within ±₹${MAX_ROUND_OFF} — use Discount for more` : undefined}
                              inputProps={{ step: 0.01, 'aria-label': 'Round off amount' }} />
                          )}
                        </Stack>
                      </TableCell>
                      <TableCell align="right" sx={{ fontFamily: 'monospace' }}>
                        {Math.abs(roundOff) < 0.005 ? '0.00' : `${roundOff > 0 ? '+' : '−'} ${fmt(Math.abs(roundOff))}`}
                      </TableCell>
                    </TableRow>
                    <TableRow>
                      <TableCell colSpan={2} sx={{ fontWeight: 700 }}>Net Amount</TableCell>
                      <TableCell align="right" sx={{ fontFamily: 'monospace', fontWeight: 700, fontSize: 16 }}>{fmt(total)}</TableCell>
                    </TableRow>
                  </TableBody>
                </Table>
        </DialogContent>
        <DialogActions sx={{ p: 2 }}>
          <Button variant="contained" onClick={() => setAdjustOpen(false)}>Done</Button>
        </DialogActions>
      </Dialog>

      {/* GST is per line, by HSN: rates come from the HSN master, never typed — pick the HSN a line is billed under. */}
      <Dialog open={gstOpen} onClose={() => setGstOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle fontWeight={700}>Edit GST — HSN per line</DialogTitle>
        <DialogContent>
          <Stack direction="row" spacing={1.5} alignItems="center" sx={{ mb: 2, mt: 0.5 }}>
            <Typography variant="body2" color="text.secondary" sx={{ whiteSpace: 'nowrap' }}>Set all lines to</Typography>
            <SelectField size="small" emptyLabel="—" value="" inputProps={{ 'aria-label': 'Set all lines to HSN' }}
              onChange={(e) => { const v = e.target.value; if (v) setLines((p) => p.map((l) => ({ ...l, hsnCode: v }))); }}
              options={hsnList.map((h) => ({ value: h.code, label: `${h.code} — ${Number((h.gstRate * 100).toFixed(3))}%${h.description ? ` · ${h.description}` : ''}` }))} />
          </Stack>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Item</TableCell>
                <TableCell sx={{ width: '48%' }}>HSN / GST rate</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {lines.map((l) => (
                <TableRow key={l.key}>
                  <TableCell>
                    <Typography variant="body2" fontWeight={600}>{l.tagNumber ?? (l.description || 'Custom line')}</Typography>
                    <Typography variant="caption" color="text.secondary">{fmt(lineTotal(l))}</Typography>
                  </TableCell>
                  <TableCell>
                    <SelectField size="small" value={l.hsnCode ?? defaultHsn} inputProps={{ 'aria-label': `HSN for ${l.tagNumber ?? l.description}` }}
                      onChange={(e) => updateLine(l.key, 'hsnCode', e.target.value)}
                      options={hsnList.map((h) => ({ value: h.code, label: `${h.code} — ${Number((h.gstRate * 100).toFixed(3))}%` }))} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1.5 }}>
            Rates come from the HSN master, so a line can only be billed at a rate that is on it. Shipping / other charges are taxed at {Number((rateOfHsn() * 100).toFixed(3))}% ({defaultHsn}).
          </Typography>
        </DialogContent>
        <DialogActions sx={{ p: 2 }}>
          <Button variant="contained" onClick={() => setGstOpen(false)}>Done</Button>
        </DialogActions>
      </Dialog>

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
          {pendingEstimate?.customerName && (
            <Box sx={{ mb: 2, p: 1.5, bgcolor: 'action.hover', borderRadius: 1 }}>
              <Typography variant="caption" color="text.secondary">Customer (taken by the estimator)</Typography>
              <Typography variant="body2" fontWeight={700}>
                {pendingEstimate.customerName}{pendingEstimate.customerPhone ? ` · ${pendingEstimate.customerPhone}` : ''}
              </Typography>
              {(pendingEstimate.customerDob || pendingEstimate.customerPan) && (
                <Typography variant="caption" display="block">
                  {pendingEstimate.customerDob ? `DOB ${new Date(pendingEstimate.customerDob).toLocaleDateString('en-IN', { timeZone: 'UTC' })}` : ''}
                  {pendingEstimate.customerDob && pendingEstimate.customerPan ? ' · ' : ''}
                  {pendingEstimate.customerPan ? `PAN ${pendingEstimate.customerPan}` : ''}
                </Typography>
              )}
              {pendingEstimate.customerAddress && <Typography variant="caption" display="block">{pendingEstimate.customerAddress}</Typography>}
              <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 0.5 }}>
                {watch('clientId') ? 'A customer is already chosen on this bill — it will be kept.' : 'Becomes the bill’s customer (matched by mobile number, or added).'}
              </Typography>
            </Box>
          )}
          <SelectField label="Sales person *" autoFocus value={pendingStaffId} emptyLabel="Select…"
            onChange={(e) => setPendingStaffId(e.target.value)}
            options={staffList.map((x: any) => ({ value: x.id, label: `${x.name}${x.employeeId ? ` (${x.employeeId})` : ''}` }))} />
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
            You can change the rates or rows of this estimate on the bill, and add or remove other items.
          </Typography>
        </DialogContent>
        <DialogActions sx={{ p: 2 }}>
          <Button onClick={() => setPendingEstimate(null)}>Cancel</Button>
          <Button variant="contained" disabled={!pendingStaffId} onClick={requestConfirmEstimate}>Add to bill</Button>
        </DialogActions>
      </Dialog>

      <CustomerMismatchDialog open={mismatchOpen && !!pendingEstimate} onCancel={() => setMismatchOpen(false)} onConfirm={() => void confirmEstimate()} />

      {matSession && (
        <MaterialPricingDialog
          entries={matSession.entries}
          startKey={matSession.startKey}
          otherLinesTotal={lines.filter((l) => !matSession.entries.some((e) => e.key === l.key)).reduce((t, l) => t + lineTotal(l), 0)}
          onClose={() => setMatSession(null)}
          onApply={applyMaterials}
        />
      )}

      <ClientKycDialog client={kycOpen ? selectedClient ?? null : null} onClose={() => setKycOpen(false)} />

      <QuickAddClientDialog
        open={quickAddOpen}
        onClose={() => setQuickAddOpen(false)}
        onCreated={(client) => { setValue('clientId', client.id); setQuickAddOpen(false); }}
      />
    </Box>
  );
}
