import { useEffect, useRef, useState } from 'react';
import {
  Box, Card, Grid, Typography, Button, Stack, Divider, Alert,
  Checkbox, FormControlLabel, TextField, Dialog, DialogTitle, DialogContent, DialogActions,
} from '@mui/material';
import JsBarcode from 'jsbarcode';
import { ArrowBack, Print, Delete, Save, ZoomIn, ZoomOut, QrCode2, Visibility } from '@mui/icons-material';
import { useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useSnackbar } from 'notistack';
import { apiGet, apiPost, apiPut } from '../../api/client';
import { PageHeader } from '../../components/common/PageHeader';
import { SelectField } from '../../components/fields/SelectField';
import { NumberField } from '../../components/fields/NumberField';
import { printTsplViaAgent } from '../../utils/printAgent';
import { printAgentSnackbarAction } from '../../utils/printAgentSnackbarAction';

// Must match server/src/shared/tsplGenerator.ts's KNOWN_BOUND_FIELDS exactly — this is the
// contract between what a template element can point at and what generateTsplForTag can resolve.
type BoundField =
  | 'tagNumber' | 'name' | 'makeType' | 'metalType' | 'metalKarat'
  | 'grossWeight' | 'netWeight' | 'stoneWeight' | 'diamondWeight' | 'colorStoneWeight' | 'stonePieces'
  | 'huid' | 'settingType'
  | 'categoryName' | 'subCategoryName' | 'collectionName' | 'stockTypeName' | 'manufacturerName'
  | 'sellingPrice' | 'saleMcRate' | 'saleVaPercent' | 'costPrice'
  | 'notes' | 'taggedDate' | 'branchName' | 'branchCode'
  | 'categoryCode' | 'subCategoryCode' | 'collectionCode' | 'stockTypeCode'
  | 'sizeName' | 'sizeCode' | 'noOfPcs' | 'status' | 'costMcRate' | 'costVaPercent' | 'netPurity';

const BOUND_FIELD_OPTIONS: { value: BoundField; label: string }[] = [
  { value: 'tagNumber', label: 'Tag Number' },
  { value: 'name', label: 'Item Name' },
  { value: 'makeType', label: 'Make Type' },
  { value: 'metalType', label: 'Metal Type' },
  { value: 'metalKarat', label: 'Metal Karat' },
  { value: 'grossWeight', label: 'Gross Weight' },
  { value: 'netWeight', label: 'Net Weight' },
  { value: 'stoneWeight', label: 'Stone Weight (total)' },
  { value: 'diamondWeight', label: 'Diamond Weight' },
  { value: 'colorStoneWeight', label: 'Colour Stone Weight' },
  { value: 'stonePieces', label: 'Stone Pieces' },
  { value: 'huid', label: 'HUID' },
  { value: 'settingType', label: 'Setting Type' },
  { value: 'categoryName', label: 'Category' },
  { value: 'subCategoryName', label: 'Sub-Category' },
  { value: 'collectionName', label: 'Collection' },
  { value: 'stockTypeName', label: 'Stock Type' },
  { value: 'manufacturerName', label: 'Manufacturer' },
  { value: 'sellingPrice', label: 'Selling Price' },
  { value: 'saleMcRate', label: 'Making Charge Rate (per g)' },
  { value: 'saleVaPercent', label: 'Wastage / VA %' },
  { value: 'costPrice', label: 'Cost Price (internal - customer will see it)' },
  { value: 'notes', label: 'Notes' },
  { value: 'taggedDate', label: 'Tagged Date' },
  { value: 'branchName', label: 'Branch Name' },
  { value: 'branchCode', label: 'Branch Code' },
  { value: 'categoryCode', label: 'Category Code' },
  { value: 'subCategoryCode', label: 'Sub-Category Code' },
  { value: 'collectionCode', label: 'Collection Code' },
  { value: 'stockTypeCode', label: 'Stock Type Code' },
  { value: 'sizeName', label: 'Size' },
  { value: 'sizeCode', label: 'Size Code' },
  { value: 'noOfPcs', label: 'No. of Pieces' },
  { value: 'status', label: 'Status' },
  { value: 'costMcRate', label: 'Cost Making Charge (per g, internal)' },
  { value: 'costVaPercent', label: 'Cost Wastage / VA % (internal)' },
  { value: 'netPurity', label: 'Karat + Net Weight' },
];

type ElementType = 'text' | 'barcode' | 'qrcode' | 'box' | 'line' | 'image';

// Must match TAG_FONT_FAMILIES in server/src/shared/tsplGenerator.ts (the server drops anything else).
const FONT_FAMILIES = [
  'Arial', 'Arial Narrow', 'Times New Roman', 'Courier New', 'Verdana', 'Tahoma',
  'Georgia', 'Calibri', 'Segoe UI', 'Trebuchet MS', 'Impact', 'Consolas',
];
const PT_TO_MM = 25.4 / 72;
const PREVIEW_ZOOM = 12; // px per mm in the preview dialog (bigger than the editing canvas)
const IMG_DOTS_PER_MM = 8; // 203 dpi head - an uploaded image is shrunk to this resolution, no bigger
type Wing = 'front' | 'back';
type FoldOrientation = 'none' | 'vertical' | 'horizontal';

// The fold line is what splits a folded tag into its front and back halves, so there are no
// separate Front/Back tabs: one canvas, and each element's wing is derived from which side of the
// fold it sits on when the template is saved (the printer itself ignores wing - it prints the
// whole strip in one pass).
interface FoldSetting { orientation: FoldOrientation; positionMm: number }

interface TemplateElement {
  id: string;
  wing: Wing;
  type: ElementType;
  xMm: number;
  yMm: number;
  widthMm?: number;
  heightMm?: number;
  boundField?: BoundField;
  literalText?: string;
  fontSize?: number;
  fontFamily?: string;
  bold?: boolean;
  italic?: boolean;
  imageData?: string;
  rotation?: 0 | 90 | 180 | 270;
  humanReadable?: boolean;
}

interface TemplateForm {
  id?: string;
  name: string;
  widthMm: number;
  heightMm: number;
  gapMm: number;
  isDefault: boolean;
  fold: FoldSetting;
  elements: TemplateElement[];
}

const BLANK_TEMPLATE: TemplateForm = {
  name: '', widthMm: 50, heightMm: 30, gapMm: 2, isDefault: false,
  fold: { orientation: 'vertical', positionMm: 25 }, elements: [],
};

function wingFor(el: TemplateElement, fold: FoldSetting): Wing {
  if (fold.orientation === 'vertical') return el.xMm < fold.positionMm ? 'front' : 'back';
  if (fold.orientation === 'horizontal') return el.yMm < fold.positionMm ? 'front' : 'back';
  return 'front';
}

const ROTATION_OPTIONS = [
  { value: '0', label: '0°' }, { value: '90', label: '90°' },
  { value: '180', label: '180°' }, { value: '270', label: '270°' },
];

function elementLabel(el: TemplateElement) {
  if (el.boundField) return `{${BOUND_FIELD_OPTIONS.find((o) => o.value === el.boundField)?.label ?? el.boundField}}`;
  return el.literalText || '(empty text)';
}

function ElementPreview({ el, zoom }: { el: TemplateElement; zoom: number }) {
  const rotation = el.rotation ?? 0;
  const transform = rotation ? { transform: `rotate(${rotation}deg)`, transformOrigin: 'top left' } : {};

  if (el.type === 'text') {
    // Font size is in points and maps straight to the printed em height (pt -> mm), the same
    // conversion the server sends the print agent - so the size you see is the size that prints.
    const emPx = Math.max(0.5, el.fontSize ?? 8) * PT_TO_MM * zoom;
    return (
      <Typography sx={{
        fontSize: emPx, lineHeight: 1.15, fontFamily: `"${el.fontFamily ?? 'Arial'}", sans-serif`,
        fontWeight: el.bold ? 700 : 400, fontStyle: el.italic ? 'italic' : 'normal',
        whiteSpace: 'nowrap', ...transform,
      }}>
        {elementLabel(el)}
      </Typography>
    );
  }
  if (el.type === 'image') {
    const w = (el.widthMm ?? 10) * zoom; const h = (el.heightMm ?? 10) * zoom;
    return el.imageData
      ? <Box component="img" src={el.imageData} draggable={false} sx={{ width: w, height: h, display: 'block', ...transform }} />
      : <Box sx={{ width: w, height: h, border: '1px dashed #888', ...transform }} />;
  }
  if (el.type === 'barcode') {
    return (
      <Box title={elementLabel(el)} sx={{
        width: 30 * zoom, height: (el.heightMm ?? 10) * zoom,
        background: 'repeating-linear-gradient(90deg,#000 0,#000 2px,transparent 2px,transparent 4px)',
        opacity: 0.8, ...transform,
      }} />
    );
  }
  if (el.type === 'qrcode') {
    const s = 15 * zoom;
    return (
      <Box title={elementLabel(el)} sx={{
        width: s, height: s, border: '1px solid', display: 'flex', alignItems: 'center', justifyContent: 'center', ...transform,
      }}>
        <QrCode2 fontSize="small" />
      </Box>
    );
  }
  if (el.type === 'box') {
    return <Box sx={{ width: (el.widthMm ?? 10) * zoom, height: (el.heightMm ?? 10) * zoom, border: '1.5px solid #000' }} />;
  }
  // line
  return <Box sx={{ width: (el.widthMm ?? 10) * zoom, height: Math.max(2, (el.heightMm ?? 0.3) * zoom), bgcolor: '#000' }} />;
}

// Real Code 128 bars at the printer's own module width (2 dots = 0.25 mm), so the preview's
// barcode is as wide as the printed one.
function PreviewBarcode({ value, heightMm, humanReadable, zoom, transform }: {
  value: string; heightMm: number; humanReadable: boolean; zoom: number; transform: object;
}) {
  const ref = useRef<SVGSVGElement>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!ref.current || !value) return;
    try {
      JsBarcode(ref.current, value, {
        format: 'CODE128', displayValue: false, margin: 0, width: 0.25 * zoom, height: heightMm * zoom,
      });
      setFailed(false);
    } catch { setFailed(true); }
  }, [value, heightMm, zoom]);
  if (!value || failed) return <Box sx={{ width: 30 * zoom, height: heightMm * zoom, border: '1px dashed #888', ...transform }} />;
  return (
    <Box sx={{ ...transform }}>
      <svg ref={ref} style={{ display: 'block' }} />
      {humanReadable && (
        <Typography sx={{ fontSize: 3 * zoom, lineHeight: 1.1, fontFamily: 'Arial, sans-serif', textAlign: 'center' }}>{value}</Typography>
      )}
    </Box>
  );
}

// One element drawn with a real tag's values — what the printed label will look like.
function PreviewElement({ el, zoom, values }: { el: TemplateElement; zoom: number; values: Record<string, string> }) {
  const rotation = el.rotation ?? 0;
  const transform = rotation ? { transform: `rotate(${rotation}deg)`, transformOrigin: 'top left' } : {};
  const content = el.boundField ? (values[el.boundField] ?? '') : (el.literalText ?? '');

  if (el.type === 'text') {
    return (
      <Typography sx={{
        fontSize: Math.max(0.5, el.fontSize ?? 8) * PT_TO_MM * zoom, lineHeight: 1.15,
        fontFamily: `"${el.fontFamily ?? 'Arial'}", sans-serif`,
        fontWeight: el.bold ? 700 : 400, fontStyle: el.italic ? 'italic' : 'normal',
        whiteSpace: 'nowrap', color: '#000', ...transform,
      }}>
        {content}
      </Typography>
    );
  }
  if (el.type === 'barcode') {
    return <PreviewBarcode value={content || values.tagNumber || ''} heightMm={el.heightMm ?? 10}
      humanReadable={el.humanReadable !== false} zoom={zoom} transform={transform} />;
  }
  if (el.type === 'qrcode') {
    // No QR encoder on the client — a labelled placeholder at the printed size (module 4 dots).
    const s = 15 * zoom;
    return (
      <Box sx={{ width: s, height: s, border: '1px solid #000', display: 'flex', alignItems: 'center', justifyContent: 'center', ...transform }}>
        <QrCode2 sx={{ fontSize: s * 0.8, color: '#000' }} />
      </Box>
    );
  }
  return <ElementPreview el={el} zoom={zoom} />;
}

// Faint label showing which half of the folded tag a region becomes.
function SideCaption({ text, sx }: { text: string; sx: object }) {
  return (
    <Typography variant="caption" sx={{
      position: 'absolute', pointerEvents: 'none', color: 'error.main', opacity: 0.6, fontWeight: 600, fontSize: 10, ...sx,
    }}>
      {text}
    </Typography>
  );
}

export function TagTemplateDesignerPage() {
  const navigate = useNavigate();
  const { enqueueSnackbar } = useSnackbar();
  const qc = useQueryClient();

  const [selectedId, setSelectedId] = useState('');
  const [form, setForm] = useState<TemplateForm>(BLANK_TEMPLATE);
  const [selectedElId, setSelectedElId] = useState<string | null>(null);
  const [zoom, setZoom] = useState(6); // px per mm — purely an on-screen editing scale
  const [testTagQuery, setTestTagQuery] = useState('');
  const [testTagId, setTestTagId] = useState('');

  const templatesQuery = useQuery({
    queryKey: ['tag-templates'],
    queryFn: () => apiGet<any[]>('/tagging/templates'),
  });

  const templateDetailQuery = useQuery({
    queryKey: ['tag-template', selectedId],
    queryFn: () => apiGet<any>(`/tagging/templates/${selectedId}`),
    enabled: !!selectedId,
  });

  useEffect(() => {
    if (!selectedId) { setForm(BLANK_TEMPLATE); setSelectedElId(null); return; }
    const t = templateDetailQuery.data;
    if (!t) return;
    const w = Number(t.widthMm); const h = Number(t.heightMm);
    const savedFold = t.layout?.fold;
    // A template saved before the fold became configurable has none - it was a vertical midline.
    const fold: FoldSetting = savedFold && ['none', 'vertical', 'horizontal'].includes(savedFold.orientation)
      ? { orientation: savedFold.orientation, positionMm: Number(savedFold.positionMm) || 0 }
      : { orientation: 'vertical', positionMm: w / 2 };
    setForm({
      id: t.id, name: t.name, widthMm: w, heightMm: h, gapMm: Number(t.gapMm),
      isDefault: t.isDefault, fold, elements: (t.layout?.elements ?? []) as TemplateElement[],
    });
    setSelectedElId(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, templateDetailQuery.data]);

  const selectedEl = form.elements.find((e) => e.id === selectedElId) ?? null;

  function updateElement(id: string, patch: Partial<TemplateElement>) {
    setForm((f) => ({ ...f, elements: f.elements.map((e) => (e.id === id ? { ...e, ...patch } : e)) }));
  }

  function addElement(type: ElementType) {
    const id = `el_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const base: TemplateElement = { id, wing: 'front', type, xMm: 5, yMm: 5 };
    if (type === 'text') Object.assign(base, { literalText: 'Text', fontSize: 8, fontFamily: 'Arial' });
    if (type === 'barcode') Object.assign(base, { boundField: 'tagNumber' as BoundField, heightMm: 10, humanReadable: true });
    if (type === 'qrcode') Object.assign(base, { boundField: 'tagNumber' as BoundField });
    if (type === 'box') Object.assign(base, { widthMm: 10, heightMm: 10 });
    if (type === 'line') Object.assign(base, { widthMm: 10, heightMm: 0.3 });
    setForm((f) => ({ ...f, elements: [...f.elements, base] }));
    setSelectedElId(id);
  }

  // Shrinks the picked file to the printer's resolution (a 15 mm logo needs ~120 px, not a 4000 px
  // photo), flattens transparency onto white, and stores it inside the template as a PNG data URL.
  function addImageFromFile(file: File) {
    if (!/^image\/(png|jpeg|gif|webp|bmp)$/.test(file.type)) { enqueueSnackbar('Choose a PNG or JPEG image', { variant: 'error' }); return; }
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const widthMm = Math.min(15, form.widthMm);
      const heightMm = Math.round((widthMm * img.height / img.width) * 10) / 10;
      const px = Math.max(8, Math.round(widthMm * IMG_DOTS_PER_MM * 2)); // 2x headroom for resizing later
      const scale = Math.min(1, px / img.width);
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(img.width * scale));
      canvas.height = Math.max(1, Math.round(img.height * scale));
      const ctx = canvas.getContext('2d');
      if (!ctx) { enqueueSnackbar('Could not read the image', { variant: 'error' }); return; }
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      const imageData = canvas.toDataURL('image/png');
      if (imageData.length > 400_000) { enqueueSnackbar('Image is too detailed - use a simpler or smaller one', { variant: 'error' }); return; }
      const id = `el_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
      setForm((f) => ({ ...f, elements: [...f.elements, { id, wing: 'front', type: 'image', xMm: 2, yMm: 2, widthMm, heightMm, imageData }] }));
      setSelectedElId(id);
    };
    img.onerror = () => { URL.revokeObjectURL(url); enqueueSnackbar('Could not read the image', { variant: 'error' }); };
    img.src = url;
  }

  function removeSelected() {
    if (!selectedElId) return;
    setForm((f) => ({ ...f, elements: f.elements.filter((e) => e.id !== selectedElId) }));
    setSelectedElId(null);
  }

  // Free-hand drag: pointer capture on the element itself, deltas measured in mm from the zoom
  // scale so the same drag distance means the same physical movement regardless of zoom level.
  const dragState = useRef<{ id: string; startX: number; startY: number; origXMm: number; origYMm: number } | null>(null);

  function onElementPointerDown(e: React.PointerEvent, el: TemplateElement) {
    e.stopPropagation();
    setSelectedElId(el.id);
    dragState.current = { id: el.id, startX: e.clientX, startY: e.clientY, origXMm: el.xMm, origYMm: el.yMm };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }
  function onElementPointerMove(e: React.PointerEvent) {
    const ds = dragState.current;
    if (!ds) return;
    const dxMm = (e.clientX - ds.startX) / zoom;
    const dyMm = (e.clientY - ds.startY) / zoom;
    const newX = Math.max(0, Math.min(form.widthMm, Math.round((ds.origXMm + dxMm) * 10) / 10));
    const newY = Math.max(0, Math.min(form.heightMm, Math.round((ds.origYMm + dyMm) * 10) / 10));
    updateElement(ds.id, { xMm: newX, yMm: newY });
  }
  function onElementPointerUp() {
    dragState.current = null;
  }

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (!form.name.trim()) throw new Error('Template name is required');
      const payload = {
        name: form.name, widthMm: form.widthMm, heightMm: form.heightMm, gapMm: form.gapMm,
        isDefault: form.isDefault,
        layout: { fold: form.fold, elements: form.elements.map((el) => ({ ...el, wing: wingFor(el, form.fold) })) },
      };
      return form.id ? apiPut<any>(`/tagging/templates/${form.id}`, payload) : apiPost<any>('/tagging/templates', payload);
    },
    onSuccess: (saved: any) => {
      enqueueSnackbar(`Template "${saved.name}" saved`, { variant: 'success' });
      qc.invalidateQueries({ queryKey: ['tag-templates'] });
      setSelectedId(saved.id);
    },
    onError: (e: any) => enqueueSnackbar(e.response?.data?.error ?? e.message ?? 'Save failed', { variant: 'error' }),
  });

  const tagSearchQuery = useQuery({
    queryKey: ['tag-search-for-print', testTagQuery],
    queryFn: () => apiGet<any[]>('/tagging/tags/search', { q: testTagQuery, status: 'ALL' }),
    enabled: testTagQuery.length >= 2 && !testTagId,
  });

  // Preview uses the layout currently on the canvas (saved or not) with the picked tag's values.
  const [previewOpen, setPreviewOpen] = useState(false);
  const previewQuery = useQuery({
    queryKey: ['tag-preview-values', testTagId],
    queryFn: () => apiGet<{ values: Record<string, string> }>(`/tagging/tags/${testTagId}/preview-values`),
    enabled: previewOpen && !!testTagId,
  });

  const testPrintMutation = useMutation({
    mutationFn: async () => {
      if (!form.id) throw new Error('Save the template before test-printing');
      if (!testTagId) throw new Error('Pick a tag to test-print with');
      const { tspl } = await apiGet<{ tspl: string }>(`/tagging/tags/${testTagId}/print`, { templateId: form.id });
      await printTsplViaAgent(tspl);
    },
    onSuccess: () => enqueueSnackbar('Test label sent to printer', { variant: 'success' }),
    onError: (e: any) => enqueueSnackbar(e.message ?? 'Test print failed', { variant: 'error', action: printAgentSnackbarAction(e) }),
  });

  return (
    <>
      <PageHeader title="Tag Label Designer"
        actions={[{ label: 'Back to Tags', icon: <ArrowBack />, onClick: () => navigate('/tagging/tags'), variant: 'outlined' as const }]} />

      <Grid container spacing={2} alignItems="flex-start">
        {/* ── Left: template picker + meta + toolbar. Sticky — otherwise scrolling down to work
             on a taller canvas/property panel pushes Save Template off the top of the screen,
             since all three columns share one page-level scroll. ── */}
        <Grid item xs={12} md={3}>
          <Card sx={{ p: 2, position: 'sticky', top: 16, maxHeight: 'calc(100vh - 100px)', overflowY: 'auto' }}>
            <Stack spacing={1.5}>
              <SelectField label="Load Template" value={selectedId} emptyLabel="+ New Template"
                options={(templatesQuery.data ?? []).map((t: any) => ({ value: t.id, label: `${t.name}${t.isDefault ? ' ★ Default' : ''}` }))}
                onChange={(e) => setSelectedId(e.target.value)} />

              <Divider />

              <TextField label="Template Name" value={form.name} fullWidth
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
              <Stack direction="row" spacing={1}>
                <NumberField label="Width (mm)" value={form.widthMm}
                  onChange={(e) => setForm((f) => ({ ...f, widthMm: Number(e.target.value) }))} />
                <NumberField label="Height (mm)" value={form.heightMm}
                  onChange={(e) => setForm((f) => ({ ...f, heightMm: Number(e.target.value) }))} />
              </Stack>
              <NumberField label="Gap Between Labels (mm)" value={form.gapMm}
                onChange={(e) => setForm((f) => ({ ...f, gapMm: Number(e.target.value) }))} />
              <FormControlLabel
                control={<Checkbox checked={form.isDefault} onChange={(e) => setForm((f) => ({ ...f, isDefault: e.target.checked }))} />}
                label="Default template (used when printing without picking one)" />

              <Button variant="contained" startIcon={<Save />} disabled={saveMutation.isPending} onClick={() => saveMutation.mutate()}>
                {saveMutation.isPending ? 'Saving…' : 'Save Template'}
              </Button>

              <Divider />

              <Typography variant="subtitle2">Add Element</Typography>
              <Stack direction="row" flexWrap="wrap" gap={1}>
                <Button size="small" variant="outlined" onClick={() => addElement('text')}>+ Text</Button>
                <Button size="small" variant="outlined" onClick={() => addElement('barcode')}>+ Barcode</Button>
                <Button size="small" variant="outlined" onClick={() => addElement('qrcode')}>+ QR Code</Button>
                <Button size="small" variant="outlined" onClick={() => addElement('box')}>+ Box</Button>
                <Button size="small" variant="outlined" onClick={() => addElement('line')}>+ Line</Button>
                <Button size="small" variant="outlined" component="label">+ Image
                  <input type="file" hidden accept="image/png,image/jpeg,image/gif,image/webp,image/bmp"
                    onChange={(e) => { const f = e.target.files?.[0]; if (f) addImageFromFile(f); e.target.value = ''; }} />
                </Button>
              </Stack>
            </Stack>
          </Card>
        </Grid>

        {/* ── Center: wing tabs + canvas. minWidth:0 stops a large/zoomed canvas from forcing
             this flex column wider than its share, which would push the right panel off-screen. ── */}
        <Grid item xs={12} md={6} sx={{ minWidth: 0 }}>
          <Card sx={{ p: 2 }}>
            <Stack direction="row" alignItems="center" justifyContent="space-between" flexWrap="wrap" gap={1} sx={{ mb: 1 }}>
              <Stack direction="row" alignItems="center" spacing={1} flexWrap="wrap">
                <SelectField label="Fold Line" value={form.fold.orientation} size="small" sx={{ width: 170 }}
                  options={[
                    { value: 'vertical', label: 'Vertical (left | right)' },
                    { value: 'horizontal', label: 'Horizontal (top / bottom)' },
                    { value: 'none', label: 'None (single side)' },
                  ]}
                  onChange={(e) => {
                    const orientation = e.target.value as FoldOrientation;
                    setForm((f) => ({
                      ...f,
                      fold: { orientation, positionMm: orientation === 'horizontal' ? f.heightMm / 2 : f.widthMm / 2 },
                    }));
                  }} />
                {form.fold.orientation !== 'none' && (
                  <>
                    <NumberField label={form.fold.orientation === 'vertical' ? 'Fold at X (mm)' : 'Fold at Y (mm)'}
                      value={form.fold.positionMm} size="small" sx={{ width: 130 }}
                      onChange={(e) => {
                        const max = form.fold.orientation === 'vertical' ? form.widthMm : form.heightMm;
                        const v = Math.max(0, Math.min(max, Number(e.target.value) || 0));
                        setForm((f) => ({ ...f, fold: { ...f.fold, positionMm: v } }));
                      }} />
                    <Button size="small" onClick={() => setForm((f) => ({
                      ...f,
                      fold: { ...f.fold, positionMm: (f.fold.orientation === 'vertical' ? f.widthMm : f.heightMm) / 2 },
                    }))}>Centre</Button>
                  </>
                )}
              </Stack>
              <Stack direction="row" alignItems="center" spacing={1}>
                <Button size="small" onClick={() => setZoom((z) => Math.max(3, z - 1))} startIcon={<ZoomOut />}>Zoom</Button>
                <Typography variant="caption" sx={{ minWidth: 48, textAlign: 'center' }}>{zoom} px/mm</Typography>
                <Button size="small" onClick={() => setZoom((z) => Math.min(12, z + 1))} startIcon={<ZoomIn />}>Zoom</Button>
              </Stack>
            </Stack>

            <Box sx={{ overflow: 'auto', maxHeight: 'calc(100vh - 220px)', p: 2, bgcolor: 'action.hover', borderRadius: 1 }}>
              <Box
                onPointerMove={onElementPointerMove}
                onPointerUp={onElementPointerUp}
                onClick={() => setSelectedElId(null)}
                sx={{
                  position: 'relative', width: form.widthMm * zoom, height: form.heightMm * zoom,
                  bgcolor: '#fff', border: '2px solid', borderColor: 'divider', boxShadow: 1, mx: 'auto',
                }}
              >
                {form.fold.orientation === 'vertical' && (
                  <>
                    <Box sx={{
                      position: 'absolute', top: 0, bottom: 0, left: form.fold.positionMm * zoom,
                      borderLeft: '2px dashed', borderColor: 'error.main', pointerEvents: 'none',
                    }} />
                    <SideCaption text="FRONT" sx={{ left: 4, top: 2 }} />
                    <SideCaption text="BACK" sx={{ left: form.fold.positionMm * zoom + 4, top: 2 }} />
                  </>
                )}
                {form.fold.orientation === 'horizontal' && (
                  <>
                    <Box sx={{
                      position: 'absolute', left: 0, right: 0, top: form.fold.positionMm * zoom,
                      borderTop: '2px dashed', borderColor: 'error.main', pointerEvents: 'none',
                    }} />
                    <SideCaption text="FRONT" sx={{ left: 4, top: 2 }} />
                    <SideCaption text="BACK" sx={{ left: 4, top: form.fold.positionMm * zoom + 2 }} />
                  </>
                )}
                {form.elements.map((el) => (
                  <Box
                    key={el.id}
                    onPointerDown={(e) => onElementPointerDown(e, el)}
                    onClick={(e) => e.stopPropagation()}
                    sx={{
                      position: 'absolute', left: el.xMm * zoom, top: el.yMm * zoom,
                      cursor: 'move', userSelect: 'none', touchAction: 'none',
                      outline: selectedElId === el.id ? '2px solid' : 'none',
                      outlineColor: 'primary.main', outlineOffset: 1,
                    }}
                  >
                    <ElementPreview el={el} zoom={zoom} />
                  </Box>
                ))}
              </Box>
            </Box>
            <Typography variant="caption" color="text.secondary">
              Drag an element to reposition it, or edit X/Y precisely in the panel on the right. The dashed fold line
              splits the tag into front and back; move it with "Fold at". This is a layout
              preview, not the exact thermal-printer render — always confirm alignment with a real test print.
            </Typography>
          </Card>
        </Grid>

        {/* ── Right: element properties + test print. Sticky, same reasoning as the left panel. ── */}
        <Grid item xs={12} md={3}>
          <Card sx={{ p: 2, position: 'sticky', top: 16, maxHeight: 'calc(100vh - 100px)', overflowY: 'auto' }}>
            <Stack spacing={1.5}>
              <Typography variant="subtitle2">Element Properties</Typography>
              {selectedEl ? (
                <>
                  <Typography variant="caption" color="text.secondary">{selectedEl.type.toUpperCase()}</Typography>
                  <Stack direction="row" spacing={1}>
                    <NumberField label="X (mm)" value={selectedEl.xMm}
                      onChange={(e) => updateElement(selectedEl.id, { xMm: Number(e.target.value) })} />
                    <NumberField label="Y (mm)" value={selectedEl.yMm}
                      onChange={(e) => updateElement(selectedEl.id, { yMm: Number(e.target.value) })} />
                  </Stack>

                  {selectedEl.type === 'text' && (
                    <SelectField label="Bound Field" value={selectedEl.boundField ?? ''} emptyLabel="None (literal text)"
                      options={BOUND_FIELD_OPTIONS}
                      onChange={(e) => updateElement(selectedEl.id, { boundField: (e.target.value || undefined) as BoundField | undefined })} />
                  )}
                  {(selectedEl.type === 'barcode' || selectedEl.type === 'qrcode') && (
                    <SelectField label="Bound Field" value={selectedEl.boundField ?? 'tagNumber'}
                      options={BOUND_FIELD_OPTIONS}
                      onChange={(e) => updateElement(selectedEl.id, { boundField: e.target.value as BoundField })} />
                  )}
                  {selectedEl.type === 'text' && !selectedEl.boundField && (
                    <TextField label="Literal Text" fullWidth value={selectedEl.literalText ?? ''}
                      onChange={(e) => updateElement(selectedEl.id, { literalText: e.target.value })} />
                  )}
                  {selectedEl.type === 'text' && (
                    <>
                      <SelectField label="Font" value={selectedEl.fontFamily ?? 'Arial'}
                        options={FONT_FAMILIES.map((f) => ({ value: f, label: f }))}
                        onChange={(e) => updateElement(selectedEl.id, { fontFamily: e.target.value })} />
                      <NumberField label="Font Size (pt)" value={selectedEl.fontSize ?? 8}
                        onChange={(e) => updateElement(selectedEl.id, { fontSize: Number(e.target.value) })} />
                      <Stack direction="row">
                        <FormControlLabel label="Bold"
                          control={<Checkbox checked={!!selectedEl.bold} onChange={(e) => updateElement(selectedEl.id, { bold: e.target.checked })} />} />
                        <FormControlLabel label="Italic"
                          control={<Checkbox checked={!!selectedEl.italic} onChange={(e) => updateElement(selectedEl.id, { italic: e.target.checked })} />} />
                      </Stack>
                    </>
                  )}
                  {(selectedEl.type === 'text' || selectedEl.type === 'barcode' || selectedEl.type === 'qrcode' || selectedEl.type === 'image') && (
                    <SelectField label="Rotation" value={String(selectedEl.rotation ?? 0)} options={ROTATION_OPTIONS}
                      onChange={(e) => updateElement(selectedEl.id, { rotation: Number(e.target.value) as 0 | 90 | 180 | 270 })} />
                  )}
                  {selectedEl.type === 'barcode' && (
                    <>
                      <NumberField label="Height (mm)" value={selectedEl.heightMm ?? 10}
                        onChange={(e) => updateElement(selectedEl.id, { heightMm: Number(e.target.value) })} />
                      <FormControlLabel
                        control={<Checkbox checked={selectedEl.humanReadable !== false}
                          onChange={(e) => updateElement(selectedEl.id, { humanReadable: e.target.checked })} />}
                        label="Human-readable text under barcode" />
                    </>
                  )}
                  {(selectedEl.type === 'box' || selectedEl.type === 'line' || selectedEl.type === 'image') && (
                    <Stack direction="row" spacing={1}>
                      <NumberField label="Width (mm)" value={selectedEl.widthMm ?? 10}
                        onChange={(e) => updateElement(selectedEl.id, { widthMm: Number(e.target.value) })} />
                      <NumberField label="Height (mm)" value={selectedEl.heightMm ?? (selectedEl.type === 'line' ? 0.3 : 10)}
                        onChange={(e) => updateElement(selectedEl.id, { heightMm: Number(e.target.value) })} />
                    </Stack>
                  )}

                  <Button color="error" variant="outlined" startIcon={<Delete />} onClick={removeSelected}>Delete Element</Button>
                </>
              ) : (
                <Typography variant="body2" color="text.secondary">
                  Select an element on the canvas (or add one on the left) to edit its properties.
                </Typography>
              )}

              <Divider />

              <Typography variant="subtitle2">Test Print</Typography>
              {!form.id && <Alert severity="info" sx={{ fontSize: 12 }}>Save the template first to test-print.</Alert>}
              <TextField label="Search tag (number / name / HUID)" fullWidth size="small"
                value={testTagQuery}
                onChange={(e) => { setTestTagQuery(e.target.value); setTestTagId(''); }} />
              {tagSearchQuery.data && tagSearchQuery.data.length > 0 && !testTagId && (
                <Box sx={{ maxHeight: 160, overflowY: 'auto', border: '1px solid', borderColor: 'divider', borderRadius: 1 }}>
                  {tagSearchQuery.data.map((t: any) => (
                    <Box key={t.id} onClick={() => { setTestTagId(t.id); setTestTagQuery(`${t.tagNumber} — ${t.name}`); }}
                      sx={{ p: 1, cursor: 'pointer', '&:hover': { bgcolor: 'action.hover' } }}>
                      <Typography variant="body2">{t.tagNumber} — {t.name}</Typography>
                    </Box>
                  ))}
                </Box>
              )}
              <Button variant="outlined" startIcon={<Visibility />} disabled={!testTagId}
                onClick={() => setPreviewOpen(true)}>
                Preview Label
              </Button>
              <Button variant="contained" color="secondary" startIcon={<Print />}
                disabled={!form.id || !testTagId || testPrintMutation.isPending}
                onClick={() => testPrintMutation.mutate()}>
                {testPrintMutation.isPending ? 'Printing…' : 'Send Test Print'}
              </Button>
            </Stack>
          </Card>
        </Grid>
      </Grid>

      <Dialog open={previewOpen} onClose={() => setPreviewOpen(false)} maxWidth="lg" fullWidth>
        <DialogTitle>Label Preview — {testTagQuery}</DialogTitle>
        <DialogContent>
          {previewQuery.isLoading && <Typography>Loading…</Typography>}
          {previewQuery.isError && <Alert severity="error">Could not load the tag's values.</Alert>}
          {previewQuery.data && (
            <Box sx={{ overflow: 'auto', p: 2, bgcolor: 'action.hover', borderRadius: 1 }}>
              <Box sx={{
                position: 'relative', width: form.widthMm * PREVIEW_ZOOM, height: form.heightMm * PREVIEW_ZOOM,
                bgcolor: '#fff', border: '1px solid #999', boxShadow: 1, mx: 'auto', overflow: 'hidden',
              }}>
                {form.elements.map((el) => (
                  <Box key={el.id} sx={{ position: 'absolute', left: el.xMm * PREVIEW_ZOOM, top: el.yMm * PREVIEW_ZOOM }}>
                    <PreviewElement el={el} zoom={PREVIEW_ZOOM} values={previewQuery.data.values} />
                  </Box>
                ))}
              </Box>
            </Box>
          )}
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
            Shows the layout currently on the canvas (saved or not) filled with this tag's real values. Fonts follow
            your PC's installed fonts and the QR code is a placeholder — the printer output may differ slightly.
          </Typography>
        </DialogContent>
        <DialogActions><Button onClick={() => setPreviewOpen(false)}>Close</Button></DialogActions>
      </Dialog>
    </>
  );
}
