import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Box, Card, CardContent, Grid, Typography, Button, Stack, Divider, Table, TableHead,
  TableBody, TableRow, TableCell, CircularProgress, Chip, TextField, InputAdornment, IconButton,
  Alert, Dialog, DialogTitle, DialogContent, DialogActions, Switch, FormControlLabel,
} from '@mui/material';
import { Edit, Save, Close, QrCodeScanner, Print, ReceiptLong, Send, Undo } from '@mui/icons-material';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useSnackbar } from 'notistack';
import { apiGet, apiPost } from '../../api/client';
import { PageHeader } from '../../components/common/PageHeader';
import { StatusChip } from '../../components/common/StatusChip';
import { useAuthStore } from '../../store/auth.store';
import { NumberField } from '../../components/fields/NumberField';
import { SelectField } from '../../components/fields/SelectField';
import { findMakingCharge, computeLineAmount, computeMakingAmount } from '../../utils/estimateCalc';
import { printTagEstimate } from '../../utils/printTagEstimate';
import { printEstimateToReceiptPrinter } from '../../utils/estimateReceipt';
import { getReceiptPrinterStatus, receiptStatusRefetchMs } from '../../utils/printAgent';

// What "Send to billing" asks for, so the biller does not ask again. Name, mobile and the sales employee are
// required; DOB, address and PAN are optional (the server validates them all again).
interface CustomerForm {
  name: string; phone: string; dob: string; address: string; pan: string; salesPersonId: string;
}
const EMPTY_CUSTOMER: CustomerForm = { name: '', phone: '', dob: '', address: '', pan: '', salesPersonId: '' };

const digitsOnly = (v: string) => v.replace(/\D/g, '').replace(/^(91|0)(?=\d{10}$)/, '');

function validateCustomer(c: CustomerForm): Partial<Record<keyof CustomerForm, string>> {
  const e: Partial<Record<keyof CustomerForm, string>> = {};
  if (!c.name.trim()) e.name = 'Required';
  if (!c.phone.trim()) e.phone = 'Required';
  else if (!/^[6-9]\d{9}$/.test(digitsOnly(c.phone))) e.phone = 'Enter a 10-digit mobile number';
  if (c.dob && (c.dob > new Date().toISOString().slice(0, 10))) e.dob = 'Cannot be in the future';
  if (c.pan.trim() && !/^[A-Za-z]{5}[0-9]{4}[A-Za-z]$/.test(c.pan.trim())) e.pan = 'PAN looks like ABCDE1234F';
  if (!c.salesPersonId) e.salesPersonId = 'Required';
  return e;
}

// A saved estimate's stored customer, back into the form (so re-sending an estimate shows what was taken).
function customerFromEstimate(e: any): CustomerForm {
  return {
    name: e?.customerName ?? '', phone: e?.customerPhone ?? '', dob: e?.customerDob ? String(e.customerDob).slice(0, 10) : '',
    address: e?.customerAddress ?? '', pan: e?.customerPan ?? '', salesPersonId: e?.salesPersonId ?? '',
  };
}

function fmt(n: number) {
  return '₹' + n.toLocaleString('en-IN', { maximumFractionDigits: 2 });
}

interface EditableLine {
  code: string;
  materialType: string;
  name: string;
  weight: number;
  unit: string;
  saleRate: number;
  /** The tag's own material row, and its rate before any offer (for Apply offer + the server's snapshot). */
  materialId?: string;
  baseRate?: number;
}

// Estimation shows the material's short code (e.g. "GOLD-22K"), not its full descriptive name —
// matches the reference estimate slip's compact "Item" column and keeps a piece's material line
// identifiable at a glance rather than wrapping a long description.
function materialLabel(m: any) {
  return m.code || m.materialCode?.name || m.name;
}

// A standalone module (own nav entry, own estimation:view/estimation:manage permissions) — kept
// out of Jewelry Tagging on purpose, so it can be handed to a sales/counter role without also
// granting tag:view/tag:create. Sale-price only: the underlying /estimation API never returns
// cost data to begin with (see estimation.service.ts's ESTIMATE_*_SALE_SELECT), so there's nothing
// to hide here — cost columns simply don't exist in the payload.
export function EstimationPage() {
  const { enqueueSnackbar, closeSnackbar } = useSnackbar();
  const qc = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();
  // Entering the daily rate is its own grant; the warning below links to the rates page only for people who hold it.
  const canUpdateRates = useAuthStore((s) => s.hasPermission('rate:update'));

  const [query, setQuery] = useState('');
  const [selectedTagId, setSelectedTagId] = useState('');
  const [editing, setEditing] = useState(false);
  const [lines, setLines] = useState<EditableLine[]>([]);
  const [saleMcRate, setSaleMcRate] = useState(0);
  const [saleVaPercent, setSaleVaPercent] = useState(0);
  const [notes, setNotes] = useState('');
  // "Apply offer": the piece's MC/VA as tagged (the offer lowers these), and whether the offer is switched on for this work-up.
  const [applyOffer, setApplyOffer] = useState(false);
  const [baseMcVa, setBaseMcVa] = useState({ mc: 0, va: 0 });

  // Hand-off to the billing counter. `sendTarget`: an already-saved estimate to send, or 'new' to save the
  // current work-up and send that in one go.
  const [sendTarget, setSendTarget] = useState<{ id: string; number: string } | 'new' | null>(null);
  const [customer, setCustomer] = useState<CustomerForm>(EMPTY_CUSTOMER);
  const setCust = (patch: Partial<CustomerForm>) => setCustomer((c) => ({ ...c, ...patch }));
  const custErrors = validateCustomer(customer);
  // Priced below the offer -> the hand-off goes to a store manager for approval instead of to billing. `serverAsked`: the
  // server decided that for an already-saved estimate (we cannot tell from here what it was saved at).
  const [approvalReason, setApprovalReason] = useState('');
  const [serverAsked, setServerAsked] = useState(false);
  useEffect(() => { setApprovalReason(''); setServerAsked(false); }, [sendTarget]);
  const [showCustErrors, setShowCustErrors] = useState(false);

  const staffQuery = useQuery({ queryKey: ['estimation-staff'], queryFn: () => apiGet<any[]>('/estimation/staff') });
  const staffList: any[] = staffQuery.data ?? [];

  useEffect(() => { inputRef.current?.focus(); }, []);

  const searchQuery = useQuery({
    queryKey: ['estimation-tag-search', query],
    queryFn: () => apiGet<any[]>('/estimation/tags/search', { q: query }),
    enabled: query.trim().length >= 1,
  });
  const matches: any[] = searchQuery.data ?? [];

  // A scan (or a query specific enough to land exactly one match) jumps straight to the estimate
  // view — same convention as StockLookupPage.
  useEffect(() => {
    if (matches.length === 1) setSelectedTagId(matches[0].id);
    else if (selectedTagId && !matches.some((m) => m.id === selectedTagId)) setSelectedTagId('');
  }, [matches]); // eslint-disable-line react-hooks/exhaustive-deps

  const tagQuery = useQuery({
    queryKey: ['estimation-tag-data', selectedTagId],
    queryFn: () => apiGet<any>(`/estimation/tags/${selectedTagId}`),
    enabled: !!selectedTagId,
  });
  const tag = tagQuery.data;

  const estimatesQuery = useQuery({
    queryKey: ['estimation-past', selectedTagId],
    queryFn: () => apiGet<any[]>(`/estimation/tags/${selectedTagId}/estimates`),
    enabled: !!selectedTagId,
  });
  const pastEstimates: any[] = estimatesQuery.data ?? [];

  // What the winning offer (if any) does to this piece's sale rates today. The server picks it by date - no stacking,
  // only ever lowers a rate. It is a read-only preview here; nothing is applied until the user switches it on.
  const offerQuery = useQuery({
    queryKey: ['estimation-offer', selectedTagId],
    queryFn: () => apiGet<any>('/offers/resolve', { tagId: selectedTagId }),
    enabled: !!selectedTagId,
    retry: false,
  });
  const offerRes = (offerQuery.data as any)?.data ?? offerQuery.data;
  const offer = offerRes?.resolution?.offer ? offerRes.resolution : null;

  const { data: makingChargesData } = useQuery({
    queryKey: ['master-making-charges'],
    queryFn: () => apiGet<any>('/masters/making-charges'),
  });
  const makingCharges: any[] = (makingChargesData as any)?.data ?? (makingChargesData as any) ?? [];

  const templatesQuery = useQuery({
    queryKey: ['estimate-templates'],
    queryFn: () => apiGet<any[]>('/estimation/templates'),
  });
  const templates: any[] = templatesQuery.data ?? [];
  const [templateId, setTemplateId] = useState('');
  useEffect(() => {
    if (!templateId && templates.length > 0) {
      setTemplateId((templates.find((t) => t.isDefault) ?? templates[0]).id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [templates.length]);

  useEffect(() => {
    if (!tag) return;
    setEditing(false);
    setNotes('');
    setApplyOffer(false);
    setLines((tag.materials ?? []).map((m: any) => ({
      materialId: m.id, baseRate: Number(m.saleRate ?? 0),
      code: m.code, materialType: m.materialType, name: materialLabel(m),
      weight: Number(m.weight), unit: m.unit, saleRate: Number(m.saleRate ?? 0),
    })));
    // Prefer whatever MC rate/VA% was actually decided for this piece at tagging time — only a
    // tag that predates that column (saleMcRate/saleVaPercent both null) falls back to a fresh
    // MakingCharge master lookup, so a later master-rate change never silently re-prices a piece
    // an executive already settled on.
    if (tag.saleMcRate != null && tag.saleVaPercent != null) {
      setSaleMcRate(Number(tag.saleMcRate));
      setSaleVaPercent(Number(tag.saleVaPercent));
      setBaseMcVa({ mc: Number(tag.saleMcRate), va: Number(tag.saleVaPercent) });
    } else {
      const charge = findMakingCharge(makingCharges, tag.metalKarat, tag.categoryId, tag.makeType);
      setSaleMcRate(charge ? Number(charge.makingCharge) : 0);
      setSaleVaPercent(charge ? Number(charge.saleWastagePercent) : 0);
      setBaseMcVa({ mc: charge ? Number(charge.makingCharge) : 0, va: charge ? Number(charge.saleWastagePercent) : 0 });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tag, makingCharges.length]);

  const items = lines.map((l) => ({ ...l, saleAmount: computeLineAmount(l.weight, l.saleRate) }));
  const metalWeight = items.filter((i) => i.materialType === 'METAL').reduce((s, i) => s + i.weight, 0);
  const metalSaleAmt = items.filter((i) => i.materialType === 'METAL').reduce((s, i) => s + i.saleAmount, 0);
  const materialsSaleAmt = items.reduce((s, i) => s + i.saleAmount, 0);
  const makingSaleAmount = computeMakingAmount(metalWeight, metalSaleAmt, saleMcRate, saleVaPercent);
  const totalSaleAmount = materialsSaleAmt + makingSaleAmount;
  // Indicative GST only — at the default HSN's rate from the HSN master (sent with the tag);
  // the saved TagEstimate snapshots its own taxRate/gstAmount at save time (see estimation.service.ts),
  // this is just the live preview shown before that save happens.
  const gstAmount = Math.round(totalSaleAmount * Number(tag?.defaultGstRate ?? 0) * 100) / 100;
  const netPayableAmount = totalSaleAmount + gstAmount;

  // Switching the offer on/off resets the rates to the offered / tagged ones (any hand edit made before is replaced).
  const toggleOffer = (on: boolean) => {
    if (on && !offer) return;
    setApplyOffer(on);
    setLines((ls) => ls.map((l) => {
      const base = l.baseRate ?? l.saleRate;
      const adj = on && l.materialId ? offer?.rows?.[l.materialId] : undefined;
      return { ...l, saleRate: adj ? Number(adj.offerRate) : base };
    }));
    setSaleMcRate(on && offer?.mc ? Number(offer.mc.offerRate) : baseMcVa.mc);
    setSaleVaPercent(on && offer?.va ? Number(offer.va.offerRate) : baseMcVa.va);
  };
  // What the same piece would cost at the tagged rates, to show the customer's saving (before GST).
  const baseMetalAmt = lines.filter((l) => l.materialType === 'METAL').reduce((s, l) => s + computeLineAmount(l.weight, l.baseRate ?? l.saleRate), 0);
  const baseTotal = lines.reduce((s, l) => s + computeLineAmount(l.weight, l.baseRate ?? l.saleRate), 0)
    + computeMakingAmount(metalWeight, baseMetalAmt, baseMcVa.mc, baseMcVa.va);
  const offerSaving = applyOffer ? Math.max(0, baseTotal - totalSaleAmount) : 0;

  // Is the work-up on screen priced below the offered rates (zero tolerance)? Mirrors the server's own check, which decides.
  const belowOfferNow = !!offer && (
    (!!offer.mc && saleMcRate < Number(offer.mc.offerRate))
    || (!!offer.va && saleVaPercent < Number(offer.va.offerRate))
    || lines.some((l) => !!l.materialId && !!offer.rows?.[l.materialId] && Number(l.saleRate) < Number(offer.rows[l.materialId].offerRate))
  );
  const approvalMode = (sendTarget === 'new' && belowOfferNow) || serverAsked;

  const updateLine = (idx: number, patch: Partial<EditableLine>) => {
    setLines((ls) => ls.map((l, i) => (i === idx ? { ...l, ...patch } : l)));
  };

  // Deliberately not gated on `editing` — a tag whose materials/MC/VA already reflect its real
  // price (auto-filled from the tag + MakingCharge master on load) is a perfectly valid estimate
  // to save or print as-is; "Edit" is only for when the customer needs a different number.
  const buildEstimatePayload = () => ({
    items: lines.map((l) => ({ materialId: l.materialId, code: l.code, materialType: l.materialType, name: l.name, weight: l.weight, unit: l.unit, saleRate: l.saleRate })),
    saleMcRate, saleVaPercent,
    applyOffer: applyOffer || undefined,
    notes: notes.trim() || undefined,
  });

  const saveMutation = useMutation({
    mutationFn: () => apiPost<any>(`/estimation/tags/${selectedTagId}/estimates`, buildEstimatePayload()),
    onSuccess: (saved) => {
      enqueueSnackbar(`Estimate ${saved.estimateNumber} saved`, { variant: 'success' });
      qc.invalidateQueries({ queryKey: ['estimation-past', selectedTagId] });
      setEditing(false);
    },
    onError: (e: any) => enqueueSnackbar(e.response?.data?.error ?? 'Failed to save estimate', { variant: 'error' }),
  });

  // Every print saves its own numbered estimate first — "what you saved is what you printed,"
  // and it leaves a traceable record of every quote actually handed to a customer.
  const printMutation = useMutation({
    mutationFn: () => apiPost<any>(`/estimation/tags/${selectedTagId}/estimates`, buildEstimatePayload()),
    onSuccess: (saved) => {
      qc.invalidateQueries({ queryKey: ['estimation-past', selectedTagId] });
      setEditing(false);
      const template = templates.find((t) => t.id === templateId);
      if (!template) { enqueueSnackbar('No print template selected', { variant: 'warning' }); return; }
      printTagEstimate(template, tag, saved);
    },
    onError: (e: any) => enqueueSnackbar(e.response?.data?.error ?? 'Failed to save estimate', { variant: 'error' }),
  });

  const sendMutation = useMutation({
    mutationFn: () => {
      const details = {
        customerName: customer.name.trim(), customerPhone: customer.phone.trim(), customerDob: customer.dob || undefined,
        customerAddress: customer.address.trim() || undefined, customerPan: customer.pan.trim().toUpperCase() || undefined,
        salesPersonId: customer.salesPersonId,
        ...(approvalMode && { approvalReason: approvalReason.trim() }),
      };
      return sendTarget === 'new'
        ? apiPost<any>(`/estimation/tags/${selectedTagId}/estimates`, { ...buildEstimatePayload(), sendToBilling: true, ...details })
        : apiPost<any>(`/estimation/estimates/${(sendTarget as { id: string }).id}/send-to-billing`, details);
    },
    onSuccess: (saved) => {
      enqueueSnackbar(saved.status === 'AWAITING_APPROVAL'
        ? `Estimate ${saved.estimateNumber} sent to a store manager for approval - it goes to billing once approved`
        : `Estimate ${saved.estimateNumber} sent to billing`, { variant: 'success' });
      qc.invalidateQueries({ queryKey: ['estimation-past', selectedTagId] });
      setSendTarget(null); setCustomer(EMPTY_CUSTOMER); setShowCustErrors(false); setEditing(false);
    },
    onError: (e: any) => {
      if (e.response?.data?.code === 'APPROVAL_REASON_REQUIRED') { setServerAsked(true); setShowCustErrors(true); }
      enqueueSnackbar(e.response?.data?.error ?? 'Failed to send to billing', { variant: e.response?.data?.code === 'APPROVAL_REASON_REQUIRED' ? 'warning' : 'error' });
    },
  });

  // Pull a sent estimate back to OPEN before it is billed (the biller can do the same from the billing screen).
  const recallMutation = useMutation({
    mutationFn: (id: string) => apiPost<any>(`/estimation/estimates/${id}/recall`, {}),
    onSuccess: (saved) => {
      enqueueSnackbar(`Estimate ${saved.estimateNumber} recalled from billing`, { variant: 'success' });
      qc.invalidateQueries({ queryKey: ['estimation-past', selectedTagId] });
    },
    onError: (e: any) => enqueueSnackbar(e.response?.data?.error ?? 'Could not recall the estimate', { variant: 'error' }),
  });

  // ── Receipt printer (Epson, via the local print agent) ─────────────────────────────────────────
  // Offered only when the agent is running AND has a receipt printer set; the browser Print button
  // is unchanged. One send at a time (the button locks while one is in flight), and every send
  // carries a job id the agent de-duplicates on: a retry after a failure or timeout re-uses the id
  // for that estimate, so it can never print twice, while a deliberate reprint after a confirmed
  // send gets a fresh id.
  const receiptStatusQuery = useQuery({
    queryKey: ['receipt-printer-status'], queryFn: getReceiptPrinterStatus, retry: false, refetchInterval: receiptStatusRefetchMs(15000),
  });
  const receiptAvailable = Boolean(receiptStatusQuery.data?.configured);
  const [receiptBusy, setReceiptBusy] = useState(false);
  const receiptBusyRef = useRef(false);
  const receiptJobIds = useRef(new Map<string, string>());

  const sendToReceipt = async (estimate: any) => {
    const template = templates.find((t) => t.id === templateId);
    if (!template) { enqueueSnackbar('No print template selected', { variant: 'warning' }); return; }
    if (receiptBusyRef.current) return;
    receiptBusyRef.current = true; setReceiptBusy(true);
    let jobId = receiptJobIds.current.get(estimate.id);
    if (!jobId) { jobId = `est-${estimate.id}-${Date.now().toString(36)}`; receiptJobIds.current.set(estimate.id, jobId); }
    const progress = enqueueSnackbar(`Sending ${estimate.estimateNumber} to the receipt printer…`, { variant: 'info', persist: true });
    try {
      const r = await printEstimateToReceiptPrinter(template, tag, estimate, jobId);
      receiptJobIds.current.delete(estimate.id);
      // Honest wording: the agent confirms the Windows print queue accepted it, not that paper came out.
      enqueueSnackbar(r.duplicate
        ? `${estimate.estimateNumber} was already sent to the printer - not printed again`
        : `${estimate.estimateNumber} sent to the receipt printer. Check the slip came out.`, { variant: 'success' });
    } catch (e: any) {
      // The job id is kept: retrying the same estimate re-uses it, and the agent never sends one id twice.
      enqueueSnackbar(`${estimate.estimateNumber} was NOT confirmed as sent: ${e?.message ?? 'unknown error'}. Press the receipt button again to retry.`, { variant: 'error' });
    } finally {
      closeSnackbar(progress);
      receiptBusyRef.current = false; setReceiptBusy(false);
    }
  };

  const receiptMutation = useMutation({
    mutationFn: () => apiPost<any>(`/estimation/tags/${selectedTagId}/estimates`, buildEstimatePayload()),
    onSuccess: (saved) => {
      qc.invalidateQueries({ queryKey: ['estimation-past', selectedTagId] });
      setEditing(false);
      void sendToReceipt(saved);
    },
    onError: (e: any) => enqueueSnackbar(e.response?.data?.error ?? 'Failed to save estimate', { variant: 'error' }),
  });

  const printSavedEstimate = (estimate: any) => {
    const template = templates.find((t) => t.id === templateId);
    if (!template) { enqueueSnackbar('No print template selected', { variant: 'warning' }); return; }
    printTagEstimate(template, tag, estimate);
  };

  return (
    <Box>
      <PageHeader title="Estimation" />

      <Card sx={{ mb: 2 }}>
        <CardContent>
          <TextField
            inputRef={inputRef}
            fullWidth
            autoFocus
            placeholder="Scan barcode, or type tag number / name / HUID..."
            value={query}
            onChange={(e) => { setQuery(e.target.value); setSelectedTagId(''); }}
            InputProps={{
              startAdornment: <InputAdornment position="start"><QrCodeScanner /></InputAdornment>,
              endAdornment: searchQuery.isFetching ? (
                <InputAdornment position="end"><CircularProgress size={18} /></InputAdornment>
              ) : undefined,
            }}
          />
        </CardContent>
      </Card>

      {query.trim().length >= 1 && matches.length > 1 && (
        <Card sx={{ mb: 2 }}>
          <Box sx={{ maxHeight: 320, overflow: 'auto' }}>
            {matches.map((m: any) => (
              <Box key={m.id} onClick={() => setSelectedTagId(m.id)}
                sx={{
                  p: 1.5, cursor: 'pointer', borderBottom: '1px solid', borderColor: 'divider',
                  bgcolor: m.id === selectedTagId ? 'action.selected' : 'transparent',
                  '&:hover': { bgcolor: 'action.hover' },
                }}>
                <Stack direction="row" justifyContent="space-between" alignItems="center">
                  <Stack direction="row" spacing={1.5} alignItems="center">
                    <Typography sx={{ fontFamily: 'monospace', fontWeight: 700, color: '#44C47A' }}>{m.tagNumber}</Typography>
                    <Typography variant="body2">{m.name}</Typography>
                  </Stack>
                  <Stack direction="row" spacing={1.5} alignItems="center">
                    <Typography sx={{ fontFamily: 'monospace', fontWeight: 700 }}>{fmt(m.sellingPrice)}</Typography>
                    <StatusChip status={m.status} />
                  </Stack>
                </Stack>
              </Box>
            ))}
          </Box>
        </Card>
      )}

      {query.trim().length >= 1 && !searchQuery.isFetching && matches.length === 0 && (
        <Card><CardContent><Typography color="text.secondary">No tag matches "{query}".</Typography></CardContent></Card>
      )}

      {tagQuery.isLoading && (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}><CircularProgress /></Box>
      )}

      {/* The piece cannot be priced (a rate is missing on the tag, or no metal rate exists): say exactly why. */}
      {tagQuery.isError && (
        <Alert severity="error" sx={{ mb: 2 }}>{(tagQuery.error as any)?.response?.data?.error ?? 'This piece could not be loaded for estimation.'}</Alert>
      )}

      {tag && !tagQuery.isLoading && (
        <Grid container spacing={2}>
          <Grid item xs={12} md={8}>
            {tag.goldRate && !tag.goldRate.isToday && (
              <Alert severity="warning" sx={{ mb: 2, alignItems: 'center' }}
                action={canUpdateRates ? <Button color="inherit" size="small" onClick={() => navigate('/designs/rates')}>Update rate</Button> : undefined}>
                Today's {tag.goldRate.karat} rate has not been entered yet - this estimate uses the {new Date(`${tag.goldRate.rateDate}T00:00:00`).toLocaleDateString('en-IN')} rate
                (₹{Number(tag.goldRate.ratePerGram).toLocaleString('en-IN')}/g).
              </Alert>
            )}
            {offer && (
              <Alert severity={applyOffer ? 'success' : 'info'} sx={{ mb: 2, alignItems: 'center' }}
                action={
                  <FormControlLabel sx={{ mr: 1 }} label="Apply offer"
                    control={<Switch checked={applyOffer} onChange={(e) => toggleOffer(e.target.checked)} inputProps={{ 'aria-label': 'Apply offer' }} />} />
                }>
                <Typography fontWeight={700}>Offer available: {offer.offer.name}</Typography>
                <Typography variant="body2">
                  {[
                    offer.mc && `Making charge ${fmt(Number(offer.mc.baseRate))} \u2192 ${fmt(Number(offer.mc.offerRate))}/g`,
                    offer.va && `VA ${Number(offer.va.baseRate)}% \u2192 ${Number(offer.va.offerRate)}%`,
                    ...lines.filter((l) => l.materialId && offer.rows?.[l.materialId]).map((l) => `${l.name} ${fmt(Number(offer.rows[l.materialId!].baseRate))} \u2192 ${fmt(Number(offer.rows[l.materialId!].offerRate))}`),
                  ].filter(Boolean).join('  \u00b7  ')}
                </Typography>
              </Alert>
            )}
            {!offer && offerRes && (
              <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>No offer applies to this piece today.</Typography>
            )}
            <Card sx={{ p: 2, mb: 2 }}>
              <Stack direction="row" justifyContent="space-between" alignItems="center" useFlexGap sx={{ mb: 1, flexWrap: 'wrap', gap: 1 }}>
                <Box sx={{ minWidth: 0 }}>
                  <Typography variant="h6" fontWeight={900} sx={{ fontFamily: 'monospace', color: '#44C47A' }}>
                    {tag.tagNumber}
                  </Typography>
                  <Typography variant="body2" color="text.secondary">{tag.name} — {tag.branch?.name}</Typography>
                </Box>
                <Stack direction="row" useFlexGap sx={{ flexWrap: 'wrap', gap: 1 }} alignItems="center">
                  <StatusChip status={tag.status} />
                  <Chip label={editing ? 'Editing' : 'Read-only'} color={editing ? 'warning' : 'default'} size="small" />
                  {editing ? (
                    <Button size="small" variant="outlined" color="inherit" startIcon={<Close />} onClick={() => setEditing(false)}>Cancel</Button>
                  ) : (
                    <Button size="small" variant="outlined" startIcon={<Edit />} onClick={() => setEditing(true)}>Edit</Button>
                  )}
                </Stack>
              </Stack>

              <Divider sx={{ my: 1.5 }} />
              <Typography variant="subtitle1" fontWeight={700} sx={{ mb: 1 }}>Materials</Typography>
              <Box sx={{ overflowX: 'auto' }}>
              <Table size="small" sx={{ '& .MuiTableCell-root': { px: { xs: 0.5, sm: 2 }, fontSize: { xs: 11.5, sm: 'inherit' } }, '& .MuiTableCell-head': { fontSize: { xs: 10, sm: '0.75rem' }, letterSpacing: { xs: 0, sm: '0.05em' } } }}>
                <TableHead>
                  <TableRow>
                    <TableCell>Material</TableCell>
                    <TableCell align="right">Weight</TableCell>
                    <TableCell>Unit</TableCell>
                    <TableCell align="right">Sale Rate</TableCell>
                    <TableCell align="right">Sale Amount</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {items.map((l, idx) => (
                    <TableRow key={`${l.code}-${idx}`}>
                      <TableCell>{l.name}</TableCell>
                      <TableCell align="right">{l.weight.toFixed(3)}</TableCell>
                      <TableCell>{l.unit}</TableCell>
                      <TableCell align="right">
                        {editing ? (
                          <NumberField size="small" value={l.saleRate}
                            onChange={(e) => updateLine(idx, { saleRate: Number(e.target.value) })} />
                        ) : applyOffer && l.baseRate != null && l.baseRate !== l.saleRate ? (
                          <>
                            <Typography component="span" variant="caption" color="text.secondary" sx={{ textDecoration: 'line-through', mr: 0.75 }}>{fmt(l.baseRate)}</Typography>
                            <Typography component="span" fontWeight={700} color="success.main">{fmt(l.saleRate)}</Typography>
                          </>
                        ) : fmt(l.saleRate)}
                      </TableCell>
                      <TableCell align="right">{fmt(l.saleAmount)}</TableCell>
                    </TableRow>
                  ))}
                  {items.length === 0 && (
                    <TableRow><TableCell colSpan={5}><Typography color="text.secondary">No materials recorded on this tag.</Typography></TableCell></TableRow>
                  )}
                </TableBody>
              </Table>
              </Box>
            </Card>

            <Card sx={{ p: 2 }}>
              <Typography variant="h6" fontWeight={700} sx={{ mb: 2 }}>Making Charge & Value Addition</Typography>
              <Grid container spacing={2}>
                <Grid item xs={6} sm={4}>
                  <NumberField label="MC Rate (₹/g)" size="small" disabled={!editing} value={saleMcRate}
                    onChange={(e) => setSaleMcRate(Number(e.target.value))}
                    helperText={applyOffer && saleMcRate !== baseMcVa.mc ? `Offer - tagged ${fmt(baseMcVa.mc)}/g` : undefined} />
                </Grid>
                <Grid item xs={6} sm={4}>
                  <NumberField label="VA %" size="small" disabled={!editing} value={saleVaPercent}
                    onChange={(e) => setSaleVaPercent(Number(e.target.value))}
                    helperText={applyOffer && saleVaPercent !== baseMcVa.va ? `Offer - tagged ${baseMcVa.va}%` : undefined} />
                </Grid>
              </Grid>
            </Card>

            <Card sx={{ p: 2, mt: 2 }}>
              <Typography variant="h6" fontWeight={700} sx={{ mb: 1 }}>Notes</Typography>
              <TextField fullWidth multiline minRows={2} size="small"
                placeholder="e.g. terms, a discount reason, delivery note — printed on templates with a Notes field"
                value={notes} onChange={(e) => setNotes(e.target.value)} />
            </Card>
          </Grid>

          <Grid item xs={12} md={4}>
            <Card sx={{ p: 2, mb: 2, position: { md: 'sticky' }, top: 16 }}>
              <Typography variant="h6" fontWeight={700} sx={{ mb: 2 }}>Totals</Typography>
              <Stack spacing={1}>
                <Stack direction="row" justifyContent="space-between">
                  <Typography color="text.secondary">Materials</Typography>
                  <Typography fontFamily="monospace">{fmt(materialsSaleAmt)}</Typography>
                </Stack>
                <Stack direction="row" justifyContent="space-between">
                  <Typography color="text.secondary">Making Charge</Typography>
                  <Typography fontFamily="monospace">{fmt(makingSaleAmount)}</Typography>
                </Stack>
                {applyOffer && offerSaving > 0 && (
                  <Stack direction="row" justifyContent="space-between">
                    <Typography color="success.main">Offer saving ({offer?.offer?.name})</Typography>
                    <Typography fontFamily="monospace" color="success.main">-{fmt(offerSaving)}</Typography>
                  </Stack>
                )}
                <Divider />
                <Stack direction="row" justifyContent="space-between">
                  <Typography fontWeight={700}>Total Estimate</Typography>
                  <Typography fontWeight={700} fontFamily="monospace">{fmt(totalSaleAmount)}</Typography>
                </Stack>
                <Stack direction="row" justifyContent="space-between">
                  <Typography color="text.secondary">GST (3%)</Typography>
                  <Typography fontFamily="monospace">{fmt(gstAmount)}</Typography>
                </Stack>
                <Divider />
                <Stack direction="row" justifyContent="space-between">
                  <Typography variant="h6" fontWeight={900} color="primary.main">Net Payable</Typography>
                  <Typography variant="h6" fontWeight={900} color="primary.main" fontFamily="monospace">
                    {fmt(netPayableAmount)}
                  </Typography>
                </Stack>
              </Stack>

              {!templatesQuery.isLoading && templates.length === 0 && (
                <Alert severity="info" sx={{ mt: 2, fontSize: 12 }}>
                  No print template yet — create one under Estimation → Estimate Templates.
                </Alert>
              )}
              {templates.length > 0 && (
                <SelectField label="Print Template" size="small" sx={{ mt: 2 }} value={templateId}
                  options={templates.map((t) => ({ value: t.id, label: `${t.name}${t.isDefault ? ' ★' : ''}` }))}
                  onChange={(e) => setTemplateId(e.target.value)} />
              )}
              <Button fullWidth variant="contained" color="secondary" startIcon={<Send />} sx={{ mt: 2 }}
                disabled={items.length === 0 || tag.status !== 'IN_STOCK'}
                title={tag.status !== 'IN_STOCK' ? 'Only a piece that is in stock can be sent to billing' : belowOfferNow ? 'Priced below the offer - a store manager has to approve it before it goes to billing' : 'Save this estimate and send it to the billing counter'}
                onClick={() => { setCustomer(EMPTY_CUSTOMER); setShowCustErrors(false); setSendTarget('new'); }}>
                {belowOfferNow ? 'Send for Approval' : 'Send to Billing'}
              </Button>
              <Stack direction="row" spacing={1} sx={{ mt: 1 }}>
                <Button fullWidth variant="outlined" startIcon={<Save />}
                  disabled={saveMutation.isPending || items.length === 0}
                  onClick={() => saveMutation.mutate()}>
                  {saveMutation.isPending ? 'Saving…' : 'Save'}
                </Button>
                <Button fullWidth variant="contained" startIcon={<Print />}
                  disabled={printMutation.isPending || items.length === 0 || !templateId}
                  onClick={() => printMutation.mutate()}>
                  {printMutation.isPending ? 'Printing…' : 'Print'}
                </Button>
              </Stack>
              {receiptAvailable && (
                <Button fullWidth variant="outlined" startIcon={<ReceiptLong />} sx={{ mt: 1 }}
                  disabled={receiptMutation.isPending || receiptBusy || items.length === 0 || !templateId || receiptStatusQuery.data?.online === false}
                  title={receiptStatusQuery.data?.online === false ? `Receipt printer: ${receiptStatusQuery.data.statusText}` : 'Save this estimate and print it on the receipt printer'}
                  onClick={() => receiptMutation.mutate()}>
                  {receiptMutation.isPending || receiptBusy ? 'Sending…' : 'Print to Receipt Printer'}
                </Button>
              )}
            </Card>

            <Card sx={{ p: 2 }}>
              <Typography variant="h6" fontWeight={700} sx={{ mb: 1 }}>Past Estimates</Typography>
              {pastEstimates.length === 0 && (
                <Typography variant="body2" color="text.secondary">No estimates saved yet for this tag.</Typography>
              )}
              <Stack spacing={1}>
                {pastEstimates.map((e) => (
                  <Box key={e.id} sx={{ p: 1.5, bgcolor: 'action.hover', borderRadius: 1 }}>
                    <Stack direction="row" justifyContent="space-between" alignItems="center" useFlexGap sx={{ flexWrap: 'wrap', gap: 0.5 }}>
                      <Stack direction="row" useFlexGap alignItems="center" sx={{ flexWrap: 'wrap', gap: 0.75 }}>
                        <Typography variant="body2" fontWeight={700} fontFamily="monospace">{e.estimateNumber}</Typography>
                        {e.offerName && <Chip size="small" label={`Offer: ${e.offerName}`} color="success" variant="outlined" sx={{ height: 18, fontSize: 10 }} />}
                        {e.expired && e.status !== 'INVOICED' && (
                          <Chip size="small" label="Expired - make a new estimate" color="default" variant="outlined" sx={{ height: 18, fontSize: 10 }} />
                        )}
                        {e.goldRateChanged && e.status !== 'INVOICED' && !e.expired && (
                          <Chip size="small" color="warning" variant="outlined" sx={{ height: 18, fontSize: 10 }}
                            label={`Gold rate updated: ₹${Number(e.goldRateAtEstimate).toLocaleString('en-IN')} -> ₹${Number(e.goldRateNow).toLocaleString('en-IN')}/g`} />
                        )}
                        {e.status && e.status !== 'OPEN' && (
                          <Chip size="small" label={e.status === 'SENT' ? 'At billing' : e.status === 'INVOICED' ? 'Billed' : e.status === 'AWAITING_APPROVAL' ? 'Awaiting approval' : e.status}
                            color={e.status === 'INVOICED' ? 'success' : e.status === 'AWAITING_APPROVAL' ? 'warning' : 'info'} variant="outlined" sx={{ height: 18, fontSize: 10 }} />
                        )}
                      </Stack>
                      <Stack direction="row" spacing={0.5} alignItems="center">
                        <Typography variant="body2" fontWeight={700}>{fmt(Number(e.netPayableAmount))}</Typography>
                        {(e.status === 'SENT' || e.status === 'AWAITING_APPROVAL') && (
                          <IconButton size="small" title="Recall from billing" disabled={recallMutation.isPending}
                            onClick={() => recallMutation.mutate(e.id)}>
                            <Undo fontSize="small" />
                          </IconButton>
                        )}
                        {e.status === 'OPEN' && !e.expired && (
                          <IconButton size="small" title="Send to billing" disabled={tag.status !== 'IN_STOCK'}
                            onClick={() => { setCustomer(customerFromEstimate(e)); setShowCustErrors(false); setSendTarget({ id: e.id, number: e.estimateNumber }); }}>
                            <Send fontSize="small" />
                          </IconButton>
                        )}
                        <IconButton size="small" disabled={!templateId} onClick={() => printSavedEstimate(e)}>
                          <Print fontSize="small" />
                        </IconButton>
                        {receiptAvailable && (
                          <IconButton size="small" title="Print on receipt printer" disabled={!templateId || receiptBusy} onClick={() => void sendToReceipt(e)}>
                            <ReceiptLong fontSize="small" />
                          </IconButton>
                        )}
                      </Stack>
                    </Stack>
                    <Typography variant="caption" color="text.secondary">
                      {new Date(e.createdAt).toLocaleString('en-IN')}
                    </Typography>
                  </Box>
                ))}
              </Stack>
            </Card>
          </Grid>
        </Grid>
      )}

      <Dialog open={!!sendTarget} onClose={() => setSendTarget(null)} maxWidth="sm" fullWidth>
        <form onSubmit={(ev) => {
          ev.preventDefault();
          if (Object.keys(custErrors).length > 0) { setShowCustErrors(true); return; }
          sendMutation.mutate();
        }}>
          <DialogTitle fontWeight={700}>
            {approvalMode ? 'Send for approval' : 'Send to billing'}
            <Typography variant="caption" display="block" color="text.secondary">
              {sendTarget === 'new' ? 'Saves this estimate and hands it to the billing counter' : `Hands ${(sendTarget as any)?.number ?? 'this estimate'} to the billing counter`}
              {' '}with the customer's details, so billing does not ask again.
            </Typography>
          </DialogTitle>
          <DialogContent sx={{ pt: 2 }}>
            <Grid container spacing={2} sx={{ mt: 0 }}>
              <Grid item xs={12} sm={7}>
                <TextField fullWidth size="small" autoFocus required label="Customer name" value={customer.name}
                  error={showCustErrors && !!custErrors.name} helperText={showCustErrors ? custErrors.name : undefined}
                  onChange={(e) => setCust({ name: e.target.value })} />
              </Grid>
              <Grid item xs={12} sm={5}>
                <TextField fullWidth size="small" required label="Mobile number" value={customer.phone}
                  inputProps={{ inputMode: 'tel', maxLength: 16 }}
                  error={showCustErrors && !!custErrors.phone} helperText={showCustErrors ? custErrors.phone : undefined}
                  onChange={(e) => setCust({ phone: e.target.value })} />
              </Grid>
              <Grid item xs={12} sm={5}>
                <TextField fullWidth size="small" type="date" label="Date of birth" value={customer.dob}
                  InputLabelProps={{ shrink: true }} inputProps={{ max: new Date().toISOString().slice(0, 10) }}
                  error={showCustErrors && !!custErrors.dob} helperText={showCustErrors ? custErrors.dob : undefined}
                  onChange={(e) => setCust({ dob: e.target.value })} />
              </Grid>
              <Grid item xs={12} sm={7}>
                <TextField fullWidth size="small" label="PAN card number" value={customer.pan}
                  inputProps={{ maxLength: 10, style: { textTransform: 'uppercase' } }}
                  error={showCustErrors && !!custErrors.pan}
                  helperText={showCustErrors && custErrors.pan ? custErrors.pan : 'Needed if the bill goes above ₹2,00,000'}
                  onChange={(e) => setCust({ pan: e.target.value })} />
              </Grid>
              <Grid item xs={12}>
                <TextField fullWidth size="small" multiline minRows={2} label="Address" value={customer.address}
                  onChange={(e) => setCust({ address: e.target.value })} />
              </Grid>
              <Grid item xs={12}>
                <SelectField size="small" required label="Sales employee (attending this customer)" value={customer.salesPersonId}
                  emptyLabel="Select…"
                  error={showCustErrors && !!custErrors.salesPersonId} helperText={showCustErrors ? custErrors.salesPersonId : undefined}
                  onChange={(e) => setCust({ salesPersonId: e.target.value })}
                  options={staffList.map((s) => ({ value: s.id, label: `${s.name}${s.employeeId ? ` (${s.employeeId})` : ''}` }))} />
              </Grid>
              {approvalMode && (
                <Grid item xs={12}>
                  <Alert severity="warning" sx={{ mb: 1 }}>
                    This estimate is priced below the offered rate, so it goes to a store manager first. Once approved it appears at the billing counter.
                  </Alert>
                  <TextField fullWidth size="small" required label="Why is the price lower? (the manager sees this)" value={approvalReason}
                    inputProps={{ maxLength: 500 }} error={showCustErrors && !approvalReason.trim()}
                    onChange={(e) => setApprovalReason(e.target.value)} />
                </Grid>
              )}
            </Grid>
          </DialogContent>
          <DialogActions sx={{ p: 2 }}>
            <Button onClick={() => setSendTarget(null)}>Cancel</Button>
            <Button type="submit" variant="contained" startIcon={<Send />} disabled={sendMutation.isPending || (approvalMode && !approvalReason.trim())}>
              {sendMutation.isPending ? 'Sending…' : approvalMode ? 'Send for approval' : 'Send'}
            </Button>
          </DialogActions>
        </form>
      </Dialog>

      {query.trim().length === 0 && (
        <Card><CardContent sx={{ textAlign: 'center', py: 6 }}>
          <QrCodeScanner sx={{ fontSize: 40, color: 'text.disabled', mb: 1 }} />
          <Typography color="text.secondary">Scan a barcode or start typing to find a piece to estimate.</Typography>
        </CardContent></Card>
      )}
    </Box>
  );
}
