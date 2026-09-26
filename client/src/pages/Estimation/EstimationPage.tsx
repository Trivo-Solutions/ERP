import { useEffect, useRef, useState } from 'react';
import {
  Box, Card, CardContent, Grid, Typography, Button, Stack, Divider, Table, TableHead,
  TableBody, TableRow, TableCell, CircularProgress, Chip, TextField, InputAdornment, IconButton,
  Alert, Dialog, DialogTitle, DialogContent, DialogActions,
} from '@mui/material';
import { Edit, Save, Close, QrCodeScanner, Print, Send } from '@mui/icons-material';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useSnackbar } from 'notistack';
import { apiGet, apiPost } from '../../api/client';
import { PageHeader } from '../../components/common/PageHeader';
import { StatusChip } from '../../components/common/StatusChip';
import { NumberField } from '../../components/fields/NumberField';
import { SelectField } from '../../components/fields/SelectField';
import { findMakingCharge, computeLineAmount, computeMakingAmount } from '../../utils/estimateCalc';
import { printTagEstimate } from '../../utils/printTagEstimate';

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
  const { enqueueSnackbar } = useSnackbar();
  const qc = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);

  const [query, setQuery] = useState('');
  const [selectedTagId, setSelectedTagId] = useState('');
  const [editing, setEditing] = useState(false);
  const [lines, setLines] = useState<EditableLine[]>([]);
  const [saleMcRate, setSaleMcRate] = useState(0);
  const [saleVaPercent, setSaleVaPercent] = useState(0);
  const [notes, setNotes] = useState('');

  // Hand-off to the billing counter. `sendTarget`: an already-saved estimate to send, or 'new' to save the
  // current work-up and send that in one go.
  const [sendTarget, setSendTarget] = useState<{ id: string; number: string } | 'new' | null>(null);
  const [customerName, setCustomerName] = useState('');
  const [customerPhone, setCustomerPhone] = useState('');

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
    setLines((tag.materials ?? []).map((m: any) => ({
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
    } else {
      const charge = findMakingCharge(makingCharges, tag.metalKarat, tag.categoryId, tag.makeType);
      setSaleMcRate(charge ? Number(charge.makingCharge) : 0);
      setSaleVaPercent(charge ? Number(charge.saleWastagePercent) : 0);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tag, makingCharges.length]);

  const items = lines.map((l) => ({ ...l, saleAmount: computeLineAmount(l.weight, l.saleRate) }));
  const metalWeight = items.filter((i) => i.materialType === 'METAL').reduce((s, i) => s + i.weight, 0);
  const metalSaleAmt = items.filter((i) => i.materialType === 'METAL').reduce((s, i) => s + i.saleAmount, 0);
  const materialsSaleAmt = items.reduce((s, i) => s + i.saleAmount, 0);
  const makingSaleAmount = computeMakingAmount(metalWeight, metalSaleAmt, saleMcRate, saleVaPercent);
  const totalSaleAmount = materialsSaleAmt + makingSaleAmount;
  // Indicative GST only — same flat 3% (INR) convention as NewSalePage.tsx / the server default;
  // the saved TagEstimate snapshots its own taxRate/gstAmount at save time (see estimation.service.ts),
  // this is just the live preview shown before that save happens.
  const gstAmount = Math.round(totalSaleAmount * 0.03 * 100) / 100;
  const netPayableAmount = totalSaleAmount + gstAmount;

  const updateLine = (idx: number, patch: Partial<EditableLine>) => {
    setLines((ls) => ls.map((l, i) => (i === idx ? { ...l, ...patch } : l)));
  };

  // Deliberately not gated on `editing` — a tag whose materials/MC/VA already reflect its real
  // price (auto-filled from the tag + MakingCharge master on load) is a perfectly valid estimate
  // to save or print as-is; "Edit" is only for when the customer needs a different number.
  const buildEstimatePayload = () => ({
    items: lines.map((l) => ({ code: l.code, materialType: l.materialType, name: l.name, weight: l.weight, unit: l.unit, saleRate: l.saleRate })),
    saleMcRate, saleVaPercent,
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
    mutationFn: () => sendTarget === 'new'
      ? apiPost<any>(`/estimation/tags/${selectedTagId}/estimates`, {
          ...buildEstimatePayload(), sendToBilling: true, customerName: customerName.trim() || undefined, customerPhone: customerPhone.trim() || undefined,
        })
      : apiPost<any>(`/estimation/estimates/${(sendTarget as { id: string }).id}/send-to-billing`, {
          customerName: customerName.trim() || undefined, customerPhone: customerPhone.trim() || undefined,
        }),
    onSuccess: (saved) => {
      enqueueSnackbar(`Estimate ${saved.estimateNumber} sent to billing`, { variant: 'success' });
      qc.invalidateQueries({ queryKey: ['estimation-past', selectedTagId] });
      setSendTarget(null); setCustomerName(''); setCustomerPhone(''); setEditing(false);
    },
    onError: (e: any) => enqueueSnackbar(e.response?.data?.error ?? 'Failed to send to billing', { variant: 'error' }),
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

      {tag && !tagQuery.isLoading && (
        <Grid container spacing={2}>
          <Grid item xs={12} md={8}>
            <Card sx={{ p: 2, mb: 2 }}>
              <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 1 }}>
                <Box>
                  <Typography variant="h6" fontWeight={900} sx={{ fontFamily: 'monospace', color: '#44C47A' }}>
                    {tag.tagNumber}
                  </Typography>
                  <Typography variant="body2" color="text.secondary">{tag.name} — {tag.branch?.name}</Typography>
                </Box>
                <Stack direction="row" spacing={1} alignItems="center">
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
              <Table size="small">
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
                      <TableCell align="right">{l.weight.toFixed(4)}</TableCell>
                      <TableCell>{l.unit}</TableCell>
                      <TableCell align="right">
                        {editing ? (
                          <NumberField size="small" value={l.saleRate}
                            onChange={(e) => updateLine(idx, { saleRate: Number(e.target.value) })} />
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
            </Card>

            <Card sx={{ p: 2 }}>
              <Typography variant="h6" fontWeight={700} sx={{ mb: 2 }}>Making Charge & Value Addition</Typography>
              <Grid container spacing={2}>
                <Grid item xs={6} sm={4}>
                  <NumberField label="MC Rate (₹/g)" size="small" disabled={!editing} value={saleMcRate}
                    onChange={(e) => setSaleMcRate(Number(e.target.value))} />
                </Grid>
                <Grid item xs={6} sm={4}>
                  <NumberField label="VA %" size="small" disabled={!editing} value={saleVaPercent}
                    onChange={(e) => setSaleVaPercent(Number(e.target.value))} />
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
            <Card sx={{ p: 2, mb: 2, position: 'sticky', top: 16 }}>
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
                title={tag.status !== 'IN_STOCK' ? 'Only a piece that is in stock can be sent to billing' : 'Save this estimate and send it to the billing counter'}
                onClick={() => setSendTarget('new')}>
                Send to Billing
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
            </Card>

            <Card sx={{ p: 2 }}>
              <Typography variant="h6" fontWeight={700} sx={{ mb: 1 }}>Past Estimates</Typography>
              {pastEstimates.length === 0 && (
                <Typography variant="body2" color="text.secondary">No estimates saved yet for this tag.</Typography>
              )}
              <Stack spacing={1}>
                {pastEstimates.map((e) => (
                  <Box key={e.id} sx={{ p: 1.5, bgcolor: 'action.hover', borderRadius: 1 }}>
                    <Stack direction="row" justifyContent="space-between" alignItems="center">
                      <Stack direction="row" spacing={0.75} alignItems="center">
                        <Typography variant="body2" fontWeight={700} fontFamily="monospace">{e.estimateNumber}</Typography>
                        {e.status && e.status !== 'OPEN' && (
                          <Chip size="small" label={e.status === 'SENT' ? 'At billing' : e.status === 'INVOICED' ? 'Billed' : e.status}
                            color={e.status === 'INVOICED' ? 'success' : 'info'} variant="outlined" sx={{ height: 18, fontSize: 10 }} />
                        )}
                      </Stack>
                      <Stack direction="row" spacing={0.5} alignItems="center">
                        <Typography variant="body2" fontWeight={700}>{fmt(Number(e.netPayableAmount))}</Typography>
                        {e.status === 'OPEN' && (
                          <IconButton size="small" title="Send to billing" disabled={tag.status !== 'IN_STOCK'}
                            onClick={() => { setCustomerName(e.customerName ?? ''); setCustomerPhone(e.customerPhone ?? ''); setSendTarget({ id: e.id, number: e.estimateNumber }); }}>
                            <Send fontSize="small" />
                          </IconButton>
                        )}
                        <IconButton size="small" disabled={!templateId} onClick={() => printSavedEstimate(e)}>
                          <Print fontSize="small" />
                        </IconButton>
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

      <Dialog open={!!sendTarget} onClose={() => setSendTarget(null)} maxWidth="xs" fullWidth>
        <DialogTitle fontWeight={700}>
          Send to billing
          <Typography variant="caption" display="block" color="text.secondary">
            {sendTarget === 'new' ? 'Saves this estimate and hands it to the billing counter.' : `Hands ${(sendTarget as any)?.number ?? 'this estimate'} to the billing counter.`}
          </Typography>
        </DialogTitle>
        <DialogContent sx={{ pt: 2 }}>
          <Stack spacing={2} sx={{ mt: 0.5 }}>
            <TextField fullWidth size="small" autoFocus label="Customer name (optional)" value={customerName}
              helperText="So billing can find it by name"
              onChange={(e) => setCustomerName(e.target.value)} />
            <TextField fullWidth size="small" label="Customer phone (optional)" value={customerPhone}
              onChange={(e) => setCustomerPhone(e.target.value)} />
          </Stack>
        </DialogContent>
        <DialogActions sx={{ p: 2 }}>
          <Button onClick={() => setSendTarget(null)}>Cancel</Button>
          <Button variant="contained" startIcon={<Send />} disabled={sendMutation.isPending} onClick={() => sendMutation.mutate()}>
            {sendMutation.isPending ? 'Sending…' : 'Send'}
          </Button>
        </DialogActions>
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
