import { useEffect, useRef, useState } from 'react';
import { usePageShortcuts, focusFirstField } from '../../hooks/usePageShortcuts';
import { useAuthStore } from '../../store/auth.store';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  Box, Card, Grid, TextField, Typography, Button, Stack,
  Divider, Alert, Tabs, Tab, Table, TableHead, TableBody, TableRow,
  TableCell, IconButton, Checkbox, FormControlLabel, Chip,
  Dialog, DialogTitle, DialogContent, DialogActions, CircularProgress,
} from '@mui/material';
import {
  ArrowBack, Print, LocalPrintshop, AddCircleOutline, CheckCircle, Add, Delete,
  AddPhotoAlternate, Close,
} from '@mui/icons-material';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm, Controller, useFieldArray, useWatch } from 'react-hook-form';
import { useSnackbar } from 'notistack';
import { apiGet, apiPost, apiPatch } from '../../api/client';
import { PageHeader } from '../../components/common/PageHeader';
import { stoneGradeCode } from '../../utils/stoneGrade';
import { findMakingCharge, computeLineAmount, computeMakingAmount } from '../../utils/estimateCalc';
import { getPrintAgentStatus, printTsplViaAgent } from '../../utils/printAgent';
import { printAgentSnackbarAction } from '../../utils/printAgentSnackbarAction';

const MAKE_TYPES  = ['GOLD', 'DIAMOND', 'SILVER', 'PLATINUM', 'OTHER'];

function fmtINR(n: number | string) {
  return '₹' + Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });
}

// ─── Tag Label (print preview) ────────────────────────────────────────────────

function TagLabel({ tag }: { tag: any }) {
  return (
    <Box sx={{
      width: 340, border: '2px solid #1B3280', borderRadius: 2, p: 2,
      fontFamily: 'monospace', bgcolor: '#fff', flexShrink: 0,
    }}>
      <Box sx={{ textAlign: 'center', mb: 1 }}>
        <Typography sx={{ fontSize: 9, letterSpacing: 2, color: '#888', textTransform: 'uppercase' }}>Jewelry Tag</Typography>
        <Typography sx={{ fontSize: 22, fontWeight: 900, letterSpacing: 3, color: '#1B3280', lineHeight: 1 }}>
          {tag.tagNumber ?? 'TAG-YYYY-XXXXXX'}
        </Typography>
        <Box sx={{ height: 32, background: 'repeating-linear-gradient(90deg,#000 0,#000 2px,transparent 2px,transparent 4px)', my: 0.5, mx: 2, opacity: 0.7 }} />
        <Typography sx={{ fontSize: 9, letterSpacing: 1, color: '#444' }}>{tag.tagNumber ?? ''}</Typography>
      </Box>
      <Divider sx={{ my: 1 }} />
      {/* Read from the saved category / sub-category (the saved ids resolved server-side), never from free text. */}
      <Typography sx={{ fontWeight: 700, fontSize: 13, mb: 0.5 }} noWrap>
        {[tag.category?.name, tag.subCategory?.name].filter(Boolean).join(' › ') || tag.name || 'Item'}
        {tag.subCategory?.code ? ` (${tag.subCategory.code})` : ''}
      </Typography>
      <Grid container spacing={0.5}>
        <Grid item xs={6}><Typography variant="caption" color="text.secondary">Make</Typography>
          <Typography sx={{ fontSize: 12, fontWeight: 600 }}>{tag.makeType || '—'}</Typography></Grid>
        <Grid item xs={6}><Typography variant="caption" color="text.secondary">Karat</Typography>
          <Typography sx={{ fontSize: 12, fontWeight: 600 }}>{tag.metalKarat || '—'}</Typography></Grid>
        <Grid item xs={4}><Typography variant="caption" color="text.secondary">Gross Wt</Typography>
          <Typography sx={{ fontSize: 12, fontWeight: 600 }}>{Number(tag.grossWeight || 0).toFixed(3)} g</Typography></Grid>
        <Grid item xs={4}><Typography variant="caption" color="text.secondary">Net Wt</Typography>
          <Typography sx={{ fontSize: 12, fontWeight: 600 }}>{Number(tag.netWeight || 0).toFixed(3)} g</Typography></Grid>
        <Grid item xs={4}><Typography variant="caption" color="text.secondary">Stone Wt</Typography>
          <Typography sx={{ fontSize: 12, fontWeight: 600 }}>{Number(tag.stoneWeight || 0).toFixed(3)} ct</Typography></Grid>
        {tag.huid && <Grid item xs={12}><Typography variant="caption" color="text.secondary">HUID</Typography>
          <Typography sx={{ fontSize: 11, letterSpacing: 1 }}>{tag.huid}</Typography></Grid>}
      </Grid>
      <Divider sx={{ my: 1 }} />
      <Stack direction="row" justifyContent="space-between" alignItems="center">
        <Box>
          <Typography variant="caption" color="text.secondary">MRP</Typography>
          <Typography sx={{ fontSize: 16, fontWeight: 900, color: '#1B3280' }}>{fmtINR(tag.sellingPrice || 0)}</Typography>
        </Box>
        <Typography sx={{ fontSize: 9, color: '#aaa' }}>{new Date().toLocaleDateString('en-IN')}</Typography>
      </Stack>
    </Box>
  );
}

// ─── Item Photo (replaces the old live-preview panel) ─────────────────────────
// Local file picker + preview only for now — no upload endpoint exists yet, this just holds the
// space so the real upload wiring can drop in later without another layout change.

function TagImageUpload({ file, onChange }: { file: File | null; onChange: (f: File | null) => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!file) { setPreviewUrl(null); return; }
    const url = URL.createObjectURL(file);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  function handleFiles(files: FileList | null) {
    const f = files?.[0];
    if (f && f.type.startsWith('image/')) onChange(f);
  }

  return (
    <Box
      onClick={() => !previewUrl && inputRef.current?.click()}
      onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => { e.preventDefault(); setDragOver(false); handleFiles(e.dataTransfer.files); }}
      sx={{
        width: 340, height: 340, borderRadius: 2, flexShrink: 0, position: 'relative', overflow: 'hidden',
        border: '2px dashed', borderColor: dragOver ? 'primary.main' : 'divider',
        bgcolor: dragOver ? 'action.hover' : 'background.paper',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        cursor: previewUrl ? 'default' : 'pointer',
      }}
    >
      <input ref={inputRef} type="file" accept="image/*" hidden onChange={(e) => handleFiles(e.target.files)} />
      {previewUrl ? (
        <>
          <Box component="img" src={previewUrl} alt="Item" sx={{ width: '100%', height: '100%', objectFit: 'cover' }} />
          <IconButton size="small" onClick={(e) => { e.stopPropagation(); onChange(null); }}
            sx={{ position: 'absolute', top: 8, right: 8, bgcolor: 'background.paper', '&:hover': { bgcolor: 'background.paper' } }}>
            <Close fontSize="small" />
          </IconButton>
        </>
      ) : (
        <Stack alignItems="center" spacing={1} sx={{ color: 'text.secondary', p: 3 }}>
          <AddPhotoAlternate fontSize="large" />
          <Typography variant="body2">Click or drag an image here</Typography>
        </Stack>
      )}
    </Box>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

const EMPTY = {
  branchId: '', makeType: 'GOLD', stockTypeId: '', categoryId: '', subCategoryId: '', collectionId: '', sizeId: '', noOfPcs: '', manufacturerId: '',
  metalKarat: '22K', huid: '', settingType: '', notes: '',
  costPrice: '', sellingPrice: '',
  // Not shown anywhere in the UI — every tag created through this wizard derives its weight from
  // the Materials tab (totalMetalWt/totalStoneWt in the submit payload below). These three only
  // exist as a fallback for editing a tag that has NO material rows at all (e.g. one intake'd
  // straight from a GRN via createTagFromGrnItem — see CLAUDE.md §8, "no materials breakdown on
  // that path"): loadTagIntoForm seeds them from the tag being edited, so its weight survives an
  // edit that doesn't touch Materials, instead of silently zeroing out.
  grossWeight: '', netWeight: '', stoneWeight: '',
  // MC & VA tab — tag-level, not per material line: applied against the tag's net (metal)
  // weight as a whole, not each row individually. Making Charge is a flat ₹/gram labour rate
  // (Amount = Net Weight × Rate); Value Addition/wastage is a % of the net weight's value
  // (Amount = metal value × VA%/100) — one pair for the price bought at, another for the price
  // tagged to sell at. Sale Making Rate/VA% auto-fill from the MakingCharge master (still
  // editable); Cost Making Rate/VA% are always manual — what was actually paid isn't something
  // any master can know, same reasoning as Cost Rate on the Materials tab. All four are real
  // JewelryTag columns (costMcRate/costVaPercent added alongside the original saleMcRate/
  // saleVaPercent) — they fold into the tag's overall costPrice/sellingPrice before save, same
  // as costRate/saleRate already do, but the decided rate/VA% itself is also kept, so editing a
  // tag later shows back exactly what was entered instead of resetting to blank.
  costMcRate: '', costVaPercent: '', saleMcRate: '', saleVaPercent: '',
  materials: [] as Array<{
    materialCodeId: string; stoneGradeId: string; code: string; materialType: string; name: string; unit: string;
    size: string; pieces: string; weight: string;
    costRate: string; costAmount: string; saleRate: string; saleAmount: string;
  }>,
};

export function NewTagPage() {
  const navigate = useNavigate();
  const { id: editTagId } = useParams();
  const isEditMode = !!editTagId;
  const { enqueueSnackbar } = useSnackbar();
  const qc = useQueryClient();
  const [activeTab, setActiveTab] = useState(0);
  const [createdTag, setCreatedTag] = useState<any>(null);
  // "Print & continue": a session preference, not tag data — deliberately outside the RHF form
  // so handleSaveAndNew's reset(EMPTY) never touches it and it stays checked across a whole
  // batch of tags. autoContinueRef bridges the mutation's onSuccess to the effect below, which
  // waits for `createdTag` to actually render into the print portal before printing.
  const [directPrint, setDirectPrint] = useState(false);
  const autoContinueRef = useRef(false);
  const formRef = useRef<HTMLFormElement>(null);
  // Local-only for now (see TagImageUpload) — no server field/endpoint exists to persist this yet.
  const [tagImage, setTagImage] = useState<File | null>(null);

  // Purchase lot (bag) this piece is being cut from — a session choice like "Print & continue", so it
  // deliberately lives outside the RHF form: Save & New resets the form but keeps the lot selected, which
  // is the whole point of tagging a bag piece after piece. /tagging/tags/new?lotId=… (from the GRN page)
  // pre-selects it. The server takes the piece's cost from the lot (its share, by net weight), so the
  // cost fields are moot while one is selected.
  const [searchParams] = useSearchParams();
  const [lotId, setLotId] = useState(searchParams.get('lotId') ?? '');

  const { control, handleSubmit, reset, watch, setValue, getValues, setFocus } = useForm({ defaultValues: EMPTY });
  const { fields, append, remove } = useFieldArray({ control, name: 'materials' });
  const watchedValues = watch();
  const watchedMaterials = watchedValues.materials;
  const selectedCatId = watchedValues.categoryId;

  // ── Edit mode: load the existing tag (with its materials breakdown) and seed the form ────────
  // Same wizard, same fields, as creating a fresh tag — only the submit target (PATCH vs POST,
  // see `mutation` below) and this one-time load differ. `appliedTagId` guards `reset()` to fire
  // exactly once per tag: react-query can refetch this in the background (refetchOnWindowFocus
  // etc.), and re-applying it every time would blow away whatever the user is mid-typing.
  const editTagQuery = useQuery({
    queryKey: ['jewelry-tag-edit', editTagId],
    queryFn: () => apiGet<any>(`/tagging/tags/${editTagId}`),
    enabled: isEditMode,
    // `gcTime: 0` — the actual bug behind "I saved Cost MC/VA, reopened the tag, it's blank
    // again": react-query keeps this query's result cached for 5 minutes (its default) after the
    // form unmounts, keyed only by tagId. Edit -> Save -> back to the list -> Edit the SAME tag
    // again remounts this page inside that window, so React Query paints the STALE pre-save
    // snapshot on the very first render (that's the point of caching — instant paint), then a
    // background refetch quietly brings in the real, just-saved values a moment later. The
    // `appliedTagId` guard below only checks "have I applied THIS tag id yet", not "is this the
    // freshest data" — so it locked onto that first, stale paint and threw the corrected refetch
    // away. Zeroing gcTime means nothing is left to reuse once this page unmounts: the next visit
    // always starts from a real loading state and applies whatever the server actually has.
    gcTime: 0,
  });
  const editTag = (editTagQuery.data as any)?.data ?? editTagQuery.data;
  // The server rejects edits/reprints of SOLD / RETIRED (purchase-returned) tags; this only mirrors that in the UI.
  const tagLocked = isEditMode && !!editTag && ['SOLD', 'RETIRED'].includes(editTag.status);
  const appliedTagId = useRef<string | null>(null);

  const lotsQuery = useQuery({
    queryKey: ['purchase-lots', 'OPEN'],
    queryFn: () => apiGet<any>('/tagging/lots', { status: 'OPEN' }),
    enabled: !isEditMode,
  });
  const openLots: any[] = (lotsQuery.data as any)?.data ?? (lotsQuery.data as any) ?? [];
  const selectedLot = openLots.find((l: any) => l.id === lotId);
  // Choosing a lot (or arriving with ?lotId=) also seeds what the lot already knows: its karat, and the
  // branch it was received at — once per lot, so it never overwrites what the user has since typed.
  const seededLotId = useRef('');
  const [lotManufacturerId, setLotManufacturerId] = useState('');
  useEffect(() => {
    if (!selectedLot || seededLotId.current === selectedLot.id) return;
    seededLotId.current = selectedLot.id;
    if (selectedLot.branchId && !getValues('branchId')) setValue('branchId', selectedLot.branchId);
    const only = selectedLot.categories?.length === 1 ? selectedLot.categories[0] : null;
    if (only) {
      setValue('categoryId', only.categoryId);
      setValue('metalKarat', only.karat);
    }
    // The bag's supplier is normally the manufacturer: pre-select the matching Client (found, or created once
    // from the supplier's details). Still an ordinary dropdown — change it if the maker is someone else.
    if (selectedLot.supplier?.id && !getValues('manufacturerId')) {
      apiPost<any>('/tagging/manufacturers/from-supplier', { supplierId: selectedLot.supplier.id })
        .then((res) => {
          const m = res?.data ?? res;
          if (!m?.id) return;
          qc.invalidateQueries({ queryKey: ['clients'] });
          setLotManufacturerId(m.id);
          if (!getValues('manufacturerId')) setValue('manufacturerId', m.id);
        })
        .catch(() => { /* optional field — leave it blank */ });
    }
  }, [selectedLot, setValue, getValues, qc]);
  // The bag's category rows are what may be tagged: with a lot chosen the Category list narrows to them, and a
  // category held in one karat only brings that karat along (each row's karat is its own).
  const lotRows: any[] = selectedLot?.categories ?? [];
  const rowsFor = (categoryId: string) => lotRows.filter((r: any) => r.categoryId === categoryId);
  // The bag row this piece falls in: its category's row (or, if the category is held in several karats, the one
  // matching the piece's karat). Its cost rates — entered once on the PO — are what the Materials and MC & VA
  // tabs are pre-filled with.
  const activeRow: any = (() => {
    const rows = rowsFor(selectedCatId);
    if (rows.length === 1) return rows[0];
    return rows.length > 1 ? rows.find((r: any) => r.karat === watchedValues.metalKarat) ?? null : null;
  })();
  // What the bag costs per net gram overall — the fallback metal rate when the PO carried no rate for the row,
  // so a lot piece is never left with a blank cost to type from scratch.
  const bagRatePerGram = selectedLot && Number(selectedLot.netWeight) > 0
    ? Math.round((Number(selectedLot.totalCost) / Number(selectedLot.netWeight)) * 100) / 100 : null;
  // MC & VA cost side: once per (bag, category row), so a value the user then changes is never overwritten.
  const appliedMcVaKey = useRef('');
  useEffect(() => {
    if (!selectedLot || !activeRow) return;
    const key = `${selectedLot.id}:${activeRow.categoryId}:${activeRow.karat}`;
    if (appliedMcVaKey.current === key) return;
    appliedMcVaKey.current = key;
    if (activeRow.mcRate != null) setValue('costMcRate', String(activeRow.mcRate));
    if (activeRow.vaPercent != null) setValue('costVaPercent', String(activeRow.vaPercent));
  }, [selectedLot, activeRow, setValue]);
  const chooseLot = (id: string) => setLotId(id);

  // Identity fields that carry over from the previous tag, so inwarding a batch doesn't re-pick them every
  // time. A per-browser convenience only (never sent anywhere), keyed by company + user so a shared machine
  // never offers one login's choices to another. Each stays an ordinary editable field.
  const authUserId = useAuthStore((s) => s.user?.id);
  const authCompanyId = useAuthStore((s) => s.company?.id);
  const rememberKey = authUserId && authCompanyId ? `trivo:newTag:identity:${authCompanyId}:${authUserId}` : null;
  const saveRemembered = (data: any) => {
    if (!rememberKey) return;
    try {
      const { branchId, manufacturerId, categoryId, makeType, stockTypeId } = data;
      localStorage.setItem(rememberKey, JSON.stringify({ branchId, manufacturerId, categoryId, makeType, stockTypeId }));
    } catch { /* storage unavailable — nothing to remember */ }
  };

  useEffect(() => {
    if (!editTag || appliedTagId.current === editTag.id) return;
    appliedTagId.current = editTag.id;
    reset({
      branchId: editTag.branchId ?? '',
      makeType: editTag.makeType ?? 'GOLD',
      stockTypeId: editTag.stockTypeId ?? '',
      categoryId: editTag.categoryId ?? '',
      subCategoryId: editTag.subCategoryId ?? '',
      collectionId: editTag.collectionId ?? '',
      sizeId: editTag.sizeId ?? '',
      noOfPcs: editTag.noOfPcs != null ? String(editTag.noOfPcs) : '',
      manufacturerId: editTag.manufacturerId ?? '',
      metalKarat: editTag.metalKarat ?? '',
      huid: editTag.huid ?? '',
      settingType: editTag.settingType ?? '',
      notes: editTag.notes ?? '',
      costPrice: editTag.costPrice != null ? String(editTag.costPrice) : '',
      sellingPrice: editTag.sellingPrice != null ? String(editTag.sellingPrice) : '',
      grossWeight: editTag.grossWeight != null ? String(editTag.grossWeight) : '',
      netWeight: editTag.netWeight != null ? String(editTag.netWeight) : '',
      stoneWeight: editTag.stoneWeight != null ? String(editTag.stoneWeight) : '',
      costMcRate: editTag.costMcRate != null ? String(editTag.costMcRate) : '',
      costVaPercent: editTag.costVaPercent != null ? String(editTag.costVaPercent) : '',
      saleMcRate: editTag.saleMcRate != null ? String(editTag.saleMcRate) : '',
      saleVaPercent: editTag.saleVaPercent != null ? String(editTag.saleVaPercent) : '',
      materials: (editTag.materials ?? []).map((m: any) => ({
        materialCodeId: m.materialCodeId ?? '',
        stoneGradeId: m.stoneGradeId ?? '',
        code: m.code ?? '',
        materialType: m.materialType ?? 'METAL',
        name: '',
        unit: m.unit ?? 'GM',
        size: m.size ?? '',
        pieces: m.pieces != null ? String(m.pieces) : '',
        weight: m.weight != null ? String(m.weight) : '',
        costRate: m.costRate != null ? String(m.costRate) : '',
        costAmount: m.costAmount != null ? String(m.costAmount) : '',
        saleRate: m.saleRate != null ? String(m.saleRate) : '',
        saleAmount: m.saleAmount != null ? String(m.saleAmount) : '',
      })),
    });
    setActiveTab(0);
  }, [editTag, reset]);

  // ── Quick "+ new manufacturer" dialog — a small subset of the full Client Master form
  // (Orders > Clients), just enough to get a usable vendor on file without leaving this page.
  const [manufacturerDialogOpen, setManufacturerDialogOpen] = useState(false);
  const manufacturerForm = useForm({
    defaultValues: { name: '', phone: '', gstNumber: '', address: '', city: '', district: '', state: '', pincode: '' },
  });
  const createManufacturerMutation = useMutation({
    mutationFn: (data: any) => apiPost('/orders/clients', { ...data, type: 'MANUFACTURER' }),
    onSuccess: (res: any) => {
      const created = (res as any)?.data ?? res;
      qc.invalidateQueries({ queryKey: ['clients'] });
      setValue('manufacturerId', created.id);
      setManufacturerDialogOpen(false);
      manufacturerForm.reset();
      enqueueSnackbar('Manufacturer added', { variant: 'success' });
    },
    onError: (e: any) => enqueueSnackbar(e.response?.data?.error ?? 'Failed to add manufacturer', { variant: 'error' }),
  });

  // ── Reference data ────────────────────────────────────────────────────────

  const { data: branches } = useQuery({ queryKey: ['branches'], queryFn: () => apiGet<any>('/tagging/branches') });
  const branchList: any[] = (branches as any)?.data ?? branches ?? [];

  // Today's rate per karat, for auto-filling a METAL material row's Cost Rate — same source
  // MetalRates.tsx already shows at Product Design > Metal Rates. Only fills when no explicit
  // MakingCharge master mapping exists for the picked material code (that mapping wins when set —
  // see onMaterialCodeSelect); still editable either way.
  const { data: metalRates } = useQuery({ queryKey: ['metal-rates'], queryFn: () => apiGet<any[]>('/designs/rates/latest') });
  const latestRateByKarat: Record<string, number> = {};
  (metalRates ?? []).forEach((r: any) => {
    if (!(r.karat in latestRateByKarat)) latestRateByKarat[r.karat] = Number(r.ratePerGram);
  });

  const { data: categories } = useQuery({ queryKey: ['master-categories'], queryFn: () => apiGet<any>('/masters/categories') });
  const catList: any[] = (categories as any)?.data ?? (categories as any) ?? [];

  const { data: stockTypes } = useQuery({ queryKey: ['master-stock-types'], queryFn: () => apiGet<any>('/masters/stock-types') });
  const stockTypeList: any[] = (stockTypes as any)?.data ?? (stockTypes as any) ?? [];

  // Manufacturers are just Client Master rows typed MANUFACTURER (CLAUDE.md: reuse the party
  // master, don't build a new vendor table) — /orders/clients has no type filter, so filter here.
  const { data: clients } = useQuery({ queryKey: ['clients'], queryFn: () => apiGet<any[]>('/orders/clients') });
  const manufacturerList: any[] = ((clients as any)?.data ?? clients ?? []).filter((c: any) => c.type === 'MANUFACTURER');

  const { data: subcats } = useQuery({
    queryKey: ['master-subcategories', selectedCatId],
    queryFn: () => apiGet<any>('/masters/subcategories', { categoryId: selectedCatId || undefined, active: 'true' }),
    enabled: !!selectedCatId,
  });
  const subCatListRaw: any[] = (subcats as any)?.data ?? (subcats as any) ?? [];
  // The server returns only sub-categories linked to the chosen category (and active). A tag being edited
  // keeps the one it already carries even if that master was deactivated since — add it back so the
  // field never shows blank — but only while the tag's category is unchanged.
  const subCatList: any[] = (isEditMode && editTag?.subCategory && editTag.categoryId === selectedCatId
    && !subCatListRaw.some((s: any) => s.id === editTag.subCategoryId))
    ? [...subCatListRaw, { id: editTag.subCategoryId, name: editTag.subCategory.name }]
    : subCatListRaw;

  const { data: collections } = useQuery({ queryKey: ['master-collections'], queryFn: () => apiGet<any>('/masters/collections') });
  const collectionList: any[] = (collections as any)?.data ?? (collections as any) ?? [];

  // Size master — active sizes for the chosen category (plus category-less ones). Not every category
  // uses a size, so the field is optional and simply stays empty/disabled until a category is picked.
  const { data: sizes } = useQuery({
    queryKey: ['master-sizes', selectedCatId],
    queryFn: () => apiGet<any>('/masters/sizes', { active: 'true', categoryId: selectedCatId }),
    enabled: !!selectedCatId,
  });
  const sizeList: any[] = (sizes as any)?.data ?? (sizes as any) ?? [];

  // Setting Type master — active rows only. A tag already carrying a since-deactivated/renamed value
  // keeps it: it is added back to the options below so the edit form never shows it as blank.
  const { data: settingTypes } = useQuery({
    queryKey: ['master-setting-types'],
    queryFn: () => apiGet<any>('/masters/setting-types', { active: 'true' }),
  });
  const settingTypeList: any[] = (settingTypes as any)?.data ?? (settingTypes as any) ?? [];

  // There is no "Item Name" at all: the piece's category + sub-category (the two ids saved with it) are the
  // only classification. The server derives the stored legacy `name` from them, so nothing is sent here.

  const { data: matCodes } = useQuery({ queryKey: ['master-material-codes'], queryFn: () => apiGet<any>('/masters/material-codes') });
  const materialCodes: any[] = (matCodes as any)?.data ?? (matCodes as any) ?? [];

  // Stones live in their own master (StoneType + a shape/color/clarity/cut/quality StoneGrade),
  // separate from the generic MaterialCode catalogue — the Materials tab picker below merges both
  // so stones (and anything else in either master) all show up in one place.
  const { data: stoneGradesData } = useQuery({ queryKey: ['master-stone-grades'], queryFn: () => apiGet<any>('/masters/stone-grades') });
  const stoneGrades: any[] = (stoneGradesData as any)?.data ?? (stoneGradesData as any) ?? [];

  const { data: priceMasterData } = useQuery({ queryKey: ['master-price-master'], queryFn: () => apiGet<any>('/masters/price-master') });
  const priceMasterList: any[] = (priceMasterData as any)?.data ?? (priceMasterData as any) ?? [];

  // Client-side mirror of the server's resolvePriceMaster() (shared/priceMaster.ts) — the most
  // recently effective active rate-card row for this grade whose weight band contains `weight`.
  // Kept in sync with the same masters this whole page already resolves rates from client-side
  // (metal rate, making charge); the server call in createTag is now just a safety-net fallback.
  const resolveStonePrice = (stoneGradeId: string, weight: number) => {
    const rows = priceMasterList
      .filter((r) => r.stoneGradeId === stoneGradeId && r.isActive)
      .sort((a, b) => new Date(b.effectiveDate).getTime() - new Date(a.effectiveDate).getTime());
    return rows.find((r) =>
      (r.weightFrom == null || weight >= Number(r.weightFrom)) &&
      (r.weightTo == null || weight <= Number(r.weightTo))
    ) ?? null;
  };

  // Code-first so the option text starts with something short and typeable (native <select>
  // type-ahead jumps by the start of the visible text) — e.g. "DIA-RD-VVS2-G — Diamond
  // (Round/G/VVS2/Excellent)". stoneGradeCode() is shared with the Stone Types master page so
  // the same grade always shows the same code everywhere.
  const formatStoneGradeLabel = (g: any) => {
    const bits = [g.shape, g.color, g.clarity, g.cut, g.quality].filter(Boolean);
    const typeName = g.stoneType?.name ?? g.stoneType?.code ?? 'Stone';
    return `${stoneGradeCode(g)} — ${typeName}${bits.length ? ' (' + bits.join('/') + ')' : ''}`;
  };

  const { data: makingChargesData } = useQuery({ queryKey: ['master-making-charges'], queryFn: () => apiGet<any>('/masters/making-charges') });
  const makingCharges: any[] = (makingChargesData as any)?.data ?? (makingChargesData as any) ?? [];

  // Seeds the MC & VA tab's Sale side (labour rate + wastage %) by karat + category — mirror of
  // sales.service.ts's findMakingCharge (server) / NewSalePage.tsx's findMakingCharge (client):
  // most-specific-match-wins across the two dimensions here (makeType is always this tag's own,
  // so it's folded in as a third). A master row only matches when every field IT has pinned
  // (non-null) agrees with the tag; among matches, the row pinning the most dimensions wins.
  const getMakingCharge = (karat: string | undefined, categoryId: string | undefined, makeType: string | undefined) =>
    findMakingCharge(makingCharges, karat, categoryId, makeType);

  // The other, unrelated use of this master: a non-metal generic material row ("OTHER" — clasps,
  // findings, etc.) prices its own Sale Rate directly off a flat materialCodeId match. Nothing to
  // do with karat/wastage — kept separate so the two concepts don't get tangled.
  const getMaterialFlatCharge = (materialCodeId: string) =>
    makingCharges.find((mc: any) => mc.materialCodeId === materialCodeId) ?? null;

  // Seeds saleMcRate/saleVaPercent from the master for the karat currently "in effect" — called
  // after anything that changes it: a materials-tab edit that shifts the dominant metal (see
  // recomputeMetalKarat below), or a manual Karat/Category override.
  const applyMakingCharge = (karat: string | undefined, categoryId: string | undefined) => {
    const charge = getMakingCharge(karat, categoryId, getValues('makeType'));
    if (charge) {
      setValue('saleMcRate', String(charge.makingCharge));
      setValue('saleVaPercent', String(charge.saleWastagePercent));
    }
  };

  // Tag-level metalKarat auto-derives from the Materials tab: whichever karat carries the most
  // total METAL weight wins, so a piece mixing G18 and G22 rows resolves to whichever purity is
  // actually dominant by weight, rather than staying whatever a manual dropdown pick left behind.
  // Still a plain editable field afterward (setValue, not a locked/derived display) — this only
  // runs on a materials-table edit, same as applySaleMetalRateToRow already does for Sale Rate.
  const recomputeMetalKarat = () => {
    const materials = getValues('materials');
    const weightByKarat: Record<string, number> = {};
    materials.forEach((m) => {
      if (m.materialType !== 'METAL' || !m.materialCodeId) return;
      const mc = materialCodes.find((c: any) => c.id === m.materialCodeId);
      if (!mc?.karat) return;
      weightByKarat[mc.karat] = (weightByKarat[mc.karat] ?? 0) + Number(m.weight || 0);
    });
    const entries = Object.entries(weightByKarat);
    if (entries.length === 0) return;
    const [bestKarat] = entries.reduce((best, cur) => (cur[1] > best[1] ? cur : best));
    setValue('metalKarat', bestKarat);
    applyMakingCharge(bestKarat, getValues('categoryId'));
  };

  const { data: jobs } = useQuery({
    queryKey: ['jobs-completed'],
    queryFn: () => apiGet<any>('/manufacturing/jobs', { status: 'COMPLETED', limit: 100 }),
  });
  const jobList: any[] = (jobs as any)?.jobs ?? (jobs as any)?.data ?? [];

  // Pre-fill each METAL row's Cost Rate from the bag row's metal rate (else the bag's overall ₹/g), once per row —
  // the user can change it and it stays changed. Only while tagging out of a bag.
  const costFilledRows = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!selectedLot || !activeRow) return;
    const rate = activeRow.costRate ?? bagRatePerGram;
    if (rate == null) return;
    fields.forEach((f, i) => {
      const row = watchedMaterials[i];
      if (!row || row.materialType !== 'METAL' || row.costRate !== '' || costFilledRows.current.has(f.id)) return;
      costFilledRows.current.add(f.id);
      setValue(`materials.${i}.costRate`, String(rate));
      recomputeRow(i);
    });
  });

  // ── Auto-compute totals from materials ────────────────────────────────────

  const totalMetalWt  = watchedMaterials.filter((m) => m.materialType === 'METAL').reduce((s, m) => s + Number(m.weight || 0), 0);
  const totalStoneWt  = watchedMaterials.filter((m) => m.materialType !== 'METAL').reduce((s, m) => s + Number(m.weight || 0), 0);
  // Gross = net (metal) + stones — same convention the server uses everywhere else
  // (createTagFromGrnItem derives netWeight as grossWeight - stoneWeight).
  // Stones are weighed in carats (1 CT = 0.2 g) but gross/net are grams, so convert before adding.
  const CT_TO_GM = 0.2;
  const totalStoneWtGm = watchedMaterials
    .filter((m) => m.materialType !== 'METAL')
    .reduce((s, m) => s + Number(m.weight || 0) * (m.unit === 'CT' ? CT_TO_GM : 1), 0);
  const totalGrossWt = totalMetalWt + totalStoneWtGm;
  const materialsCostAmt = watchedMaterials.reduce((s, m) => s + Number(m.costAmount || 0), 0);
  const materialsSaleAmt = watchedMaterials.reduce((s, m) => s + Number(m.saleAmount || 0), 0);

  // MC & VA, applied once against the metal totals rather than per material line:
  //  - Making Charge is a flat ₹/gram labour rate → Amount = Net (metal) Weight × Rate.
  //  - Value Addition/wastage is a % of the metal's own value → Amount = metal value × VA%/100
  //    (equivalent to the traditional "wastage adds weight before pricing" convention, since
  //    weight × rate × (1+pct) is the same arithmetic as (weight × rate) × (1+pct)).
  const totalMetalCostAmt = watchedMaterials.filter((m) => m.materialType === 'METAL').reduce((s, m) => s + Number(m.costAmount || 0), 0);
  const totalMetalSaleAmt = watchedMaterials.filter((m) => m.materialType === 'METAL').reduce((s, m) => s + Number(m.saleAmount || 0), 0);
  const costMcRate = Number(watchedValues.costMcRate || 0);
  const costVaPct = Number(watchedValues.costVaPercent || 0);
  const saleMcRate = Number(watchedValues.saleMcRate || 0);
  const saleVaPct = Number(watchedValues.saleVaPercent || 0);
  const makingCostAmount = computeMakingAmount(totalMetalWt, totalMetalCostAmt, costMcRate, costVaPct);
  const makingSaleAmount = computeMakingAmount(totalMetalWt, totalMetalSaleAmt, saleMcRate, saleVaPct);

  const totalCostAmt = materialsCostAmt + makingCostAmount;
  const totalSaleAmt = materialsSaleAmt + makingSaleAmount;

  // ── Material row helpers ──────────────────────────────────────────────────

  // Every master-derived default (today's metal rate, a MakingCharge match, PriceMaster) fills
  // the SALE side only — what you're tagging the piece to sell at, which follows a rate
  // card/policy. Cost is always left for manual entry: what you actually paid is specific to
  // that purchase and isn't something any master can know. This mirrors real usage — a master
  // sets pricing policy, it doesn't record a transaction.

  // Fills a METAL row's Sale Rate from today's metal rate for the tag's karat. Re-run on Karat
  // change too (see the Karat field's onChange).
  const applySaleMetalRateToRow = (idx: number, karat: string | undefined) => {
    // Live read, not the `watch()` snapshot from the render this call was scheduled in — that
    // snapshot is one edit behind whenever this runs synchronously after a setValue/onChange
    // (see recomputeRow below for the bug this avoids).
    const row = getValues(`materials.${idx}`);
    if (!row || row.materialType !== 'METAL') return;
    const rate = karat ? latestRateByKarat[karat] : undefined;
    if (!rate) return;
    setValue(`materials.${idx}.saleRate`, String(rate));
    recomputeRow(idx);
  };

  const onMaterialCodeSelect = (idx: number, mc: any) => {
    setValue(`materials.${idx}.materialCodeId`, mc.id);
    setValue(`materials.${idx}.stoneGradeId`, '');
    setValue(`materials.${idx}.code`, mc.code);
    setValue(`materials.${idx}.materialType`, mc.materialType);
    setValue(`materials.${idx}.name`, mc.name);
    setValue(`materials.${idx}.unit`, mc.unit);

    if (mc.materialType === 'METAL') {
      // Price this row's own Sale Rate off its own karat (e.g. a G18 row prices at the 18K rate
      // even on a tag whose overall karat, below, ends up dominated by a heavier G22 row).
      // Deliberately does NOT fall back to the tag-level karat when the material code has none
      // set: the tag's karat field is gold-purity-shaped ("22K" by default), so a Silver/Platinum
      // material code with no karat of its own would otherwise silently price at whatever gold
      // rate the tag happens to default to. Leaving Sale Rate blank here is the safe outcome —
      // fix it by giving the material code its own karat/purity in Masters > Material Codes
      // (e.g. "SILVER" for a silver code) so it resolves its own rate.
      applySaleMetalRateToRow(idx, mc.karat);
      // Recomputes the tag's overall metalKarat from every METAL row's weight (this one included)
      // and seeds the MC & VA tab's Sale side (labour rate + wastage %) from the master for
      // whichever karat comes out dominant — not the metal price itself (that's the sale rate set
      // above).
      recomputeMetalKarat();
    } else {
      // Non-metal, non-stone generic material code ("OTHER"): a MakingCharge match, if any,
      // prices this row's Sale Rate directly.
      const charge = getMaterialFlatCharge(mc.id);
      if (charge) setValue(`materials.${idx}.saleRate`, String(charge.makingCharge));
      recomputeRow(idx);
      // This row may have just stopped being METAL (materialType switch) — recompute in case it
      // was contributing to the dominant-karat weight before.
      recomputeMetalKarat();
    }
  };

  // Picking a stone from the Stone Grade master: identity (code/materialType/name/unit) comes
  // from the grade + its parent StoneType, same as onMaterialCodeSelect does from MaterialCode.
  const onStoneGradeSelect = (idx: number, grade: any) => {
    setValue(`materials.${idx}.materialCodeId`, '');
    setValue(`materials.${idx}.stoneGradeId`, grade.id);
    setValue(`materials.${idx}.code`, grade.stoneType?.code ?? grade.id);
    setValue(`materials.${idx}.materialType`, grade.stoneType?.itemType || 'STONE');
    setValue(`materials.${idx}.name`, formatStoneGradeLabel(grade));
    setValue(`materials.${idx}.unit`, grade.stoneType?.unit || 'CT');
    applyStonePriceToRow(idx);
    // This row may have just stopped being METAL (was a metal row, now a stone) — recompute the
    // tag's dominant karat without its weight.
    recomputeMetalKarat();
  };

  // Fills a stone row's Sale Rate from the PriceMaster rate card for its grade, by weight — only
  // the sale side, since PriceMaster is a selling rate card, not a purchase cost. Re-run on
  // Weight change too (see the Weight field's onChange), since the weight band that matches can
  // change as the user finishes typing it.
  const applyStonePriceToRow = (idx: number) => {
    const row = getValues(`materials.${idx}`);
    if (!row?.stoneGradeId) return;
    const match = resolveStonePrice(row.stoneGradeId, Number(row.weight || 0));
    if (!match) return;
    setValue(`materials.${idx}.saleRate`, String(match.pricePerCarat));
    recomputeRow(idx);
  };

  // Cost/Sale Amount = Weight × Rate, plain — the making-charge/value-addition markup lives at
  // the tag level (MC & VA tab) now, applied once against the metal's total value, not per row.
  //
  // Reads via getValues(), NOT the `row` from watch() closed over by the calling render: every
  // caller invokes this straight out of an onChange, and a `watch()` snapshot captured when that
  // JSX was rendered still holds the value from *before* this keystroke — using it here made
  // every amount lag one edit behind whatever was just typed.
  const recomputeRow = (idx: number) => {
    const row = getValues(`materials.${idx}`);
    if (!row) return;
    const wt = Number(row.weight || 0);
    setValue(`materials.${idx}.costAmount`, computeLineAmount(wt, Number(row.costRate || 0)).toFixed(2));
    setValue(`materials.${idx}.saleAmount`, computeLineAmount(wt, Number(row.saleRate || 0)).toFixed(2));
  };

  const addMaterialRow = () => {
    append({
      materialCodeId: '', stoneGradeId: '', code: '', materialType: 'METAL', name: '', unit: 'GM', size: '', pieces: '', weight: '',
      costRate: '', costAmount: '', saleRate: '', saleAmount: '',
    });
  };

  // ── Materials grid keyboard navigation ─────────────────────────────────────
  // Spreadsheet-style entry: Tab/Enter off the last cell (Weight) of the last row appends a new
  // row and jumps straight to its Material Code cell, so a fast typist never has to reach for the
  // mouse or the "Add Row" button. `pendingFocusRow` bridges the append (async re-render) to the
  // focus call, since the target cell doesn't exist in the DOM yet at click/keydown time.
  const MATERIALS_LAST_COL = 5; // 0:code 1:size 2:pieces 3:weight 4:costRate 5:saleRate
  const cellRefs = useRef<Record<string, HTMLInputElement | HTMLSelectElement | null>>({});
  const pendingFocusRow = useRef<number | null>(null);

  const registerCellRef = (idx: number, col: number) => (el: HTMLInputElement | HTMLSelectElement | null) => {
    cellRefs.current[`${idx}-${col}`] = el;
  };
  const focusCell = (idx: number, col: number) => cellRefs.current[`${idx}-${col}`]?.focus();

  const addRowAndFocus = () => {
    pendingFocusRow.current = fields.length;
    addMaterialRow();
  };

  useEffect(() => {
    if (pendingFocusRow.current === null) return;
    const idx = pendingFocusRow.current;
    pendingFocusRow.current = null;
    requestAnimationFrame(() => focusCell(idx, 0));
  }, [fields.length]);

  // Auto-seed one empty row (and focus its Material Code cell) the moment the Materials tab is
  // opened, instead of making the user click "Add Row" for the very first line.
  useEffect(() => {
    if (activeTab === 1 && fields.length === 0) addRowAndFocus();
  }, [activeTab]);

  const handleCellKeyDown = (idx: number, col: number) => (e: React.KeyboardEvent) => {
    const isLastRow = idx === fields.length - 1;
    if (e.key === 'Enter') {
      e.preventDefault(); // a bare input Enter would otherwise submit the whole tag form
      if (col === MATERIALS_LAST_COL) {
        if (isLastRow) addRowAndFocus(); else focusCell(idx + 1, 0);
      } else {
        focusCell(idx, col + 1);
      }
    } else if (e.key === 'Tab' && !e.shiftKey && col === MATERIALS_LAST_COL && isLastRow) {
      e.preventDefault();
      addRowAndFocus();
    }
  };

  // ── Materials grid column resize ────────────────────────────────────────────
  // Width only, deliberately NOT reorder/hide (see the Card comment above the table) — resizing
  // doesn't touch column order, so it can't desync from MATERIALS_LAST_COL/registerCellRef above,
  // which key on position, not width.
  const MATERIALS_COL_DEFAULTS: Record<string, number> = {
    code: 200, size: 72, pieces: 52, weight: 72, unit: 46,
    costRate: 82, costAmt: 82, saleRate: 82, saleAmt: 82, actions: 40,
  };
  const [materialColWidths, setMaterialColWidths] = useState<Record<string, number>>({});
  const materialColWidth = (key: string) => materialColWidths[key] ?? MATERIALS_COL_DEFAULTS[key];
  const colResizeState = useRef<{ key: string; startX: number; startWidth: number } | null>(null);
  const [resizingCol, setResizingCol] = useState<string | null>(null);

  const onColResizeMove = (e: MouseEvent) => {
    const rs = colResizeState.current;
    if (!rs) return;
    setMaterialColWidths((w) => ({ ...w, [rs.key]: Math.max(32, rs.startWidth + (e.clientX - rs.startX)) }));
  };
  const onColResizeUp = () => {
    colResizeState.current = null;
    setResizingCol(null);
    document.removeEventListener('mousemove', onColResizeMove);
    document.removeEventListener('mouseup', onColResizeUp);
  };
  const startColResize = (e: React.MouseEvent, key: string) => {
    e.preventDefault();
    e.stopPropagation();
    colResizeState.current = { key, startX: e.clientX, startWidth: materialColWidth(key) };
    setResizingCol(key);
    document.addEventListener('mousemove', onColResizeMove);
    document.addEventListener('mouseup', onColResizeUp);
  };
  useEffect(() => () => {
    document.removeEventListener('mousemove', onColResizeMove);
    document.removeEventListener('mouseup', onColResizeUp);
  }, []);

  const colResizeHandle = (colKey: string) => (
    <Box
      onMouseDown={(e) => startColResize(e, colKey)}
      onClick={(e) => e.stopPropagation()}
      sx={(theme) => ({
        position: 'absolute', top: 0, bottom: 0, right: -3, width: 6,
        cursor: 'col-resize', zIndex: 1,
        ...(resizingCol === colKey && { bgcolor: theme.palette.secondary.main }),
        '&:hover': { bgcolor: theme.palette.secondary.main },
      })}
    />
  );

  // ── MC & VA tab keyboard navigation ────────────────────────────────────────
  // Just 4 standalone fields (+ Notes) now (no repeating rows) — Enter moves to the next one in order
  // instead of submitting the form; Tab's default browser behavior already does the same via DOM
  // order, so only Enter needs help here.
  const MC_VA_FIELDS = ['costVaPercent', 'costMcRate', 'saleVaPercent', 'saleMcRate', 'notes'] as const;
  const mcVaRefs = useRef<Record<string, HTMLInputElement | null>>({});
  const registerMcVaRef = (name: string) => (el: HTMLInputElement | null) => { mcVaRefs.current[name] = el; };
  const handleMcVaKeyDown = (name: (typeof MC_VA_FIELDS)[number]) => (e: React.KeyboardEvent) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const next = MC_VA_FIELDS[MC_VA_FIELDS.indexOf(name) + 1];
    if (next) mcVaRefs.current[next]?.focus();
  };

  // ── Submit ────────────────────────────────────────────────────────────────

  const mutation = useMutation({
    mutationFn: (data: any) => {
      // Sale rates are required before a tag is saved - a blank is never sent as 0 (an explicit 0 is a real rate). The server
      // refuses the same thing; this just says so before the round trip.
      const isBlank = (v: any) => v === '' || v == null;
      const missingRates: string[] = [];
      if (isBlank(data.saleMcRate)) missingRates.push('Sale making charge rate');
      if (isBlank(data.saleVaPercent)) missingRates.push('Sale VA %');
      (data.materials ?? []).forEach((m: any) => {
        if (m.materialType !== 'METAL' && isBlank(m.saleRate) && isBlank(m.saleAmount) && !m.stoneGradeId) missingRates.push(`${m.code || 'Material'} sale rate`);
      });
      if (missingRates.length > 0) return Promise.reject({ response: { data: { error: `Fill in before saving: ${missingRates.join(', ')}` } } });
      const payload: any = {
        branchId:     data.branchId,
        makeType:     data.makeType,
        metalType:    data.makeType,
        metalKarat:   data.metalKarat || undefined,
        grossWeight:  totalGrossWt || Number(data.grossWeight || 0),
        netWeight:    totalMetalWt || Number(data.netWeight   || 0),
        stoneWeight:  totalStoneWtGm || 0,
        huid:         data.huid         || undefined,
        settingType:  data.settingType  || undefined,
        notes:        data.notes        || undefined,
        stockTypeId:  data.stockTypeId,
        categoryId:   data.categoryId   || undefined,
        // null (edit only) clears a previously saved value; undefined leaves it out on create
        subCategoryId: data.subCategoryId || (isEditMode ? null : undefined),
        collectionId: data.collectionId  || undefined,
        // null (edit only) clears a previously saved value; undefined leaves it out on create
        sizeId:       data.sizeId || (isEditMode ? null : undefined),
        noOfPcs:      data.noOfPcs ? Number(data.noOfPcs) : (isEditMode ? null : undefined),
        manufacturerId: data.manufacturerId || undefined,
        costPrice:    totalCostAmt || Number(data.costPrice    || 0),
        sellingPrice: totalSaleAmt || Number(data.sellingPrice || 0),
        ...(!isEditMode && lotId && { purchaseLotId: lotId }),
        // Whatever MC rate/VA% actually priced this piece — auto-suggested from the MakingCharge
        // master but overridable on this form, so this is the exec's final decision, not a live
        // master value. Estimation/direct-sale pricing read this back later instead of re-deriving.
        saleMcRate:    Number(data.saleMcRate),
        saleVaPercent: Number(data.saleVaPercent),
        // Cost-side counterpart — persisted so re-opening this tag for edit shows back exactly
        // what was paid in labour/wastage, instead of resetting blank and dropping it from
        // costPrice on the next save.
        costMcRate:    Number(data.costMcRate    || 0),
        costVaPercent: Number(data.costVaPercent || 0),
        materials: data.materials.map((m: any) => ({
          materialCodeId: m.materialCodeId || undefined,
          stoneGradeId: m.stoneGradeId || undefined,
          code:         m.code,
          materialType: m.materialType,
          size:         m.size    || undefined,
          pieces:       m.pieces  ? Number(m.pieces)  : undefined,
          weight:       Number(m.weight),
          unit:         m.unit,
          costRate:     m.costRate  ? Number(m.costRate)  : undefined,
          costAmount:   m.costAmount ? Number(m.costAmount) : undefined,
          saleRate:     m.saleRate  ? Number(m.saleRate)  : undefined,
          saleAmount:   m.saleAmount ? Number(m.saleAmount) : undefined,
        })),
      };
      return isEditMode
        ? apiPatch(`/tagging/tags/${editTagId}`, payload)
        : apiPost('/tagging/tags', payload);
    },
    onSuccess: (res: any, submitted: any) => {
      const tag = (res as any)?.data ?? res;
      if (!isEditMode) saveRemembered(submitted);
      qc.invalidateQueries({ queryKey: ['jewelry-tags'] });
      qc.invalidateQueries({ queryKey: ['purchase-lots'] });
      qc.invalidateQueries({ queryKey: ['jewelry-tag', tag.id] });
      qc.invalidateQueries({ queryKey: ['jewelry-tag-edit', tag.id] });
      if (directPrint) autoContinueRef.current = true;
      setCreatedTag(tag);
      enqueueSnackbar(`Tag ${tag.tagNumber} ${isEditMode ? 'updated' : 'created'}`, { variant: 'success' });
    },
    onError: (e: any) => enqueueSnackbar(e.response?.data?.error ?? `Failed to ${isEditMode ? 'update' : 'create'} tag`, { variant: 'error' }),
  });

  const handlePrint = () => {
    const style = document.createElement('style');
    style.innerHTML = `@media print { body > * { display:none!important; } #tag-print-portal { display:block!important; position:fixed; top:0; left:0; } }`;
    document.head.appendChild(style);
    window.print();
    document.head.removeChild(style);
  };

  // Real thermal-printer output (TSC TTP-244 Pro via the local print agent) — separate from
  // handlePrint above, which stays exactly what it was (a browser print-dialog preview, and the
  // trigger for the unrelated "Print & continue" auto-save-and-new flow). Polls agent status only
  // while the success screen showing the button is actually on screen.
  const agentStatusQuery = useQuery({
    queryKey: ['print-agent-status'],
    queryFn: getPrintAgentStatus,
    enabled: !!createdTag,
    refetchInterval: 10000,
    retry: false,
  });

  const printLabelMutation = useMutation({
    mutationFn: async () => {
      const { tspl, resolved, warnings } = await apiGet<{ tspl: string; resolved?: any; warnings?: { message: string }[] }>(`/tagging/tags/${createdTag.id}/print`);
      await printTsplViaAgent(tspl);
      return { resolved, warnings };
    },
    onSuccess: (r: any) => {
      const sub = r?.resolved?.subCategory;
      enqueueSnackbar(`Label sent to printer — ${[r?.resolved?.category?.name, sub ? `${sub.name} (${sub.code ?? ''})` : null].filter(Boolean).join(' › ')}`, { variant: 'success' });
      for (const w of r?.warnings ?? []) enqueueSnackbar(w.message, { variant: 'warning', autoHideDuration: 12000 });
    },
    onError: (e: any) => enqueueSnackbar(e.message ?? 'Print failed', { variant: 'error', action: printAgentSnackbarAction(e) }),
  });

  // The remembered values that are still usable: skipped silently when the branch/category/stock type/
  // manufacturer is gone from (or no longer offered in) this user's lists, or the category isn't in the bag.
  const readRemembered = (): Record<string, string> => {
    if (!rememberKey) return {};
    let saved: any;
    try { saved = JSON.parse(localStorage.getItem(rememberKey) ?? '{}'); } catch { return {}; }
    const ok: Record<string, string> = {};
    if (branchList.some((b: any) => b.id === saved.branchId)) ok.branchId = saved.branchId;
    if (manufacturerList.some((m: any) => m.id === saved.manufacturerId)) ok.manufacturerId = saved.manufacturerId;
    if (stockTypeList.some((s: any) => s.id === saved.stockTypeId)) ok.stockTypeId = saved.stockTypeId;
    if (catList.some((c: any) => c.id === saved.categoryId) && (lotRows.length === 0 || rowsFor(saved.categoryId).length > 0)) ok.categoryId = saved.categoryId;
    if (MAKE_TYPES.includes(saved.makeType)) ok.makeType = saved.makeType;
    return ok;
  };

  // Opening a fresh New Tag form: fill the remembered fields once the lists they're checked against have loaded,
  // and only into fields still at their default — never over something already picked or a purchase lot's values.
  const rememberedApplied = useRef(false);
  useEffect(() => {
    if (isEditMode || rememberedApplied.current || lotId) return;
    if (!branches || !categories || !stockTypes || !clients) return;
    rememberedApplied.current = true;
    const remembered = readRemembered();
    (Object.keys(remembered) as Array<'branchId' | 'manufacturerId' | 'categoryId' | 'makeType' | 'stockTypeId'>).forEach((k) => {
      const untouched = k === 'makeType' ? getValues(k) === EMPTY.makeType : !getValues(k);
      if (untouched) setValue(k, remembered[k]);
    });
  }, [branches, categories, stockTypes, clients]);

  const handleSaveAndNew = () => {
    setCreatedTag(null);
    setTagImage(null);
    // A bag being tagged piece after piece keeps its karat and branch for the next piece.
    appliedMcVaKey.current = '';   // the next piece starts from the bag's rates again
    const onlyRow = selectedLot?.categories?.length === 1 ? selectedLot.categories[0] : null;
    const remembered = readRemembered();
    reset(selectedLot
      ? { ...EMPTY, ...remembered, branchId: selectedLot.branchId || remembered.branchId || '', manufacturerId: lotManufacturerId || remembered.manufacturerId || '', ...(onlyRow && { categoryId: onlyRow.categoryId, metalKarat: onlyRow.karat }) }
      : { ...EMPTY, ...remembered });
    setActiveTab(0);
    // Editing a tag and hitting "Save & New" starts a genuinely new tag, not another edit of the
    // same one — leave the /:id/edit route so the next submit POSTs instead of re-PATCHing this
    // tag's id. React Router reuses this component instance across sibling routes (same element),
    // so the reset() above still matters even after the URL changes.
    if (isEditMode) navigate('/tagging/tags/new', { replace: true });
    setTimeout(() => setFocus('branchId'), 100);
  };

  // Keyboard: Ctrl+S saves from any tab, Ctrl+Enter = next tab (save on the last), Alt+←/→ = previous/next tab.
  // After saving, Ctrl+Enter = Save & New and Alt+P = print the thermal label.
  const saveFromKeyboard = () => {
    if (tagLocked || mutation.isPending) return;
    formRef.current?.requestSubmit();   // runs the form's own validation, which jumps to the offending tab
  };
  // Identity's first field is Branch (the lot picker can sit above it), so that tab focuses it by name.
  const goTab = (n: number) => {
    setActiveTab(n);
    if (n === 0) window.setTimeout(() => setFocus('branchId'), 60);
    else focusFirstField(formRef.current);
  };
  usePageShortcuts({
    'ctrl+s': () => { if (!createdTag) saveFromKeyboard(); },
    'ctrl+enter': () => {
      if (createdTag) handleSaveAndNew();
      else if (activeTab < 2) goTab(activeTab + 1);
      else saveFromKeyboard();
    },
    'alt+arrowright': () => { if (!createdTag && activeTab < 2) goTab(activeTab + 1); },
    'alt+arrowleft': () => { if (!createdTag && activeTab > 0) goTab(activeTab - 1); },
    'alt+p': () => { if (createdTag && !printLabelMutation.isPending) printLabelMutation.mutate(); },
  });

  // "Print & continue" checkbox: once `createdTag` actually renders (the print portal above
  // reads it), fire the print dialog, then reset back to a blank Identity tab as soon as the
  // dialog closes. Listening for `afterprint` (rather than just chaining after window.print())
  // is what makes this safe regardless of whether the browser treats window.print() as blocking
  // — the reset can never race ahead of the print portal still being on screen.
  // Printing now goes straight to the thermal printer configured on the Hardware page (via the
  // local print agent) — no browser print dialog. A newly created tag always prints; an edit only
  // prints when "Print & continue" is ticked. "Print & continue" then resets to a blank form.
  useEffect(() => {
    if (!createdTag) return;
    const wantsContinue = autoContinueRef.current;
    autoContinueRef.current = false;
    if (isEditMode && !wantsContinue) return;
    printLabelMutation.mutate(undefined, {
      onSuccess: () => { if (wantsContinue) handleSaveAndNew(); },
    });
  }, [createdTag]);

  // ─────────────────────────────────────────────────────────────────────────

  return (
    <>
      {/* Print portal */}
      {createdTag && (
        <Box id="tag-print-portal" sx={{ display: 'none', '@media print': { display: 'block' } }}>
          <TagLabel tag={createdTag} />
        </Box>
      )}

      <Box sx={{ '@media print': { display: 'none' } }}>
        <PageHeader title={isEditMode ? `Edit Tag${editTag?.tagNumber ? ` ${editTag.tagNumber}` : ''}` : 'New Tag'} />
        {tagLocked && (
          <Alert severity="warning" sx={{ mb: 2 }}>
            This tag is {editTag.status === 'SOLD' ? 'sold' : 'retired / purchase-returned'} — it can no longer be edited or reprinted.
          </Alert>
        )}

        <Grid container spacing={3} alignItems="flex-start">

          {/* ── Left: form — full width only for the Materials tab's wide grid; MC & VA is back
               to a normal-width card now that it's 4 standalone fields, not a per-row table. ── */}
          <Grid item xs={12} md={activeTab === 1 && !createdTag ? 12 : 8}>
            <Card sx={{ p: 0 }}>
              {isEditMode && editTagQuery.isLoading ? (
                <Box sx={{ display: 'flex', justifyContent: 'center', py: 8 }}><CircularProgress /></Box>
              ) : createdTag ? (
                /* Success state */
                <Box sx={{ p: 3 }}>
                  <Alert severity="success" icon={<CheckCircle />} sx={{ mb: 2 }}>
                    <Typography fontWeight={700}>Tag {createdTag.tagNumber} {isEditMode ? 'updated' : 'created'}!</Typography>
                  </Alert>
                  <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5}>
                    <Button variant="contained" size="large" startIcon={<Print />} onClick={handlePrint} sx={{ flex: 1 }}>Print Tag</Button>
                    <Button variant="outlined" size="large" startIcon={<AddCircleOutline />} onClick={handleSaveAndNew} sx={{ flex: 1 }}>Save & New</Button>
                    <Button variant="text" size="large" onClick={() => navigate('/tagging/tags')} sx={{ flex: 1 }}>View All Tags</Button>
                  </Stack>

                  {/* Real thermal label via the counter PC's local print agent — separate from
                      "Print Tag" above, which is just a browser print-dialog preview. */}
                  <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5} alignItems="center" sx={{ mt: 1.5 }}>
                    <Button
                      variant="contained" color="secondary" size="large"
                      startIcon={<LocalPrintshop />}
                      onClick={() => printLabelMutation.mutate()}
                      disabled={printLabelMutation.isPending}
                      sx={{ flex: 1 }}
                    >
                      {printLabelMutation.isPending ? 'Printing…' : 'Print Label (Thermal)'}
                    </Button>
                    {agentStatusQuery.data && (
                      <Chip
                        size="small"
                        label={agentStatusQuery.data.online
                          ? `Printer online: ${agentStatusQuery.data.printerName}`
                          : !agentStatusQuery.data.configured
                          ? 'Print agent needs setup — open Hardware page'
                          : `Printer offline (${agentStatusQuery.data.printerName})`}
                        color={agentStatusQuery.data.online ? 'success' : 'error'}
                      />
                    )}
                    {agentStatusQuery.isError && (
                      <Chip size="small" label="Print agent not running on this PC" color="default" />
                    )}
                  </Stack>
                </Box>
              ) : (
                <form ref={formRef} onSubmit={handleSubmit((d) => mutation.mutate(d), (formErrors) => {
                  if (formErrors.branchId) { setActiveTab(0); enqueueSnackbar('Branch is required', { variant: 'warning' }); }
                  else if (formErrors.stockTypeId) { setActiveTab(0); enqueueSnackbar('Stock Type is required', { variant: 'warning' }); }
                  else if (formErrors.categoryId) { setActiveTab(0); enqueueSnackbar('Category is required', { variant: 'warning' }); }
                  else if (formErrors.materials) { setActiveTab(1); enqueueSnackbar('Every material row needs a weight', { variant: 'warning' }); }
                })}>
                  {/* All three tabs are always clickable — nothing here is gated on the others
                      being filled first (matches the reference app's Inward screen, where every
                      left-nav section opens regardless of what's filled elsewhere). Missing
                      required fields are only enforced at Create Tag time, via the onInvalid
                      handler above jumping back to the offending tab. */}
                  <Tabs value={activeTab} onChange={(_, v) => setActiveTab(v)}
                    sx={{ borderBottom: 1, borderColor: 'divider', px: 2 }}>
                    <Tab label="1 · Identity" />
                    <Tab label="2 · Materials" />
                    <Tab label="3 · MC & VA" />
                  </Tabs>

                  {/* ── Tab 1: Identity ── */}
                  {activeTab === 0 && (
                    <Box sx={{ p: 3 }}>
                      <Grid container spacing={2}>
                        {!isEditMode && (openLots.length > 0 || !!lotId) && (
                          <Grid item xs={12}>
                            <TextField select fullWidth label="Purchase lot (optional)" value={lotId}
                              onChange={(e) => chooseLot(e.target.value)}
                              SelectProps={{ native: true }} InputLabelProps={{ shrink: true }}
                              helperText="Tagging a bought-in bag? Pick it here — each piece takes its share of the lot's cost, by net weight.">
                              <option value="">Not from a lot</option>
                              {openLots.map((l: any) => (
                                <option key={l.id} value={l.id}>
                                  {l.grnNumber} · {l.label} · {Number(l.remainingNet).toFixed(3)} g net left{l.remainingPieces != null ? ` · ${l.remainingPieces} of ${l.pieces} pcs left` : ''} · {l.supplier?.name}
                                </option>
                              ))}
                            </TextField>
                            {selectedLot && (
                              <Alert severity="info" sx={{ mt: 1 }}>
                                Bag <strong>{selectedLot.label}</strong> ({selectedLot.supplier?.name}, bill {selectedLot.invoiceNumber ?? selectedLot.grnNumber}):
                                {' '}{selectedLot.taggedPieces} pieces tagged · {Number(selectedLot.remainingNet).toFixed(3)} g net left · pieces carry {fmtINR(selectedLot.allocatedCost)} of the {fmtINR(selectedLot.totalCost)} invoice so far.
                                {(selectedLot.categories ?? []).map((c: any) => (
                                  <Box key={`${c.categoryId}:${c.karat}`} component="div" sx={{ fontFamily: 'monospace', fontSize: 12 }}>
                                    {c.categoryName} {c.karat}: {Number(c.remainingNet).toFixed(3)} g net left of {Number(c.netWeight).toFixed(3)}
                                    {c.remainingPieces != null ? ` · ${c.remainingPieces} of ${c.pieces} pcs left` : ''}
                                  </Box>
                                ))}
                              </Alert>
                            )}
                          </Grid>
                        )}
                        {isEditMode && editTag?.purchaseLotId && (
                          <Grid item xs={12}>
                            <Alert severity="info">Cut from a purchase lot — see the lot for how this piece sits against the invoice.</Alert>
                          </Grid>
                        )}
                        <Grid item xs={6} sm={6}>
                          <Controller name="branchId" control={control} rules={{ required: true }}
                            render={({ field, fieldState }) => (
                              <TextField {...field} select fullWidth label="Branch *" error={!!fieldState.error}
                                autoFocus SelectProps={{ native: true }} InputLabelProps={{ shrink: true }}>
                                <option value="" />
                                {branchList.map((b: any) => <option key={b.id} value={b.id}>{b.branchCode} — {b.name}</option>)}
                              </TextField>
                            )} />
                        </Grid>
                        <Grid item xs={6} sm={6}>
                          <Controller name="makeType" control={control}
                            render={({ field }) => (
                              <TextField {...field} select fullWidth label="Make Type *"
                                SelectProps={{ native: true }} InputLabelProps={{ shrink: true }}>
                                {MAKE_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                              </TextField>
                            )} />
                        </Grid>
                        {/* No manual Karat/Purity field — it auto-derives from the Materials tab
                            (recomputeMetalKarat: whichever karat carries the most METAL weight
                            wins) and prices off each material code's own karat, never a tag-level
                            default. A manual override here was exactly how a Silver row could get
                            silently priced at a leftover gold karat. */}

                        <Grid item xs={12}>
                          <Divider><Typography variant="caption" color="text.secondary">Classification</Typography></Divider>
                        </Grid>

                        <Grid item xs={6} sm={3}>
                          <Controller name="stockTypeId" control={control} rules={{ required: true }}
                            render={({ field, fieldState }) => (
                              <TextField {...field} select fullWidth label="Stock Type *" error={!!fieldState.error}
                                SelectProps={{ native: true }} InputLabelProps={{ shrink: true }}>
                                <option value="" />
                                {stockTypeList.map((s: any) => <option key={s.id} value={s.id}>{s.name}</option>)}
                              </TextField>
                            )} />
                        </Grid>
                        <Grid item xs={6} sm={3}>
                          <Controller name="categoryId" control={control} rules={{ required: true }}
                            render={({ field, fieldState }) => (
                              <TextField {...field} select fullWidth label="Category *" error={!!fieldState.error}
                                SelectProps={{ native: true }} InputLabelProps={{ shrink: true }}
                                onChange={(e) => {
                                  field.onChange(e); setValue('subCategoryId', ''); setValue('sizeId', '');
                                  const rows = rowsFor(e.target.value);
                                  if (rows.length === 1) setValue('metalKarat', rows[0].karat);
                                  applyMakingCharge(getValues('metalKarat'), e.target.value);
                                }}>
                                <option value="" />
                                {(lotRows.length > 0 ? catList.filter((c: any) => rowsFor(c.id).length > 0) : catList)
                                  .map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}
                              </TextField>
                            )} />
                        </Grid>
                        <Grid item xs={6} sm={3}>
                          <Controller name="subCategoryId" control={control}
                            render={({ field }) => (
                              <TextField {...field} select fullWidth label="Sub-category" disabled={!selectedCatId}
                                SelectProps={{ native: true }} InputLabelProps={{ shrink: true }}>
                                <option value="">None</option>
                                {subCatList.map((s: any) => <option key={s.id} value={s.id}>{s.name}</option>)}
                              </TextField>
                            )} />
                        </Grid>
                        <Grid item xs={6} sm={3}>
                          <Controller name="collectionId" control={control}
                            render={({ field }) => (
                              <TextField {...field} select fullWidth label="Collection"
                                SelectProps={{ native: true }} InputLabelProps={{ shrink: true }}>
                                <option value="">None</option>
                                {collectionList.map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}
                              </TextField>
                            )} />
                        </Grid>
                        <Grid item xs={6} sm={3}>
                          <Controller name="sizeId" control={control}
                            render={({ field }) => (
                              <TextField {...field} select fullWidth label="Size" disabled={!selectedCatId}
                                SelectProps={{ native: true }} InputLabelProps={{ shrink: true }}>
                                <option value="">None</option>
                                {sizeList.map((z: any) => <option key={z.id} value={z.id}>{z.name}</option>)}
                                {/* a deactivated size already on this tag stays visible so saving doesn't silently drop it */}
                                {field.value && !sizeList.some((z: any) => z.id === field.value) && editTag?.size
                                  && <option value={field.value}>{editTag.size.name}</option>}
                              </TextField>
                            )} />
                        </Grid>
                        <Grid item xs={6} sm={3}>
                          <Controller name="noOfPcs" control={control}
                            rules={{ validate: (v) => v === '' || v == null || (Number.isInteger(Number(v)) && Number(v) >= 1) || 'Whole number, at least 1' }}
                            render={({ field, fieldState }) => (
                              <TextField {...field} fullWidth label="No. of Pcs" type="number"
                                error={!!fieldState.error} helperText={fieldState.error?.message}
                                inputProps={{ min: 1, step: 1 }} InputLabelProps={{ shrink: true }}
                                onWheel={(e) => (e.target as HTMLInputElement).blur()} />
                            )} />
                        </Grid>
                        <Grid item xs={12} sm={6}>
                          <Stack direction="row" spacing={1} alignItems="flex-start">
                            <Controller name="manufacturerId" control={control}
                              render={({ field }) => (
                                <TextField {...field} select fullWidth label="Manufacturer"
                                  SelectProps={{ native: true }} InputLabelProps={{ shrink: true }}>
                                  <option value="">None</option>
                                  {manufacturerList.map((m: any) => <option key={m.id} value={m.id}>{m.name}</option>)}
                                </TextField>
                              )} />
                            <IconButton size="small" onClick={() => setManufacturerDialogOpen(true)} sx={{ mt: 1 }}
                              title="Add a new manufacturer">
                              <Add fontSize="small" />
                            </IconButton>
                          </Stack>
                        </Grid>

                        <Grid item xs={12}>
                          <Divider><Typography variant="caption" color="text.secondary">Item Details</Typography></Divider>
                        </Grid>

                        <Grid item xs={6} sm={4}>
                          <Controller name="huid" control={control}
                            render={({ field }) => <TextField {...field} fullWidth label="HUID" inputProps={{ style: { textTransform: 'uppercase', letterSpacing: 2 } }} />} />
                        </Grid>
                        <Grid item xs={6} sm={4}>
                          <Controller name="settingType" control={control}
                            render={({ field }) => (
                              <TextField {...field} select fullWidth label="Setting Type"
                                SelectProps={{ native: true }} InputLabelProps={{ shrink: true }}>
                                <option value="">None</option>
                                {field.value && !settingTypeList.some((t: any) => t.name === field.value) && (
                                  <option value={field.value}>{field.value}</option>
                                )}
                                {settingTypeList.map((t: any) => <option key={t.id} value={t.name}>{t.name}</option>)}
                              </TextField>
                            )} />
                        </Grid>

                        <Grid item xs={12}>
                          <Divider><Typography variant="caption" color="text.secondary">Pricing (optional — auto-calculated from materials)</Typography></Divider>
                        </Grid>
                        <Grid item xs={6}>
                          <Controller name="costPrice" control={control}
                            render={({ field }) => <TextField {...field} fullWidth label="Cost Price (₹)" type="number" inputProps={{ min: 0 }}
                              helperText={lotId ? "Blank = built from the Materials and MC & VA tabs (pre-filled from the PO); if those are blank too, the bag's split by net weight" : undefined} />} />
                        </Grid>
                        <Grid item xs={6}>
                          <Controller name="sellingPrice" control={control}
                            render={({ field }) => <TextField {...field} fullWidth label="Selling Price / MRP (₹)" type="number" inputProps={{ min: 0 }} />} />
                        </Grid>
                      </Grid>

                      <Stack direction="row" spacing={2} alignItems="center" justifyContent="flex-end" sx={{ mt: 3 }}>
                        <FormControlLabel
                          control={<Checkbox checked={directPrint} onChange={(e) => setDirectPrint(e.target.checked)} />}
                          label="Print & continue"
                          title="Print the tag automatically after creating it, then jump straight back to Identity for the next one" />
                        <Button variant="contained" size="large" onClick={() => setActiveTab(1)}>
                          Next: Add Materials →
                        </Button>
                      </Stack>
                    </Box>
                  )}

                  {/* ── Tab 2: Materials ── */}
                  {activeTab === 1 && (
                    <Box sx={{ p: 3 }}>
                      <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 2 }}>
                        <Typography variant="subtitle2" fontWeight={700}>Material Line Items</Typography>
                        <Button size="small" startIcon={<Add />} onClick={addRowAndFocus}>Add Row</Button>
                      </Stack>
                      {selectedLot && activeRow && (
                        <Alert severity="info" sx={{ mb: 2 }}>
                          Cost Rate is pre-filled from the PO for {activeRow.categoryName} {activeRow.karat}
                          {activeRow.costRate != null ? ` (₹${activeRow.costRate}/g)` : ` — no rate was entered there, so the bag's average ₹${bagRatePerGram ?? '—'}/g is used`}.
                          Change it on a row if this piece differs.
                        </Alert>
                      )}

                      {/* Card + column gridlines match the look of every reference-data table in
                          Masters (see DataTable.tsx) — deliberately NOT the same component, though:
                          this grid's Tab/Enter keyboard navigation (see MATERIALS_LAST_COL below)
                          is hardcoded to a fixed column order, which DataTable's drag-to-reorder/
                          hide-columns would silently desync. Visual consistency only, same columns
                          always in the same place. */}
                      <Card variant="outlined">
                      <Box sx={{ overflowX: 'auto' }}>
                        <Table size="small" sx={{
                          tableLayout: 'fixed',
                          '& .MuiTableCell-root': { px: 1, borderRight: 1, borderColor: 'divider' },
                          '& .MuiTableCell-root:last-child': { borderRight: 0 },
                        }}>
                          <TableHead>
                            <TableRow>
                              <TableCell sx={{ width: materialColWidth('code'), position: 'relative' }}>Material Code *{colResizeHandle('code')}</TableCell>
                              <TableCell sx={{ width: materialColWidth('size'), position: 'relative' }}>Size{colResizeHandle('size')}</TableCell>
                              <TableCell sx={{ width: materialColWidth('pieces'), position: 'relative' }}>Pcs{colResizeHandle('pieces')}</TableCell>
                              <TableCell sx={{ width: materialColWidth('weight'), position: 'relative' }}>Weight *{colResizeHandle('weight')}</TableCell>
                              <TableCell sx={{ width: materialColWidth('unit'), position: 'relative' }}>Unit{colResizeHandle('unit')}</TableCell>
                              <TableCell sx={{ width: materialColWidth('costRate'), position: 'relative' }}>Cost Rate{colResizeHandle('costRate')}</TableCell>
                              <TableCell sx={{ width: materialColWidth('costAmt'), color: '#1B3280', position: 'relative' }}>Cost Amt{colResizeHandle('costAmt')}</TableCell>
                              <TableCell sx={{ width: materialColWidth('saleRate'), position: 'relative' }}>Sale Rate{colResizeHandle('saleRate')}</TableCell>
                              <TableCell sx={{ width: materialColWidth('saleAmt'), color: '#44C47A', position: 'relative' }}>Sale Amt{colResizeHandle('saleAmt')}</TableCell>
                              <TableCell sx={{ width: materialColWidth('actions') }} />
                            </TableRow>
                          </TableHead>
                          <TableBody>
                            {fields.map((field, idx) => {
                              const row = watchedMaterials[idx] ?? {};
                              // Plain Weight × Rate for now — recomputeRow already folds in any MC%/VA%
                              // markup entered on the MC & VA tab, so these two figures track the same
                              // costAmount/saleAmount that's actually sent to the server.
                              const costAmt = Number(row.costAmount || 0);
                              const saleAmt = Number(row.saleAmount || 0);
                              return (
                                <TableRow key={field.id}>
                                  <TableCell>
                                    <TextField
                                      select
                                      size="small"
                                      fullWidth
                                      SelectProps={{ native: true }}
                                      value={row.materialCodeId ? `mc:${row.materialCodeId}` : row.stoneGradeId ? `sg:${row.stoneGradeId}` : ''}
                                      onChange={(e) => {
                                        const [kind, id] = e.target.value.split(':');
                                        if (kind === 'mc') {
                                          const mc = materialCodes.find((m: any) => m.id === id);
                                          if (mc) onMaterialCodeSelect(idx, mc);
                                        } else if (kind === 'sg') {
                                          const grade = stoneGrades.find((g: any) => g.id === id);
                                          if (grade) onStoneGradeSelect(idx, grade);
                                        }
                                      }}
                                      inputRef={registerCellRef(idx, 0)}
                                      onKeyDown={handleCellKeyDown(idx, 0)}
                                    >
                                      <option value="" />
                                      <optgroup label="Materials">
                                        {materialCodes.map((o: any) => (
                                          <option key={o.id} value={`mc:${o.id}`}>{o.code}</option>
                                        ))}
                                      </optgroup>
                                      <optgroup label="Stones">
                                        {stoneGrades.map((g: any) => (
                                          <option key={g.id} value={`sg:${g.id}`}>{formatStoneGradeLabel(g)}</option>
                                        ))}
                                      </optgroup>
                                    </TextField>
                                  </TableCell>
                                  <TableCell>
                                    <Controller name={`materials.${idx}.size`} control={control}
                                      render={({ field: f }) => (
                                        <TextField {...f} size="small" placeholder="e.g. 1.5mm" sx={{ width: 64 }}
                                          inputRef={registerCellRef(idx, 1)} onKeyDown={handleCellKeyDown(idx, 1)} />
                                      )} />
                                  </TableCell>
                                  <TableCell>
                                    <Controller name={`materials.${idx}.pieces`} control={control}
                                      render={({ field: f }) => (
                                        <TextField {...f} size="small" type="number" inputProps={{ min: 1, style: { width: 40 } }}
                                          inputRef={registerCellRef(idx, 2)} onKeyDown={handleCellKeyDown(idx, 2)} />
                                      )} />
                                  </TableCell>
                                  <TableCell>
                                    <Controller name={`materials.${idx}.weight`} control={control} rules={{ required: true }}
                                      render={({ field: f }) => (
                                        <TextField {...f} size="small" type="number"
                                          inputProps={{ step: 0.001, min: 0, style: { width: 60 } }}
                                          inputRef={registerCellRef(idx, 3)} onKeyDown={handleCellKeyDown(idx, 3)}
                                          onChange={(e) => { f.onChange(e); applyStonePriceToRow(idx); recomputeRow(idx); recomputeMetalKarat(); }} />
                                      )} />
                                  </TableCell>
                                  <TableCell>
                                    <Typography variant="body2" sx={{ fontFamily: 'monospace', fontWeight: 700 }}>
                                      {row.unit || 'GM'}
                                    </Typography>
                                  </TableCell>
                                  <TableCell>
                                    <Controller name={`materials.${idx}.costRate`} control={control}
                                      render={({ field: f }) => (
                                        <TextField {...f} size="small" type="number"
                                          inputProps={{ step: 0.01, min: 0, style: { width: 72 } }}
                                          placeholder="₹/unit at buy"
                                          inputRef={registerCellRef(idx, 4)} onKeyDown={handleCellKeyDown(idx, 4)}
                                          onChange={(e) => { f.onChange(e); recomputeRow(idx); }} />
                                      )} />
                                  </TableCell>
                                  <TableCell>
                                    <Typography variant="body2" sx={{ fontFamily: 'monospace', color: '#1B3280', fontWeight: 700 }}>
                                      {costAmt > 0 ? fmtINR(costAmt) : '—'}
                                    </Typography>
                                  </TableCell>
                                  <TableCell>
                                    <Controller name={`materials.${idx}.saleRate`} control={control}
                                      render={({ field: f }) => (
                                        <TextField {...f} size="small" type="number"
                                          inputProps={{ step: 0.01, min: 0, style: { width: 72 } }}
                                          placeholder="₹/unit to sell"
                                          inputRef={registerCellRef(idx, 5)} onKeyDown={handleCellKeyDown(idx, 5)}
                                          onChange={(e) => { f.onChange(e); recomputeRow(idx); }} />
                                      )} />
                                  </TableCell>
                                  <TableCell>
                                    <Typography variant="body2" sx={{ fontFamily: 'monospace', color: '#44C47A', fontWeight: 700 }}>
                                      {saleAmt > 0 ? fmtINR(saleAmt) : '—'}
                                    </Typography>
                                  </TableCell>
                                  <TableCell>
                                    <IconButton size="small" color="error" tabIndex={-1} onClick={() => { remove(idx); recomputeMetalKarat(); }}>
                                      <Delete fontSize="small" />
                                    </IconButton>
                                  </TableCell>
                                </TableRow>
                              );
                            })}
                            {fields.length === 0 && (
                              <TableRow>
                                <TableCell colSpan={10} align="center" sx={{ py: 3, color: 'text.secondary' }}>
                                  Click "Add Row" to add material line items
                                </TableCell>
                              </TableRow>
                            )}
                          </TableBody>
                        </Table>
                      </Box>
                      <Box sx={{ px: 1.5, py: 0.75, borderTop: 1, borderColor: 'divider' }}>
                        <Typography variant="caption" color="text.secondary">{fields.length} material {fields.length === 1 ? 'line' : 'lines'}</Typography>
                      </Box>
                      </Card>

                      {fields.length > 0 && (
                        <Box sx={{ mt: 2, p: 1.5, bgcolor: 'action.hover', borderRadius: 1 }}>
                          <Grid container spacing={2}>
                            <Grid item xs={6} sm={2}>
                              <Typography variant="caption" color="text.secondary">Total Metal (Net) Wt</Typography>
                              <Typography fontWeight={700} fontFamily="monospace">{totalMetalWt.toFixed(3)} GM</Typography>
                            </Grid>
                            <Grid item xs={6} sm={2}>
                              <Typography variant="caption" color="text.secondary">Total Stone Wt</Typography>
                              <Typography fontWeight={700} fontFamily="monospace">{totalStoneWt.toFixed(3)} CT</Typography>
                            </Grid>
                            <Grid item xs={6} sm={2}>
                              <Typography variant="caption" color="text.secondary">Gross Wt (Net + Stone)</Typography>
                              <Typography fontWeight={700} fontFamily="monospace">{totalGrossWt.toFixed(3)} GM</Typography>
                            </Grid>
                            <Grid item xs={6} sm={3}>
                              <Typography variant="caption" color="text.secondary">Total Cost</Typography>
                              <Typography fontWeight={700} color="primary.main">{fmtINR(totalCostAmt)}</Typography>
                            </Grid>
                            <Grid item xs={6} sm={3}>
                              <Typography variant="caption" color="text.secondary">Total Sale</Typography>
                              <Typography fontWeight={700} color="secondary.main">{fmtINR(totalSaleAmt)}</Typography>
                            </Grid>
                          </Grid>
                        </Box>
                      )}

                      <Stack direction="row" spacing={1.5} sx={{ mt: 3 }} justifyContent="space-between">
                        <Button variant="text" onClick={() => setActiveTab(0)}>← Back</Button>
                        <Button variant="contained" size="large" onClick={() => setActiveTab(2)}>
                          Next: MC & VA →
                        </Button>
                      </Stack>
                    </Box>
                  )}

                  {/* ── Tab 3: MC & VA (making charge / value-addition wastage — tag-level, on net weight) ── */}
                  {activeTab === 2 && (
                    <Box sx={{ p: 3 }}>
                      <Grid container spacing={2}>
                        <Grid item xs={12} sm={6}>
                          <Typography variant="caption" fontWeight={700} color="#1B3280" sx={{ display: 'block', mb: 1 }}>
                            Cost (bought at)
                          </Typography>
                          <Grid container spacing={1.5}>
                            <Grid item xs={6}>
                              <Controller name="costVaPercent" control={control} render={({ field: f }) => (
                                <TextField {...f} fullWidth size="small" type="number" label="Value Addition (%)"
                                  inputProps={{ step: 0.1, min: 0 }}
                                  inputRef={registerMcVaRef('costVaPercent')} onKeyDown={handleMcVaKeyDown('costVaPercent')} />
                              )} />
                            </Grid>
                            <Grid item xs={6}>
                              <Controller name="costMcRate" control={control} render={({ field: f }) => (
                                <TextField {...f} fullWidth size="small" type="number" label="Making Charge (₹/gm)"
                                  inputProps={{ step: 0.01, min: 0 }}
                                  inputRef={registerMcVaRef('costMcRate')} onKeyDown={handleMcVaKeyDown('costMcRate')} />
                              )} />
                            </Grid>
                          </Grid>
                          <Typography variant="body2" sx={{ mt: 1 }}>
                            Making Cost Amount: <Typography component="span" fontWeight={700} color="primary.main">{fmtINR(makingCostAmount)}</Typography>
                          </Typography>
                        </Grid>

                        <Grid item xs={12} sm={6}>
                          <Typography variant="caption" fontWeight={700} color="#44C47A" sx={{ display: 'block', mb: 1 }}>
                            Sale (tag at)
                          </Typography>
                          <Grid container spacing={1.5}>
                            <Grid item xs={6}>
                              <Controller name="saleVaPercent" control={control} render={({ field: f }) => (
                                <TextField {...f} fullWidth size="small" type="number" label="Value Addition (%)"
                                  inputProps={{ step: 0.1, min: 0 }}
                                  inputRef={registerMcVaRef('saleVaPercent')} onKeyDown={handleMcVaKeyDown('saleVaPercent')} />
                              )} />
                            </Grid>
                            <Grid item xs={6}>
                              <Controller name="saleMcRate" control={control} render={({ field: f }) => (
                                <TextField {...f} fullWidth size="small" type="number" label="Making Charge (₹/gm)"
                                  inputProps={{ step: 0.01, min: 0 }}
                                  inputRef={registerMcVaRef('saleMcRate')} onKeyDown={handleMcVaKeyDown('saleMcRate')} />
                              )} />
                            </Grid>
                          </Grid>
                          <Typography variant="body2" sx={{ mt: 1 }}>
                            Making Sale Amount: <Typography component="span" fontWeight={700} color="secondary.main">{fmtINR(makingSaleAmount)}</Typography>
                          </Typography>
                        </Grid>
                      </Grid>

                      <Controller name="notes" control={control} render={({ field: f }) => (
                        <TextField {...f} fullWidth size="small" label="Notes" sx={{ mt: 2 }}
                          inputRef={registerMcVaRef('notes')} />
                      )} />

                      <Box sx={{ mt: 3, p: 1.5, bgcolor: 'action.hover', borderRadius: 1 }}>
                        <Grid container spacing={2}>
                          <Grid item xs={6} sm={2}>
                            <Typography variant="caption" color="text.secondary">Total Metal (Net) Wt</Typography>
                            <Typography fontWeight={700} fontFamily="monospace">{totalMetalWt.toFixed(3)} GM</Typography>
                          </Grid>
                          <Grid item xs={6} sm={2}>
                            <Typography variant="caption" color="text.secondary">Total Stone Wt</Typography>
                            <Typography fontWeight={700} fontFamily="monospace">{totalStoneWt.toFixed(3)} CT</Typography>
                          </Grid>
                          <Grid item xs={6} sm={2}>
                            <Typography variant="caption" color="text.secondary">Gross Wt (Net + Stone)</Typography>
                            <Typography fontWeight={700} fontFamily="monospace">{totalGrossWt.toFixed(3)} GM</Typography>
                          </Grid>
                          <Grid item xs={6} sm={3}>
                            <Typography variant="caption" color="text.secondary">Total Cost</Typography>
                            <Typography fontWeight={700} color="primary.main">{fmtINR(totalCostAmt)}</Typography>
                          </Grid>
                          <Grid item xs={6} sm={3}>
                            <Typography variant="caption" color="text.secondary">Total Sale (MRP)</Typography>
                            <Typography fontWeight={700} color="secondary.main">{fmtINR(totalSaleAmt)}</Typography>
                          </Grid>
                        </Grid>
                      </Box>

                      <Stack direction="row" spacing={1.5} sx={{ mt: 3 }} alignItems="center" justifyContent="space-between">
                        <Button variant="text" onClick={() => setActiveTab(1)}>← Back</Button>
                        <Stack direction="row" spacing={2} alignItems="center">
                          <Button type="submit" variant="contained" size="large"
                            startIcon={<AddCircleOutline />} disabled={mutation.isPending || tagLocked}>
                            {mutation.isPending ? (isEditMode ? 'Saving...' : 'Creating...') : (isEditMode ? 'Save Changes' : 'Create Tag')}
                          </Button>
                        </Stack>
                      </Stack>
                    </Box>
                  )}
                </form>
              )}
            </Card>
          </Grid>

          {/* ── Right: item photo — hidden only on the wide Materials tab so its table gets the
               full row width instead of needing to scroll sideways within a narrower column. ── */}
          {(activeTab !== 1 || createdTag) && (
            <Grid item xs={12} md={4}>
              <Typography variant="caption" color="text.secondary"
                sx={{ display: 'block', mb: 1, ml: 0.5, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 1 }}>
                Item Photo
              </Typography>
              <TagImageUpload file={tagImage} onChange={setTagImage} />
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1, ml: 0.5 }}>
                Stored locally for now — server upload wiring comes later.
              </Typography>
              <Button variant="outlined" size="small" startIcon={<ArrowBack />} sx={{ mt: 2 }}
                onClick={() => navigate('/tagging/tags')}>Back to Tags</Button>
            </Grid>
          )}
        </Grid>
        {/* The photo column is hidden on the wide Materials tab — keep the way back reachable there too. */}
        {activeTab === 1 && !createdTag && (
          <Button variant="outlined" size="small" startIcon={<ArrowBack />} sx={{ mt: 2 }}
            onClick={() => navigate('/tagging/tags')}>Back to Tags</Button>
        )}
      </Box>

      <Dialog open={manufacturerDialogOpen} onClose={() => setManufacturerDialogOpen(false)} maxWidth="sm" fullWidth>
        <form onSubmit={manufacturerForm.handleSubmit((d) => createManufacturerMutation.mutate(d))}>
          <DialogTitle fontWeight={700}>Add Manufacturer</DialogTitle>
          <DialogContent sx={{ pt: 2 }}>
            <Grid container spacing={2}>
              <Grid item xs={8}>
                <Controller name="name" control={manufacturerForm.control} rules={{ required: true }}
                  render={({ field, fieldState }) => <TextField {...field} fullWidth label="Name *" error={!!fieldState.error} />} />
              </Grid>
              <Grid item xs={4}>
                <Controller name="phone" control={manufacturerForm.control}
                  render={({ field }) => <TextField {...field} fullWidth label="Mobile Number" />} />
              </Grid>
              <Grid item xs={6}>
                <Controller name="address" control={manufacturerForm.control}
                  render={({ field }) => <TextField {...field} fullWidth label="Door No / Address" />} />
              </Grid>
              <Grid item xs={6}>
                <Controller name="gstNumber" control={manufacturerForm.control}
                  render={({ field }) => <TextField {...field} fullWidth label="GST Number" />} />
              </Grid>
              <Grid item xs={3}>
                <Controller name="city" control={manufacturerForm.control}
                  render={({ field }) => <TextField {...field} fullWidth label="City" />} />
              </Grid>
              <Grid item xs={3}>
                <Controller name="district" control={manufacturerForm.control}
                  render={({ field }) => <TextField {...field} fullWidth label="District" />} />
              </Grid>
              <Grid item xs={3}>
                <Controller name="state" control={manufacturerForm.control}
                  render={({ field }) => <TextField {...field} fullWidth label="State" />} />
              </Grid>
              <Grid item xs={3}>
                <Controller name="pincode" control={manufacturerForm.control}
                  render={({ field }) => <TextField {...field} fullWidth label="Pincode" />} />
              </Grid>
            </Grid>
          </DialogContent>
          <DialogActions sx={{ p: 2.5 }}>
            <Button onClick={() => setManufacturerDialogOpen(false)}>Cancel</Button>
            <Button type="submit" variant="contained" disabled={createManufacturerMutation.isPending}>Save Manufacturer</Button>
          </DialogActions>
        </form>
      </Dialog>
    </>
  );
}
