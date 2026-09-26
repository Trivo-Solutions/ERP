import { useState, useEffect, Fragment } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Box, Card, Table, TableHead, TableBody, TableRow, TableCell, Typography, Button,
  Grid, Chip, Alert, Dialog, DialogTitle, DialogContent, DialogActions,
  TextField, MenuItem, IconButton, Stack, LinearProgress,
} from '@mui/material';
import { CheckCircle, Warning, Bolt, LocalOffer, Print } from '@mui/icons-material';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm, Controller, useFieldArray, useWatch } from 'react-hook-form';
import { useSnackbar } from 'notistack';
import { apiGet, apiPost, apiPatch } from '../../api/client';
import { PageHeader } from '../../components/common/PageHeader';
import { StatusChip } from '../../components/common/StatusChip';
import { useScaleReading } from '../../hooks/useSocket';
import { useUiStore } from '../../store/ui.store';
import { usePermissions } from '../../hooks/usePermissions';
import { SelectField } from '../../components/fields/SelectField';
import { NumberField } from '../../components/fields/NumberField';
import { printTsplViaAgent } from '../../utils/printAgent';

const FINISHED_GOODS = 'FINISHED_GOODS';
const FINISHED_LOT = 'FINISHED_LOT';

// How far along the tagging of a bag is — live from its tags. A few hundredths of a gram is scale noise, not "untagged".
const LOT_LEFT_TOLERANCE = 0.005;
function lotProgress(lot: any) {
  const net = Number(lot.netWeight ?? 0);
  const taggedNet = (lot.tags ?? []).reduce((s: number, t: any) => s + Number(t.netWeight ?? 0), 0);
  const tagged = (lot.tags ?? []).length;
  return { net, taggedNet, leftNet: net - taggedNet, tagged };
}

// Whether every finished piece received on a GRN has been tagged: nothing to tag (raw material only),
// still tagging (a bag with weight left, or a single piece with no tag yet), or done.
function taggingState(grn: any): 'NONE' | 'PENDING' | 'DONE' {
  const items: any[] = grn.grnItems ?? [];
  const lots = items.filter((i) => i.poItem?.materialType === FINISHED_LOT && i.purchaseLot);
  const pieces = items.filter((i) => i.poItem?.materialType === FINISHED_GOODS);
  if (lots.length === 0 && pieces.length === 0) return 'NONE';
  const pending = lots.some((i) => lotProgress(i.purchaseLot).leftNet > LOT_LEFT_TOLERANCE && i.purchaseLot.status === 'OPEN')
    || pieces.some((i) => !i.jewelryTag);
  return pending ? 'PENDING' : 'DONE';
}
const MAKE_TYPES = ['GOLD', 'DIAMOND', 'SILVER', 'PLATINUM', 'OTHER'];

// ─── GRN Create Dialog ────────────────────────────────────────────────────────

function CreateGRNDialog({ open, onClose, scaleWeight }: {
  open: boolean; onClose: () => void; scaleWeight: number | null;
}) {
  const { enqueueSnackbar } = useSnackbar();
  const qc = useQueryClient();

  const { control, handleSubmit, reset, watch, setValue } = useForm({
    defaultValues: {
      poId: '',
      branchId: '',
      receivedDate: new Date().toISOString().split('T')[0],
      invoiceNumber: '',
      notes: '',
      items: [] as Array<{
        poItemId: string; materialName: string; materialCode: string;
        poWeight: number; unit: string; materialType: string;
        invoiceQty: number; invoiceWeight: number; scaleWeight: number;
      }>,
    },
  });
  const { fields, replace } = useFieldArray({ control, name: 'items' });
  const watchedPoId = watch('poId');
  const watchedItems = useWatch({ control, name: 'items' });

  // Fetch POs available for GRN (CONFIRMED or APPROVED status)
  const { data: posData } = useQuery({
    queryKey: ['pos-for-grn'],
    queryFn: () => apiGet<any>('/procurement/orders', { limit: 100 }),
    enabled: open,
  });
  const allPos: any[] = (posData as any)?.pos ?? [];
  const availablePos = allPos.filter((p: any) =>
    ['CONFIRMED', 'APPROVED', 'PARTIAL'].includes(p.status)
  );

  const { data: branchData } = useQuery({
    queryKey: ['branches'], queryFn: () => apiGet<any>('/tagging/branches'), enabled: open,
  });
  const branchList: any[] = (branchData as any)?.data ?? branchData ?? [];
  const receivesFinishedGoods = (watchedItems ?? []).some((i) => i.materialType === FINISHED_GOODS || i.materialType === FINISHED_LOT);

  // Fetch PO detail when a PO is selected
  const { data: poDetail } = useQuery({
    queryKey: ['po-grn-detail', watchedPoId],
    queryFn: () => apiGet<any>(`/procurement/orders/${watchedPoId}`),
    enabled: !!watchedPoId,
  });

  // Populate items from PO line items
  useEffect(() => {
    if (!watchedPoId) { replace([]); return; }
    const po = (poDetail as any)?.data ?? (poDetail as any);
    if (po?.poItems) {
      replace(po.poItems.map((item: any) => ({
        poItemId: item.id,
        materialName: item.materialName,
        materialCode: item.materialCode,
        poWeight: Number(item.weight),
        unit: item.unit,
        materialType: item.materialType,
        invoiceQty: Number(item.quantity),
        invoiceWeight: Number(item.weight),
        scaleWeight: 0,
      })));
    }
  }, [poDetail, watchedPoId, replace]);

  const createMutation = useMutation({
    mutationFn: (data: any) => apiPost('/procurement/grn', {
      poId: data.poId,
      receivedDate: new Date(data.receivedDate),
      branchId: data.branchId || undefined,
      invoiceNumber: data.invoiceNumber,
      notes: data.notes,
      items: data.items.map((i: any) => ({
        poItemId: i.poItemId,
        invoiceQty: Number(i.invoiceQty),
        invoiceWeight: Number(i.invoiceWeight),
        scaleWeight: Number(i.scaleWeight),
      })),
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['grns'] });
      onClose();
      reset();
      enqueueSnackbar('GRN created', { variant: 'success' });
    },
    onError: (err: any) => enqueueSnackbar(err.response?.data?.error ?? 'Failed to create GRN', { variant: 'error' }),
  });

  const handleClose = () => { onClose(); reset(); };

  return (
    <Dialog open={open} onClose={handleClose} maxWidth="lg" fullWidth>
      <form onSubmit={handleSubmit((d) => createMutation.mutate(d))}>
        <DialogTitle fontWeight={700}>Create Goods Receipt Note</DialogTitle>
        <DialogContent sx={{ pt: 2 }}>
          <Grid container spacing={2} sx={{ mb: 2 }}>
            <Grid item xs={6}>
              <Controller name="poId" control={control} rules={{ required: true }}
                render={({ field, fieldState }) => (
                  <TextField {...field} select fullWidth label="Purchase Order" error={!!fieldState.error}>
                    <MenuItem value="">Select PO...</MenuItem>
                    {availablePos.map((p: any) => (
                      <MenuItem key={p.id} value={p.id}>{p.poNumber} — {p.supplier?.name}</MenuItem>
                    ))}
                  </TextField>
                )} />
            </Grid>
            <Grid item xs={3}>
              <Controller name="branchId" control={control} rules={{ required: receivesFinishedGoods }}
                render={({ field, fieldState }) => (
                  <SelectField {...field} label={receivesFinishedGoods ? 'Receiving Branch *' : 'Receiving Branch'}
                    emptyLabel="Select branch…" error={!!fieldState.error}
                    options={branchList.map((b: any) => ({ value: b.id, label: b.name }))} />
                )} />
            </Grid>
            <Grid item xs={3}>
              <Controller name="receivedDate" control={control}
                render={({ field }) => <TextField {...field} fullWidth label="Received Date" type="date" InputLabelProps={{ shrink: true }} />} />
            </Grid>
            <Grid item xs={3}>
              <Controller name="invoiceNumber" control={control}
                render={({ field }) => <TextField {...field} fullWidth label="Invoice #" />} />
            </Grid>
            <Grid item xs={3}>
              <Controller name="notes" control={control}
                render={({ field }) => <TextField {...field} fullWidth label="Notes" />} />
            </Grid>
          </Grid>

          {watchedPoId && fields.length === 0 && (
            <Alert severity="info">Loading PO line items...</Alert>
          )}

          {fields.length > 0 && (
            <>
              <Typography variant="subtitle2" fontWeight={700} gutterBottom>
                Item-wise Verification
              </Typography>
              <Box sx={{ overflowX: 'auto' }}>
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>Material</TableCell>
                    <TableCell align="right">PO Weight</TableCell>
                    <TableCell align="right" sx={{ minWidth: 100 }}>Invoice Qty</TableCell>
                    <TableCell align="right" sx={{ minWidth: 120 }}>Invoice Weight (g)</TableCell>
                    <TableCell align="right" sx={{ minWidth: 140 }}>Scale Weight (g)</TableCell>
                    <TableCell align="right">Variance %</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {fields.map((field, idx) => {
                    const inv = Number(watchedItems?.[idx]?.invoiceWeight ?? 0);
                    const scl = Number(watchedItems?.[idx]?.scaleWeight ?? 0);
                    const variancePct = inv > 0 ? ((scl - inv) / inv) * 100 : 0;
                    const hasDiscrepancy = Math.abs(variancePct) >= 0.5;

                    return (
                      <TableRow key={field.id} sx={hasDiscrepancy ? { bgcolor: 'error.50' } : {}}>
                        <TableCell>
                          <Typography variant="body2" fontWeight={600}>{field.materialName}</Typography>
                          <Typography variant="caption" color="text.secondary">{field.materialCode}</Typography>
                          {field.materialType === FINISHED_GOODS && (
                            <Chip size="small" color="primary" variant="outlined" label="Finished piece — tag it after receiving" sx={{ ml: 1 }} />
                          )}
                          {field.materialType === FINISHED_LOT && (
                            <Chip size="small" color="primary" variant="outlined" sx={{ ml: 1 }}
                              label="Bag — received whole; the bill is booked now, tag the pieces after" />
                          )}
                        </TableCell>
                        <TableCell align="right" sx={{ fontFamily: 'monospace', color: 'text.secondary' }}>
                          {field.poWeight.toFixed(3)} {field.unit}
                        </TableCell>
                        <TableCell align="right">
                          <Controller name={`items.${idx}.invoiceQty`} control={control}
                            render={({ field: f }) => (
                              <TextField {...f} size="small" type="number" disabled={field.materialType === FINISHED_LOT}
                                title={field.materialType === FINISHED_LOT ? 'A bag is received whole — one unit' : undefined}
                                inputProps={{ step: 0.001, min: 0, style: { textAlign: 'right', width: 80 } }} />
                            )} />
                        </TableCell>
                        <TableCell align="right">
                          <Controller name={`items.${idx}.invoiceWeight`} control={control}
                            render={({ field: f }) => (
                              <TextField {...f} size="small" type="number" inputProps={{ step: 0.001, min: 0, style: { textAlign: 'right', width: 100 } }} />
                            )} />
                        </TableCell>
                        <TableCell align="right">
                          <Stack direction="row" spacing={0.5} justifyContent="flex-end" alignItems="center">
                            <Controller name={`items.${idx}.scaleWeight`} control={control}
                              render={({ field: f }) => (
                                <TextField {...f} size="small" type="number" inputProps={{ step: 0.001, min: 0, style: { textAlign: 'right', width: 100 } }} />
                              )} />
                            {scaleWeight !== null && (
                              <IconButton size="small" color="primary" title="Use live scale weight"
                                onClick={() => setValue(`items.${idx}.scaleWeight`, scaleWeight)}>
                                <Bolt fontSize="small" />
                              </IconButton>
                            )}
                          </Stack>
                        </TableCell>
                        <TableCell align="right">
                          <Typography
                            variant="body2"
                            sx={{ fontFamily: 'monospace', fontWeight: 700, color: hasDiscrepancy ? 'error.main' : 'success.main' }}
                          >
                            {inv > 0 ? `${variancePct > 0 ? '+' : ''}${variancePct.toFixed(2)}%` : '—'}
                            {hasDiscrepancy && <Warning sx={{ fontSize: 14, ml: 0.5, verticalAlign: 'middle' }} />}
                          </Typography>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
              </Box>
            </>
          )}
        </DialogContent>
        <DialogActions sx={{ p: 2.5 }}>
          <Button onClick={handleClose}>Cancel</Button>
          <Button type="submit" variant="contained" disabled={createMutation.isPending || fields.length === 0}>
            Create GRN
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  );
}

// ─── Tag a received finished piece ────────────────────────────────────────────
//
// A FINISHED_GOODS GRN line is one bought-in, ready-to-sell piece. This turns it into a JewelryTag
// (status IN_STOCK, cost = the PO line price, linked back to the GRN item) via
// POST /tagging/tags/from-grn-item, then offers the label print — same agent path NewTagPage uses.

function TagFromGrnDialog({ grn, item, onClose }: { grn: any | null; item: any | null; onClose: () => void }) {
  const { enqueueSnackbar } = useSnackbar();
  const qc = useQueryClient();
  const open = !!grn && !!item;
  const [createdTag, setCreatedTag] = useState<any>(null);

  const { control, handleSubmit, reset, watch, setValue } = useForm({
    defaultValues: {
      name: '', makeType: 'GOLD', metalKarat: '', stockTypeId: '', categoryId: '', subCategoryId: '',
      collectionId: '', manufacturerId: '', grossWeight: 0, stoneWeight: 0, huid: '', sellingPrice: '' as string | number, notes: '',
    },
  });
  const categoryId = watch('categoryId');

  useEffect(() => {
    if (!item) return;
    setCreatedTag(null);
    reset({
      name: item.poItem?.materialName ?? '', makeType: 'GOLD', metalKarat: item.poItem?.karat ?? '',
      stockTypeId: '', categoryId: '', subCategoryId: '', collectionId: '', manufacturerId: '',
      grossWeight: Number(item.acceptedWeight ?? 0), stoneWeight: 0, huid: '', sellingPrice: '', notes: '',
    });
    // The PO's supplier is normally the manufacturer: pre-select the matching Client (found, or created once from
    // the supplier's details). Still a normal dropdown — change it if the maker is someone else.
    const supplierId = grn?.po?.supplierId;
    let cancelled = false;
    if (supplierId) {
      apiPost<any>('/tagging/manufacturers/from-supplier', { supplierId })
        .then((res) => {
          const m = res?.data ?? res;
          if (cancelled || !m?.id) return;
          qc.invalidateQueries({ queryKey: ['clients'] });
          setValue('manufacturerId', m.id);
        })
        .catch(() => { /* leave it blank — the field is optional */ });
    }
    return () => { cancelled = true; };
  }, [item, grn, reset, setValue, qc]);
  const { data: clients } = useQuery({ queryKey: ['clients'], queryFn: () => apiGet<any[]>('/orders/clients'), enabled: open });

  const { data: karats } = useQuery({ queryKey: ['master-karats'], queryFn: () => apiGet<any>('/masters/karats'), enabled: open });
  const { data: stockTypes } = useQuery({ queryKey: ['master-stock-types'], queryFn: () => apiGet<any>('/masters/stock-types'), enabled: open });
  const { data: categories } = useQuery({ queryKey: ['master-categories'], queryFn: () => apiGet<any>('/masters/categories'), enabled: open });
  const { data: collections } = useQuery({ queryKey: ['master-collections'], queryFn: () => apiGet<any>('/masters/collections'), enabled: open });
  const { data: subcats } = useQuery({
    queryKey: ['master-subcategories', categoryId],
    queryFn: () => apiGet<any>('/masters/subcategories', { categoryId }),
    enabled: open && !!categoryId,
  });
  const list = (x: any): any[] => x?.data ?? x ?? [];

  const mutation = useMutation({
    mutationFn: (d: any) => apiPost<any>('/tagging/tags/from-grn-item', {
      grnItemId: item.id,
      name: d.name, makeType: d.makeType, metalType: d.makeType,
      metalKarat: d.metalKarat || undefined,
      stockTypeId: d.stockTypeId, categoryId: d.categoryId,
      subCategoryId: d.subCategoryId || undefined, collectionId: d.collectionId || undefined,
      manufacturerId: d.manufacturerId || undefined,
      grossWeight: Number(d.grossWeight), stoneWeight: Number(d.stoneWeight) || 0,
      huid: d.huid || undefined,
      // Blank = let the server suggest from the metal rate on the GRN date.
      sellingPrice: d.sellingPrice === '' ? undefined : Number(d.sellingPrice),
      notes: d.notes || undefined,
    }),
    onSuccess: (tag) => {
      qc.invalidateQueries({ queryKey: ['grns'] });
      qc.invalidateQueries({ queryKey: ['tags'] });
      setCreatedTag(tag);
      enqueueSnackbar(`Tag ${tag.tagNumber} created`, { variant: 'success' });
    },
    onError: (e: any) => enqueueSnackbar(e.response?.data?.error ?? 'Failed to create tag', { variant: 'error' }),
  });

  const printMutation = useMutation({
    mutationFn: async () => {
      const { tspl } = await apiGet<{ tspl: string }>(`/tagging/tags/${createdTag.id}/print`);
      await printTsplViaAgent(tspl);
    },
    onSuccess: () => enqueueSnackbar('Label sent to printer', { variant: 'success' }),
    onError: (e: any) => enqueueSnackbar(e.message ?? 'Print failed', { variant: 'error' }),
  });

  const close = () => { setCreatedTag(null); onClose(); };

  return (
    <Dialog open={open} onClose={close} maxWidth="md" fullWidth>
      {createdTag ? (
        <>
          <DialogTitle fontWeight={700}>Tag created</DialogTitle>
          <DialogContent>
            <Alert severity="success" sx={{ mb: 2 }}>
              <Typography fontWeight={700} sx={{ fontFamily: 'monospace' }}>{createdTag.tagNumber}</Typography>
              {createdTag.name} is now IN_STOCK at {createdTag.branch?.name ?? 'the receiving branch'}.
            </Alert>
            <Typography variant="body2" color="text.secondary">
              Cost ₹{Number(createdTag.costPrice).toLocaleString('en-IN')} (from the PO line) · Selling price ₹{Number(createdTag.sellingPrice).toLocaleString('en-IN')}.
              Edit the tag from Jewelry Tagging to change the selling price or add a materials breakdown.
            </Typography>
          </DialogContent>
          <DialogActions sx={{ p: 2.5 }}>
            <Button onClick={close}>Close</Button>
            <Button variant="contained" startIcon={<Print />} disabled={printMutation.isPending}
              onClick={() => printMutation.mutate()}>
              Print label
            </Button>
          </DialogActions>
        </>
      ) : (
        <form onSubmit={handleSubmit((d) => mutation.mutate(d))}>
          <DialogTitle fontWeight={700}>
            Tag received piece — {item?.poItem?.materialName}
            <Typography variant="caption" display="block" color="text.secondary">
              GRN {grn?.grnNumber} · cost ₹{Number(item?.poItem?.totalAmount ?? 0).toLocaleString('en-IN')} · scale weight {Number(item?.acceptedWeight ?? 0).toFixed(3)} g
            </Typography>
          </DialogTitle>
          <DialogContent sx={{ pt: 2 }}>
            <Grid container spacing={2} sx={{ mt: 0 }}>
              <Grid item xs={12} sm={6}>
                <Controller name="name" control={control} rules={{ required: true }}
                  render={({ field, fieldState }) => <TextField {...field} fullWidth autoFocus label="Item name *" error={!!fieldState.error} />} />
              </Grid>
              <Grid item xs={6} sm={3}>
                <Controller name="makeType" control={control}
                  render={({ field }) => <SelectField {...field} label="Make" options={MAKE_TYPES.map((t) => ({ value: t, label: t }))} />} />
              </Grid>
              <Grid item xs={6} sm={3}>
                <Controller name="metalKarat" control={control}
                  render={({ field }) => (
                    <SelectField {...field} label="Karat / purity" emptyLabel="—"
                      options={list(karats).map((k: any) => ({ value: k.code, label: k.code }))} />
                  )} />
              </Grid>
              <Grid item xs={6} sm={3}>
                <Controller name="stockTypeId" control={control} rules={{ required: true }}
                  render={({ field, fieldState }) => (
                    <SelectField {...field} label="Stock type *" emptyLabel="Select…" error={!!fieldState.error}
                      options={list(stockTypes).map((t: any) => ({ value: t.id, label: t.name }))} />
                  )} />
              </Grid>
              <Grid item xs={6} sm={3}>
                <Controller name="categoryId" control={control} rules={{ required: true }}
                  render={({ field, fieldState }) => (
                    <SelectField {...field} label="Category *" emptyLabel="Select…" error={!!fieldState.error}
                      options={list(categories).map((c: any) => ({ value: c.id, label: c.name }))} />
                  )} />
              </Grid>
              <Grid item xs={6} sm={3}>
                <Controller name="subCategoryId" control={control}
                  render={({ field }) => (
                    <SelectField {...field} label="Sub-category" emptyLabel="—" disabled={!categoryId}
                      options={list(subcats).map((c: any) => ({ value: c.id, label: c.name }))} />
                  )} />
              </Grid>
              <Grid item xs={6} sm={3}>
                <Controller name="collectionId" control={control}
                  render={({ field }) => (
                    <SelectField {...field} label="Collection" emptyLabel="—"
                      options={list(collections).map((c: any) => ({ value: c.id, label: c.name }))} />
                  )} />
              </Grid>
              <Grid item xs={12} sm={6}>
                <Controller name="manufacturerId" control={control}
                  render={({ field }) => (
                    <SelectField {...field} label="Manufacturer" emptyLabel="—"
                      helperText="Pre-selected from the PO's supplier"
                      options={list(clients).filter((c: any) => c.type === 'MANUFACTURER').map((c: any) => ({ value: c.id, label: c.name }))} />
                  )} />
              </Grid>
              <Grid item xs={4} sm={3}>
                <Controller name="grossWeight" control={control} rules={{ required: true, min: 0.0001 }}
                  render={({ field, fieldState }) => <NumberField {...field} label="Gross wt (g) *" error={!!fieldState.error} inputProps={{ step: 0.001, min: 0 }} />} />
              </Grid>
              <Grid item xs={4} sm={3}>
                <Controller name="stoneWeight" control={control}
                  render={({ field }) => <NumberField {...field} label="Stone wt (g)" inputProps={{ step: 0.001, min: 0 }} />} />
              </Grid>
              <Grid item xs={4} sm={3}>
                <Controller name="huid" control={control}
                  render={({ field }) => <TextField {...field} fullWidth label="HUID" />} />
              </Grid>
              <Grid item xs={12} sm={3}>
                <Controller name="sellingPrice" control={control}
                  render={({ field }) => <NumberField {...field} label="Selling price (₹)" helperText="Blank = suggest from the metal rate" inputProps={{ step: 0.01, min: 0 }} />} />
              </Grid>
              <Grid item xs={12}>
                <Controller name="notes" control={control}
                  render={({ field }) => <TextField {...field} fullWidth label="Notes" />} />
              </Grid>
            </Grid>
          </DialogContent>
          <DialogActions sx={{ p: 2.5 }}>
            <Button onClick={close}>Cancel</Button>
            <Button type="submit" variant="contained" startIcon={<LocalOffer />} disabled={mutation.isPending}>
              Create tag
            </Button>
          </DialogActions>
        </form>
      )}
    </Dialog>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export function GrnVerification() {
  const { enqueueSnackbar } = useSnackbar();
  const qc = useQueryClient();
  const { scaleDevice } = useUiStore();
  const [scaleWeight, setScaleWeight] = useState<number | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [tagTarget, setTagTarget] = useState<{ grn: any; item: any } | null>(null);
  const { hasPermission } = usePermissions();
  const canTag = hasPermission('tag:create');
  const navigate = useNavigate();

  useScaleReading(scaleDevice, (w) => setScaleWeight(w));

  const { data: grns, isLoading } = useQuery({
    queryKey: ['grns'],
    queryFn: () => apiGet<any[]>('/procurement/grn'),
  });

  const verifyMutation = useMutation({
    mutationFn: (grnId: string) => apiPatch(`/procurement/grn/${grnId}/verify`, {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['grns'] });
      enqueueSnackbar('GRN approved', { variant: 'success' });
    },
    onError: (e: any) => enqueueSnackbar(e.response?.data?.error ?? 'Failed', { variant: 'error' }),
  });

  return (
    <Box>
      <PageHeader
        title="GRN Verification"
        actions={[{ label: 'Create GRN', onClick: () => setCreateOpen(true) }]}
      />

      {scaleWeight !== null && (
        <Alert severity="info" sx={{ mb: 2 }}>
          Live Scale: <strong>{scaleWeight.toFixed(3)} g</strong> — click <Bolt sx={{ fontSize: 14, verticalAlign: 'middle' }} /> on any item to use this reading.
        </Alert>
      )}

      <Card>
        <Box sx={{ overflowX: 'auto' }}>
        <Table size="small" sx={{ '& .MuiTableCell-root': { whiteSpace: 'nowrap' } }}>
          <TableHead>
            <TableRow>
              <TableCell>GRN #</TableCell>
              <TableCell>PO Ref</TableCell>
              <TableCell>Supplier</TableCell>
              <TableCell>Branch</TableCell>
              <TableCell>Received</TableCell>
              <TableCell>Invoice #</TableCell>
              <TableCell>Status</TableCell>
              <TableCell align="right">Actions</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {isLoading ? (
              <TableRow><TableCell colSpan={8} align="center" sx={{ py: 4 }}>Loading...</TableCell></TableRow>
            ) : ((grns as any)?.data ?? grns ?? []).map((grn: any) => {
              const lots = (grn.grnItems ?? []).filter((i: any) => i.poItem?.materialType === FINISHED_LOT && i.purchaseLot);
              const pieces = (grn.grnItems ?? []).filter((i: any) => i.poItem?.materialType === FINISHED_GOODS);
              const hasFinished = lots.length + pieces.length > 0;
              const tagging = taggingState(grn);
              return (
              <Fragment key={grn.id}>
              <TableRow hover sx={hasFinished ? { '& > .MuiTableCell-root': { borderBottom: 'none' } } : undefined}>
                <TableCell sx={{ fontFamily: 'monospace', fontWeight: 700, color: '#44C47A' }}>{grn.grnNumber}</TableCell>
                <TableCell sx={{ fontFamily: 'monospace', fontSize: 12 }}>{grn.po?.poNumber}</TableCell>
                <TableCell sx={{ fontWeight: 600 }}>{grn.po?.supplier?.name}</TableCell>
                <TableCell>{grn.branch?.name ?? '—'}</TableCell>
                <TableCell>{new Date(grn.receivedDate).toLocaleDateString('en-IN')}</TableCell>
                <TableCell sx={{ fontFamily: 'monospace', fontSize: 12 }}>{grn.invoiceNumber ?? '—'}</TableCell>
                <TableCell>
                  <Stack direction="row" spacing={0.75} alignItems="center">
                    <StatusChip status={grn.status} />
                    {grn.status === 'DISCREPANCY' && <Warning sx={{ fontSize: 16, color: 'error.main' }} />}
                    {tagging !== 'NONE' && (
                      <Chip size="small" variant="outlined" color={tagging === 'PENDING' ? 'warning' : 'success'}
                        label={tagging === 'PENDING' ? 'Tagging incomplete' : 'Tagging complete'} />
                    )}
                  </Stack>
                </TableCell>
                <TableCell align="right">
                  {grn.status === 'VERIFIED' && (
                    <Button size="small" variant="contained" color="success" startIcon={<CheckCircle />}
                      disabled={verifyMutation.isPending}
                      onClick={() => verifyMutation.mutate(grn.id)}>
                      Approve
                    </Button>
                  )}
                </TableCell>
              </TableRow>
              {hasFinished && (
                <TableRow>
                  <TableCell colSpan={8} sx={{ pt: 0, pb: 2, pl: 4 }}>
                    <Box sx={{ borderLeft: 3, borderColor: 'divider', pl: 2, display: 'grid', gap: 1.25 }}>
                      {lots.map((i: any) => {
                        const pr = lotProgress(i.purchaseLot);
                        const left = pr.leftNet > LOT_LEFT_TOLERANCE;
                        const open = i.purchaseLot.status === 'OPEN';
                        return (
                          <Box key={i.id} sx={{ display: 'grid', gridTemplateColumns: 'minmax(170px, 1fr) minmax(280px, 2fr) 130px', alignItems: 'center', columnGap: 3 }}>
                            <Box>
                              <Typography variant="body2" fontWeight={600}>{i.poItem.materialName}</Typography>
                              <Typography variant="caption" color="text.secondary">
                                Bag{i.purchaseLot.pieces != null ? ` of ${i.purchaseLot.pieces} pcs` : ''}
                              </Typography>
                            </Box>
                            <Box>
                              <LinearProgress variant="determinate" color={left ? 'warning' : 'success'}
                                value={pr.net > 0 ? Math.min(100, (pr.taggedNet / pr.net) * 100) : 0}
                                sx={{ height: 6, borderRadius: 3, mb: 0.5 }} />
                              <Typography variant="caption" sx={{ fontFamily: 'monospace' }} color={left ? 'warning.main' : 'text.secondary'}>
                                {pr.tagged} tagged · {pr.taggedNet.toFixed(3)} of {pr.net.toFixed(3)} g net{left ? ` · ${pr.leftNet.toFixed(3)} g left` : ''}
                              </Typography>
                            </Box>
                            <Button size="small" variant="outlined" startIcon={<LocalOffer />} sx={{ justifySelf: 'end' }}
                              disabled={!canTag || !open}
                              title={canTag ? 'Tag the pieces of this lot one by one' : 'Needs the tag:create permission'}
                              onClick={() => navigate(`/tagging/tags/new?lotId=${i.purchaseLot.id}`)}>
                              {open ? 'Tag pieces' : 'Closed'}
                            </Button>
                          </Box>
                        );
                      })}
                      {pieces.map((i: any) => (
                        <Box key={i.id} sx={{ display: 'grid', gridTemplateColumns: 'minmax(170px, 1fr) minmax(280px, 2fr) 130px', alignItems: 'center', columnGap: 3 }}>
                          <Box>
                            <Typography variant="body2" fontWeight={600}>{i.poItem.materialName}</Typography>
                            <Typography variant="caption" color="text.secondary">Single piece</Typography>
                          </Box>
                          <Box>
                            {i.jewelryTag
                              ? <Chip size="small" color="success" label={`Tagged · ${i.jewelryTag.tagNumber}`} sx={{ fontFamily: 'monospace' }} />
                              : <Chip size="small" variant="outlined" color="warning" label="Not tagged yet" />}
                          </Box>
                          {i.jewelryTag ? <span /> : (
                            <Button size="small" variant="outlined" startIcon={<LocalOffer />} sx={{ justifySelf: 'end' }}
                              disabled={!canTag}
                              title={canTag ? 'Create the sellable tag for this piece' : 'Needs the tag:create permission'}
                              onClick={() => setTagTarget({ grn, item: i })}>
                              Tag
                            </Button>
                          )}
                        </Box>
                      ))}
                    </Box>
                  </TableCell>
                </TableRow>
              )}
              </Fragment>
              );
            })}
          </TableBody>
        </Table>
        </Box>
      </Card>

      <TagFromGrnDialog grn={tagTarget?.grn ?? null} item={tagTarget?.item ?? null} onClose={() => setTagTarget(null)} />
      <CreateGRNDialog open={createOpen} onClose={() => setCreateOpen(false)} scaleWeight={scaleWeight} />
    </Box>
  );
}
