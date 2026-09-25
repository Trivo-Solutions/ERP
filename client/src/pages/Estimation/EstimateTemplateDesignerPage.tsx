import { useEffect, useRef, useState } from 'react';
import {
  Box, Card, Grid, Typography, Button, Stack, Divider, Alert,
  Checkbox, FormControlLabel, TextField, IconButton,
} from '@mui/material';
import {
  ArrowBack, Print, Delete, Save, ZoomIn, ZoomOut, ArrowUpward, ArrowDownward,
  KeyboardDoubleArrowUp, KeyboardDoubleArrowDown,
} from '@mui/icons-material';
import { useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useSnackbar } from 'notistack';
import { apiGet, apiPost, apiPut } from '../../api/client';
import { PageHeader } from '../../components/common/PageHeader';
import { SelectField } from '../../components/fields/SelectField';
import { NumberField } from '../../components/fields/NumberField';
import { printTagEstimate } from '../../utils/printTagEstimate';
import {
  EstimateTemplateElement, EstimateElementType, EstimateTableColumn, EstimateTableColumnField,
  EstimateTextAlign, EstimateTableBorderStyle, EstimateBoundField,
  BOUND_FIELD_OPTIONS, ALL_TABLE_COLUMNS, DEFAULT_TEMPLATE_WIDTH_MM, DEFAULT_TEMPLATE_HEIGHT_MM,
  MM_PER_PT, COMMON_FONT_SIZES_PT, computeTableWidthMm, formatEstimateDate,
} from '../../types/estimateTemplate';

const ALIGN_OPTIONS: { value: EstimateTextAlign; label: string }[] = [
  { value: 'left', label: 'Left' },
  { value: 'center', label: 'Center' },
  { value: 'right', label: 'Right' },
];

const BORDER_STYLE_OPTIONS: { value: EstimateTableBorderStyle; label: string }[] = [
  { value: 'bottomOnly', label: 'Bottom rule only (header + rows)' },
  { value: 'all', label: 'Full grid (every cell boxed)' },
];

interface TemplateForm {
  id?: string;
  name: string;
  isDefault: boolean;
  widthMm: number;
  heightMm: number;
  elements: EstimateTemplateElement[];
}

// Defaults to a common thermal-receipt roll width (80mm) rather than A4 — paper size is fully
// editable below since the real printer may be a narrow continuous-roll unit (e.g. Epson POS),
// not a sheet-fed one.
const BLANK_TEMPLATE: TemplateForm = {
  name: '', isDefault: false,
  widthMm: DEFAULT_TEMPLATE_WIDTH_MM, heightMm: DEFAULT_TEMPLATE_HEIGHT_MM,
  elements: [],
};

// A date-bound field showing its own field name in the canvas ("{Generated On}") reads like a
// second kind of placeholder syntax next to every other field's literal sample value below, which
// was confusing while designing — is that curly-brace text going to print literally? A field's
// "{Label}" is short and generic no matter what it's bound to, while its real printed value can be
// much longer (an item's name-plus-code, a branch name) or a completely different shape (a ₹
// amount, a percentage) — designing against the label instead of a realistic value is exactly how
// a layout that looked "neatly packed" on canvas turned out wider/taller once real data landed in
// it at print time. One representative sample per field, close in shape and length to a typical
// real value, so what you see while placing an element is what it'll actually look like.
const DATE_BOUND_FIELDS = new Set<EstimateBoundField>(['generatedOn', 'validUntil', 'printDate']);

const SAMPLE_BOUND_VALUES: Partial<Record<EstimateBoundField, string>> = {
  tagNumber: 'SNEC00002',
  itemName: 'NEC',
  metalKarat: '22K',
  grossWeight: '40.000 g',
  netWeight: '38.000 g',
  stoneWeight: '2.000 ct',
  branchName: 'Main Branch',
  estimateNumber: 'EST-2026-K3F9X2',
  totalSaleAmount: '₹5,58,040.00',
  makingChargeAmount: '₹18,000.00',
  saleMcRate: '₹450.00',
  saleVaPercent: '8%',
  taxRate: '3%',
  gstAmount: '₹16,741.20',
  netPayableAmount: '₹5,74,781.20',
  huid: 'HUID12AB34CD',
  metalType: 'GOLD',
  makeType: 'GOLD',
  mrp: '₹5,58,040.00',
  notes: 'Advance paid, balance on delivery',
  currency: 'INR',
};

function elementLabel(el: EstimateTemplateElement) {
  if (el.type === 'materialsTable') return 'Materials Table';
  if (el.boundField && DATE_BOUND_FIELDS.has(el.boundField)) return formatEstimateDate(new Date());
  if (el.boundField && SAMPLE_BOUND_VALUES[el.boundField]) return SAMPLE_BOUND_VALUES[el.boundField]!;
  if (el.boundField) return `{${BOUND_FIELD_OPTIONS.find((o) => o.value === el.boundField)?.label ?? el.boundField}}`;
  return el.literalText || '(empty text)';
}

const SAMPLE_ROWS = [
  { name: 'Sample Material A', weight: '9.500', unit: 'GM', saleRate: '5,500.00', saleAmount: '52,250.00' },
  { name: 'Sample Material B', weight: '0.500', unit: 'CT', saleRate: '18,000.00', saleAmount: '9,000.00' },
];

// Appended after SAMPLE_ROWS when a table has Show MC/VA Rows on — same two rows
// printTagEstimate.ts adds for real, just with representative numbers instead of computed ones.
const SAMPLE_CHARGE_ROWS = [
  { name: 'MC', weight: '', unit: '', saleRate: '450.00/g', saleAmount: '18,000.00' },
  { name: 'VA', weight: '', unit: '', saleRate: '8.00%', saleAmount: '4,180.00' },
];

function ElementPreview({ el, zoom, pageWidthMm }: { el: EstimateTemplateElement; zoom: number; pageWidthMm: number }) {
  if (el.type === 'text') {
    // pt → mm (the same physical conversion the print renderer uses) → on-screen px at the
    // canvas's current mm-per-px zoom, so the preview's text size tracks the real printed size
    // exactly, not an arbitrary on-screen approximation.
    const fontSizePx = (el.fontSize ?? 12) * MM_PER_PT * zoom;
    // A Wrap Width set explicitly wraps at exactly that. Left unset (the common case for a short
    // literal label), it's capped at the remaining page width from this element's own x position
    // instead of running unbounded — the same safety net printTagEstimate.ts applies, so a bound
    // field whose real value turns out long (an item name, say) wraps here too rather than only
    // being discovered at print time, clipped invisibly against the page edge.
    const wrapSx = el.widthMm != null
      ? { width: el.widthMm * zoom, whiteSpace: 'normal' as const, wordBreak: 'break-word' as const }
      : { maxWidth: Math.max(5, pageWidthMm - el.xMm) * zoom, whiteSpace: 'normal' as const, wordBreak: 'break-word' as const };
    return (
      <Typography sx={{ fontSize: fontSizePx, fontFamily: 'Arial, sans-serif', textAlign: el.align ?? 'left', ...wrapSx }}>
        {elementLabel(el)}
      </Typography>
    );
  }
  if (el.type === 'box') {
    return <Box sx={{ width: (el.widthMm ?? 10) * zoom, height: (el.heightMm ?? 10) * zoom, border: '1.5px solid #000' }} />;
  }
  if (el.type === 'line') {
    return <Box sx={{ width: (el.widthMm ?? 10) * zoom, height: Math.max(2, (el.heightMm ?? 0.3) * zoom), bgcolor: '#000' }} />;
  }
  if (el.type === 'barcode') {
    // A real barcode is only rendered at print time (see printTagEstimate.ts's JsBarcode call) —
    // this is just a visual approximation so the designer doesn't need a live library call on
    // every keystroke while positioning it.
    return (
      <Box sx={{ width: (el.widthMm ?? 40) * zoom, height: (el.heightMm ?? 15) * zoom, display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
        <Box sx={{
          flex: 1, width: '100%',
          background: 'repeating-linear-gradient(90deg,#000 0,#000 2px,transparent 2px,transparent 4px)',
          opacity: 0.85,
        }} />
        {el.humanReadable !== false && (
          <Typography sx={{ fontSize: Math.max(6, 8 * zoom * 0.4), fontFamily: 'monospace' }}>
            {elementLabel(el)}
          </Typography>
        )}
      </Box>
    );
  }
  if (el.type === 'image') {
    const widthPx = (el.widthMm ?? 30) * zoom;
    const heightPx = (el.heightMm ?? 30) * zoom;
    if (!el.imageDataUrl) {
      return (
        <Box sx={{
          width: widthPx, height: heightPx, border: '1px dashed', borderColor: 'divider',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <Typography variant="caption" color="text.secondary">No image</Typography>
        </Box>
      );
    }
    return <Box component="img" src={el.imageDataUrl} sx={{ width: widthPx, height: heightPx, objectFit: 'contain' }} />;
  }
  // materialsTable — every size below (column widths, header/row font) is converted through the
  // exact same mm→px path printTagEstimate.ts's real output uses (colgroup width in mm, font-size
  // in pt), not an independent on-screen approximation, so this footprint IS what will print, not
  // just a resemblance of it. The caption that used to sit inside this Box ("Sample rows — actual
  // count follows the estimate") was itself part of what made the designer's footprint taller than
  // the real table — it's now the properties-panel note below instead of on-canvas ink.
  const columns = el.columns ?? [];
  const widthMm = computeTableWidthMm(el.columns, el.widthMm ?? 180);
  const widthPx = widthMm * zoom;
  const headerFontSize = el.headerFontSize ?? 8;
  const rowFontSize = el.rowFontSize ?? 9;
  const allBorders = el.borderStyle === 'all';
  const headerBorder = allBorders ? '1px solid #333' : 'none';
  const headerBorderBottom = '1.5px solid #333';
  const cellBorder = allBorders ? '1px solid #ccc' : 'none';
  const cellBorderBottom = '1px solid #eee';
  const rows = el.includeChargeRows ? [...SAMPLE_ROWS, ...SAMPLE_CHARGE_ROWS] : SAMPLE_ROWS;
  return (
    <Box sx={{ width: widthPx, outline: '1px dashed', outlineColor: 'divider', outlineOffset: 1 }}>
      <table style={{ width: '100%', tableLayout: 'fixed', borderCollapse: 'collapse' }}>
        <colgroup>{columns.map((c) => <col key={c.field} style={{ width: c.widthMm * zoom }} />)}</colgroup>
        <thead>
          <tr>{columns.map((c) => (
            <th key={c.field} style={{
              textAlign: c.field === 'name' ? 'left' : 'right', border: headerBorder, borderBottom: headerBorderBottom,
              padding: '2px 4px', fontSize: (c.fontSize ?? headerFontSize) * MM_PER_PT * zoom, textTransform: 'uppercase', letterSpacing: '0.03em',
              whiteSpace: 'normal', wordBreak: 'break-word',
            }}>{c.label}</th>
          ))}</tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i}>{columns.map((c) => (
              <td key={c.field} style={{
                textAlign: c.field === 'name' ? 'left' : 'right', border: cellBorder, borderBottom: cellBorderBottom,
                padding: '2px 4px', fontSize: (c.fontSize ?? rowFontSize) * MM_PER_PT * zoom, whiteSpace: 'normal', wordBreak: 'break-word',
              }}>
                {(row as any)[c.field]}
              </td>
            ))}</tr>
          ))}
        </tbody>
      </table>
    </Box>
  );
}

export function EstimateTemplateDesignerPage() {
  const navigate = useNavigate();
  const { enqueueSnackbar } = useSnackbar();
  const qc = useQueryClient();

  const [selectedId, setSelectedId] = useState('');
  const [form, setForm] = useState<TemplateForm>(BLANK_TEMPLATE);
  const [selectedElId, setSelectedElId] = useState<string | null>(null);
  const [zoom, setZoom] = useState(3); // px per mm — on-screen editing scale only
  const [testTagQuery, setTestTagQuery] = useState('');
  const [testTagId, setTestTagId] = useState('');
  // The "Table Width (mm)" field displays a DERIVED number (sum of columns) and its onChange
  // rescales every column proportionally — if that rescale fired on every keystroke (as a plain
  // controlled value would), typing "150" would recompute after the "1", snap the displayed value
  // to whatever that rescale rounds to, and then "5"/"0" would land on the snapped value instead of
  // the "1" you typed, making the field un-typeable. This buffers what you're typing separately and
  // only commits (rescales the real columns) once you're done, on blur or Enter.
  const [tableWidthDraft, setTableWidthDraft] = useState<string | null>(null);

  const templatesQuery = useQuery({
    queryKey: ['estimate-templates'],
    queryFn: () => apiGet<any[]>('/estimation/templates'),
  });

  const templateDetailQuery = useQuery({
    queryKey: ['estimate-template', selectedId],
    queryFn: () => apiGet<any>(`/estimation/templates/${selectedId}`),
    enabled: !!selectedId,
  });

  useEffect(() => {
    if (!selectedId) { setForm(BLANK_TEMPLATE); setSelectedElId(null); return; }
    const t = templateDetailQuery.data;
    if (!t) return;
    setForm({
      id: t.id, name: t.name, isDefault: t.isDefault,
      widthMm: Number(t.widthMm), heightMm: Number(t.heightMm),
      elements: (t.layout?.elements ?? []) as EstimateTemplateElement[],
    });
    setSelectedElId(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, templateDetailQuery.data]);

  const selectedEl = form.elements.find((e) => e.id === selectedElId) ?? null;

  // Selecting a different element (or the same one after some other action changed its columns)
  // discards any in-progress Table Width typing rather than carrying it over onto the wrong table.
  useEffect(() => { setTableWidthDraft(null); }, [selectedElId]);

  function updateElement(id: string, patch: Partial<EstimateTemplateElement>) {
    setForm((f) => ({ ...f, elements: f.elements.map((e) => (e.id === id ? { ...e, ...patch } : e)) }));
  }

  function addElement(type: EstimateElementType) {
    const id = `el_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    // Every new element used to land at a fixed (10, 10) — the second text/box/etc you added sat
    // exactly on top of the first, invisible until you dragged one away. Cascades diagonally by
    // 8mm per existing element instead (wrapping every 6 steps so it doesn't walk off a narrow
    // template), the same "paste offset" convention PowerPoint/Photoshop use for new shapes.
    const cascade = form.elements.length % 6;
    const xMm = Math.min(Math.max(10, form.widthMm - 20), 10 + cascade * 8);
    const yMm = Math.min(Math.max(10, form.heightMm - 20), 10 + cascade * 8);
    const base: EstimateTemplateElement = { id, type, xMm, yMm };
    if (type === 'text') Object.assign(base, { literalText: 'Text', fontSize: 12 });
    if (type === 'box') Object.assign(base, { widthMm: 10, heightMm: 10 });
    if (type === 'line') Object.assign(base, { widthMm: 10, heightMm: 0.3 });
    if (type === 'materialsTable') {
      // ALL_TABLE_COLUMNS' default widths (180mm total) were sized for A4 — on a narrow
      // continuous-roll receipt template (this designer's own new-template default is 80mm) that
      // would hang far off the right edge of the page immediately on add. Scale every column
      // proportionally to fit the current paper width (minus a small margin either side) instead,
      // capped at the original defaults so a wide A4-style template is unaffected.
      const marginMm = base.xMm * 2;
      const availableMm = Math.max(20, form.widthMm - marginMm);
      const totalDefaultMm = ALL_TABLE_COLUMNS.reduce((s, c) => s + c.defaultWidthMm, 0);
      const scale = Math.min(1, availableMm / totalDefaultMm);
      const columns = ALL_TABLE_COLUMNS.map((c) => ({
        field: c.field, label: c.defaultLabel, widthMm: Math.max(8, Math.round(c.defaultWidthMm * scale)),
      }));
      Object.assign(base, {
        widthMm: columns.reduce((s, c) => s + c.widthMm, 0), columns,
        headerFontSize: 8, rowFontSize: 9, borderStyle: 'bottomOnly',
        // On by default for a brand-new table — MC/VA rows in the table are the intended way to
        // show them now, not a separate bound-field text element. A template saved before this
        // existed simply has no includeChargeRows key at all, so it's unaffected.
        includeChargeRows: true,
      });
    }
    if (type === 'barcode') Object.assign(base, { boundField: 'tagNumber', widthMm: 40, heightMm: 15, humanReadable: true });
    if (type === 'image') Object.assign(base, { widthMm: 20, heightMm: 20 });
    setForm((f) => ({ ...f, elements: [...f.elements, base] }));
    setSelectedElId(id);
  }

  function removeSelected() {
    if (!selectedElId) return;
    setForm((f) => ({ ...f, elements: f.elements.filter((e) => e.id !== selectedElId) }));
    setSelectedElId(null);
  }

  // Stacking order is just array order — later in `elements` paints later, i.e. on top. These are
  // the layers-panel equivalent of "bring forward"/"send backward"/"to front"/"to back": with
  // several overlapping elements (now unavoidable once two land near the same spot — see the
  // cascade in addElement above), this is how you pick which one wins visually without having to
  // drag the loser out of the way first.
  function moveElementZ(id: string, direction: -1 | 1) {
    setForm((f) => {
      const i = f.elements.findIndex((e) => e.id === id);
      const j = i + direction;
      if (i < 0 || j < 0 || j >= f.elements.length) return f;
      const elements = [...f.elements];
      [elements[i], elements[j]] = [elements[j], elements[i]];
      return { ...f, elements };
    });
  }

  function moveElementToEdge(id: string, toFront: boolean) {
    setForm((f) => {
      const i = f.elements.findIndex((e) => e.id === id);
      if (i < 0) return f;
      const elements = [...f.elements];
      const [el] = elements.splice(i, 1);
      if (toFront) elements.push(el); else elements.unshift(el);
      return { ...f, elements };
    });
  }

  // Every column mutation recomputes the element's own widthMm as sum(columns) in the same call —
  // never left for a later render to reconcile. Before this, adding/removing a column left widthMm
  // stale (still whatever it was when the table was first created), so the outer footprint and the
  // sum of visible columns silently drifted apart — the exact "table moving/cutting out on canvas"
  // symptom, since the outer Box (and the overflow-past-page check) trusted that stale number.
  function setColumns(columns: EstimateTableColumn[]) {
    if (!selectedEl) return;
    updateElement(selectedEl.id, { columns, widthMm: computeTableWidthMm(columns, selectedEl.widthMm) });
  }

  function toggleColumn(field: EstimateTableColumnField, include: boolean) {
    if (!selectedEl) return;
    const existing = selectedEl.columns ?? [];
    if (include) {
      const def = ALL_TABLE_COLUMNS.find((c) => c.field === field)!;
      setColumns([...existing, { field, label: def.defaultLabel, widthMm: def.defaultWidthMm }]);
    } else {
      setColumns(existing.filter((c) => c.field !== field));
    }
  }

  function updateColumn(field: EstimateTableColumnField, patch: Partial<{ label: string; widthMm: number; fontSize: number | undefined }>) {
    if (!selectedEl) return;
    setColumns((selectedEl.columns ?? []).map((c) => (c.field === field ? { ...c, ...patch } : c)));
  }

  function moveColumn(field: EstimateTableColumnField, direction: -1 | 1) {
    if (!selectedEl) return;
    const cols = [...(selectedEl.columns ?? [])];
    const i = cols.findIndex((c) => c.field === field);
    const j = i + direction;
    if (i < 0 || j < 0 || j >= cols.length) return;
    [cols[i], cols[j]] = [cols[j], cols[i]];
    setColumns(cols);
  }

  // Rescales every included column proportionally so their widths still sum to the requested total
  // — the "Table Width (mm)" field's own onChange, since the element's widthMm is otherwise always
  // a derived readout (see setColumns above), not something you can just overwrite directly without
  // it disagreeing with its columns again on the very next column edit.
  function fitColumnsToWidth(targetMm: number) {
    if (!selectedEl || targetMm <= 0) return;
    const cols = selectedEl.columns ?? [];
    const currentMm = computeTableWidthMm(cols, targetMm);
    if (!cols.length || currentMm <= 0) return;
    const scale = targetMm / currentMm;
    setColumns(cols.map((c) => ({ ...c, widthMm: Math.max(8, Math.round(c.widthMm * scale)) })));
  }

  // Free-hand drag: pointer capture on the element (or its resize handle), deltas measured in mm
  // from the zoom scale so the same drag distance means the same physical movement regardless of
  // zoom level. One state/handler pair covers both moving (drag the body) and resizing (drag a
  // handle) — they differ only in which fields the pointer delta gets applied to.
  const dragState = useRef<{
    id: string; startX: number; startY: number; mode: 'move' | 'resize-x' | 'resize-xy';
    origXMm: number; origYMm: number; origWidthMm: number; origHeightMm: number;
  } | null>(null);

  function onElementPointerDown(e: React.PointerEvent, el: EstimateTemplateElement) {
    e.stopPropagation();
    setSelectedElId(el.id);
    dragState.current = {
      id: el.id, startX: e.clientX, startY: e.clientY, mode: 'move',
      origXMm: el.xMm, origYMm: el.yMm, origWidthMm: el.widthMm ?? 0, origHeightMm: el.heightMm ?? 0,
    };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }

  // materialsTable only renders against its widthMm (rows auto-flow), so it only gets a width
  // handle; text has no stored height at all (font-size drives it), same treatment. box/line get a
  // corner handle since both dimensions are real and used.
  function onResizeHandlePointerDown(e: React.PointerEvent, el: EstimateTemplateElement, mode: 'resize-x' | 'resize-xy') {
    e.stopPropagation();
    setSelectedElId(el.id);
    const fallbackWidth = el.type === 'text' ? 40 : el.type === 'materialsTable' ? 60 : 10;
    dragState.current = {
      id: el.id, startX: e.clientX, startY: e.clientY, mode,
      origXMm: el.xMm, origYMm: el.yMm,
      origWidthMm: el.widthMm ?? fallbackWidth,
      origHeightMm: el.heightMm ?? (el.type === 'line' ? 0.3 : 10),
    };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }

  function onElementPointerMove(e: React.PointerEvent) {
    const ds = dragState.current;
    if (!ds) return;
    const dxMm = (e.clientX - ds.startX) / zoom;
    const dyMm = (e.clientY - ds.startY) / zoom;
    if (ds.mode === 'move') {
      const newX = Math.max(0, Math.min(form.widthMm, Math.round((ds.origXMm + dxMm) * 10) / 10));
      const newY = Math.max(0, Math.min(form.heightMm, Math.round((ds.origYMm + dyMm) * 10) / 10));
      updateElement(ds.id, { xMm: newX, yMm: newY });
    } else {
      const newWidth = Math.max(2, Math.round((ds.origWidthMm + dxMm) * 10) / 10);
      const patch: Partial<EstimateTemplateElement> = { widthMm: newWidth };
      if (ds.mode === 'resize-xy') {
        patch.heightMm = Math.max(0.2, Math.round((ds.origHeightMm + dyMm) * 10) / 10);
      }
      updateElement(ds.id, patch);
    }
  }
  function onElementPointerUp() {
    dragState.current = null;
  }

  // Whether an element's own footprint runs past the paper's right edge — the exact "table (or
  // anything else) is going past the page" symptom, flagged red so it's visible without opening
  // the properties panel, on top of the resize handle that fixes it.
  function overflowsPage(el: EstimateTemplateElement) {
    const widthMm = el.type === 'materialsTable' ? computeTableWidthMm(el.columns, el.widthMm) : el.widthMm;
    return widthMm != null && el.xMm + widthMm > form.widthMm;
  }

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (!form.name.trim()) throw new Error('Template name is required');
      if (!form.widthMm || !form.heightMm) throw new Error('Paper width and height are required');
      const payload = {
        name: form.name, isDefault: form.isDefault,
        widthMm: form.widthMm, heightMm: form.heightMm,
        layout: { elements: form.elements },
      };
      return form.id ? apiPut<any>(`/estimation/templates/${form.id}`, payload) : apiPost<any>('/estimation/templates', payload);
    },
    onSuccess: (saved: any) => {
      enqueueSnackbar(`Template "${saved.name}" saved`, { variant: 'success' });
      qc.invalidateQueries({ queryKey: ['estimate-templates'] });
      setSelectedId(saved.id);
    },
    onError: (e: any) => enqueueSnackbar(e.response?.data?.error ?? e.message ?? 'Save failed', { variant: 'error' }),
  });

  const tagSearchQuery = useQuery({
    queryKey: ['estimate-template-tag-search', testTagQuery],
    queryFn: () => apiGet<any[]>('/estimation/tags/search', { q: testTagQuery }),
    enabled: testTagQuery.length >= 2 && !testTagId,
  });

  const previewMutation = useMutation({
    mutationFn: async () => {
      if (!testTagId) throw new Error('Pick a tag to preview with');
      const tag = await apiGet<any>(`/estimation/tags/${testTagId}`);
      const items = (tag.materials ?? []).map((m: any) => ({
        code: m.code, materialType: m.materialType, name: m.code || m.materialCode?.name || m.name,
        weight: Number(m.weight), unit: m.unit,
        saleRate: Number(m.saleRate ?? 0), saleAmount: Number(m.saleRate ?? 0) * Number(m.weight),
      }));
      const totalSaleAmount = items.reduce((s: number, i: any) => s + i.saleAmount, 0);
      // Same indicative-3%-INR convention as estimation.service.ts's createTagEstimate — a
      // preview should show the same GST/Net Payable numbers a real save would produce, not a
      // synthetic estimate missing those fields entirely (which resolved as ₹0.00 before this).
      const taxRate = 0.03;
      const gstAmount = Math.round(totalSaleAmount * taxRate * 100) / 100;
      const netPayableAmount = totalSaleAmount + gstAmount;
      const previewEstimate = {
        estimateNumber: 'EST-PREVIEW', createdAt: new Date().toISOString(), validUntil: null,
        saleMcRate: 0, saleVaPercent: 0, totalSaleAmount, taxRate, gstAmount, netPayableAmount, items,
        currency: 'INR', notes: 'Preview only — not a saved estimate',
      };
      printTagEstimate({ layout: { elements: form.elements }, widthMm: form.widthMm, heightMm: form.heightMm }, tag, previewEstimate);
    },
    onError: (e: any) => enqueueSnackbar(e.message ?? 'Preview failed', { variant: 'error' }),
  });

  return (
    <>
      {/* Font Size autocompletes to Word's own standard point sizes, same idea as Word's font-size
          combo box — still a free-typed number underneath, this only suggests common values. */}
      <datalist id="estimate-font-sizes">
        {COMMON_FONT_SIZES_PT.map((pt) => <option key={pt} value={pt} />)}
      </datalist>
      <PageHeader title="Estimate Template Designer"
        subtitle="Design the printed layout used for every customer estimate"
        breadcrumbs={[{ label: 'Estimation', path: '/estimation' }, { label: 'Estimate Templates' }]}
        actions={[{ label: 'Back to Estimation', icon: <ArrowBack />, onClick: () => navigate('/estimation'), variant: 'outlined' as const }]} />

      <Grid container spacing={2} alignItems="flex-start">
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
                <NumberField label="Paper Width (mm)" value={form.widthMm}
                  onChange={(e) => setForm((f) => ({ ...f, widthMm: Number(e.target.value) }))} />
                <NumberField label="Paper Height (mm)" value={form.heightMm}
                  onChange={(e) => setForm((f) => ({ ...f, heightMm: Number(e.target.value) }))} />
              </Stack>
              <Typography variant="caption" color="text.secondary">
                E.g. 80mm for a continuous-roll thermal/receipt printer (Epson POS), or 210×297 for A4.
                This Height only sizes the design canvas below — the real printout always fits itself
                to that estimate's actual content instead, so a one-item plain-gold-ring estimate
                prints short with whatever you've placed below the table sitting right under that
                one row, and a ten-item estimate on the same template prints taller with everything
                below the table pushed down to clear it.
              </Typography>
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
                <Button size="small" variant="outlined" onClick={() => addElement('box')}>+ Box</Button>
                <Button size="small" variant="outlined" onClick={() => addElement('line')}>+ Line</Button>
                <Button size="small" variant="outlined" onClick={() => addElement('materialsTable')}>+ Materials Table</Button>
                <Button size="small" variant="outlined" onClick={() => addElement('barcode')}>+ Barcode</Button>
                <Button size="small" variant="outlined" onClick={() => addElement('image')}>+ Image</Button>
              </Stack>

              <Divider />

              <Stack direction="row" justifyContent="space-between" alignItems="center">
                <Typography variant="subtitle2">Layers ({form.elements.length})</Typography>
                {selectedElId && (
                  <Stack direction="row" spacing={0.5}>
                    <IconButton size="small" title="Bring to front" onClick={() => moveElementToEdge(selectedElId, true)}>
                      <KeyboardDoubleArrowUp fontSize="small" />
                    </IconButton>
                    <IconButton size="small" title="Send to back" onClick={() => moveElementToEdge(selectedElId, false)}>
                      <KeyboardDoubleArrowDown fontSize="small" />
                    </IconButton>
                  </Stack>
                )}
              </Stack>
              <Box sx={{ maxHeight: 240, overflowY: 'auto', border: '1px solid', borderColor: 'divider', borderRadius: 1 }}>
                {form.elements.length === 0 && (
                  <Typography variant="caption" color="text.secondary" sx={{ p: 1, display: 'block' }}>
                    No elements yet — add one above.
                  </Typography>
                )}
                {[...form.elements].reverse().map((el, displayIdx) => {
                  const isFront = displayIdx === 0;
                  const isBack = displayIdx === form.elements.length - 1;
                  return (
                    <Stack key={el.id} direction="row" alignItems="center" spacing={0.5}
                      onClick={() => setSelectedElId(el.id)}
                      sx={{
                        p: 0.75, cursor: 'pointer', borderBottom: '1px solid', borderColor: 'divider',
                        bgcolor: selectedElId === el.id ? 'action.selected' : 'transparent',
                        '&:hover': { bgcolor: 'action.hover' },
                      }}
                    >
                      <Box sx={{ flex: 1, minWidth: 0 }}>
                        <Typography variant="body2" noWrap>{elementLabel(el)}</Typography>
                        <Typography variant="caption" color="text.secondary">{el.type}</Typography>
                      </Box>
                      <IconButton size="small" disabled={isFront} onClick={(e) => { e.stopPropagation(); moveElementZ(el.id, 1); }}>
                        <ArrowUpward fontSize="inherit" />
                      </IconButton>
                      <IconButton size="small" disabled={isBack} onClick={(e) => { e.stopPropagation(); moveElementZ(el.id, -1); }}>
                        <ArrowDownward fontSize="inherit" />
                      </IconButton>
                    </Stack>
                  );
                })}
              </Box>
            </Stack>
          </Card>
        </Grid>

        <Grid item xs={12} md={6} sx={{ minWidth: 0 }}>
          <Card sx={{ p: 2 }}>
            <Stack direction="row" alignItems="center" justifyContent="space-between" flexWrap="wrap" gap={1} sx={{ mb: 1 }}>
              <Typography variant="subtitle2" color="text.secondary">{form.widthMm}mm × {form.heightMm}mm</Typography>
              <Stack direction="row" alignItems="center" spacing={1}>
                <Button size="small" onClick={() => setZoom((z) => Math.max(2, z - 1))} startIcon={<ZoomOut />}>Zoom</Button>
                <Typography variant="caption" sx={{ minWidth: 48, textAlign: 'center' }}>{zoom} px/mm</Typography>
                <Button size="small" onClick={() => setZoom((z) => Math.min(6, z + 1))} startIcon={<ZoomIn />}>Zoom</Button>
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
                  // Clips anything positioned past the physical page edge — this IS what print does
                  // too (content past the @page width is cut off, not visible on a wider "virtual"
                  // canvas), so an overflowing element now visibly disappears off the edge here
                  // instead of floating past the white page over the grey background, which read as
                  // the element randomly "moving" or "cutting out" rather than as an overflow.
                  overflow: 'hidden',
                }}
              >
                {form.elements.map((el) => {
                  const overflow = overflowsPage(el);
                  const resizeMode: 'resize-x' | 'resize-xy' | null =
                    el.type === 'box' || el.type === 'line' || el.type === 'barcode' || el.type === 'image' ? 'resize-xy' :
                    el.type === 'text' || el.type === 'materialsTable' ? 'resize-x' : null;
                  return (
                    <Box
                      key={el.id}
                      onPointerDown={(e) => onElementPointerDown(e, el)}
                      onClick={(e) => e.stopPropagation()}
                      sx={{
                        position: 'absolute', left: el.xMm * zoom, top: el.yMm * zoom,
                        cursor: 'move', userSelect: 'none', touchAction: 'none',
                        outline: overflow || selectedElId === el.id ? '2px solid' : 'none',
                        outlineColor: overflow ? 'error.main' : 'primary.main', outlineOffset: 1,
                      }}
                    >
                      <ElementPreview el={el} zoom={zoom} pageWidthMm={form.widthMm} />
                      {selectedElId === el.id && resizeMode && (
                        <Box
                          data-testid="resize-handle"
                          onPointerDown={(e) => onResizeHandlePointerDown(e, el, resizeMode)}
                          sx={{
                            position: 'absolute', right: -6, bottom: resizeMode === 'resize-xy' ? -6 : undefined,
                            top: resizeMode === 'resize-x' ? '50%' : undefined,
                            transform: resizeMode === 'resize-x' ? 'translateY(-50%)' : undefined,
                            width: 10, height: 10, borderRadius: '50%',
                            bgcolor: 'primary.main', border: '1.5px solid #fff',
                            cursor: resizeMode === 'resize-xy' ? 'nwse-resize' : 'ew-resize',
                            touchAction: 'none',
                          }}
                        />
                      )}
                    </Box>
                  );
                })}
              </Box>
            </Box>
            <Typography variant="caption" color="text.secondary">
              Drag an element to reposition it, or edit X/Y precisely in the panel on the right.
              Select an element and drag its blue handle to resize it (outlined red here if it runs
              past the paper's right edge).
            </Typography>
            {form.elements.some(overflowsPage) && (
              <Alert severity="warning" sx={{ mt: 1, fontSize: 12 }}>
                One or more elements (outlined red) run past the {form.widthMm}mm paper width —
                select it and drag its resize handle, or narrow its Width field, to bring it back on.
              </Alert>
            )}
          </Card>
        </Grid>

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
                      onChange={(e) => updateElement(selectedEl.id, { boundField: (e.target.value || undefined) as any })} />
                  )}
                  {selectedEl.type === 'text' && !selectedEl.boundField && (
                    <TextField label="Literal Text" fullWidth value={selectedEl.literalText ?? ''}
                      onChange={(e) => updateElement(selectedEl.id, { literalText: e.target.value })} />
                  )}
                  {selectedEl.type === 'text' && (
                    <NumberField label="Font Size (pt)" value={selectedEl.fontSize ?? 12}
                      inputProps={{ list: 'estimate-font-sizes', step: 0.5 }}
                      onChange={(e) => updateElement(selectedEl.id, { fontSize: Number(e.target.value) })} />
                  )}
                  {selectedEl.type === 'text' && (
                    <NumberField label="Wrap Width (mm, 0 = auto)" value={selectedEl.widthMm ?? 0}
                      onChange={(e) => {
                        const v = Number(e.target.value);
                        updateElement(selectedEl.id, { widthMm: v > 0 ? v : undefined });
                      }} />
                  )}
                  {selectedEl.type === 'text' && (
                    <SelectField label="Align" value={selectedEl.align ?? 'left'}
                      options={ALIGN_OPTIONS}
                      onChange={(e) => updateElement(selectedEl.id, { align: e.target.value as EstimateTextAlign })} />
                  )}
                  {selectedEl.type === 'text' && !selectedEl.widthMm && (
                    <Typography variant="caption" color="text.secondary">
                      Align only has a visible effect once Wrap Width above is set — a 0/auto box has no room to align within.
                    </Typography>
                  )}

                  {(selectedEl.type === 'box' || selectedEl.type === 'line') && (
                    <Stack direction="row" spacing={1}>
                      <NumberField label="Width (mm)" value={selectedEl.widthMm ?? 10}
                        onChange={(e) => updateElement(selectedEl.id, { widthMm: Number(e.target.value) })} />
                      <NumberField label="Height (mm)" value={selectedEl.heightMm ?? (selectedEl.type === 'line' ? 0.3 : 10)}
                        onChange={(e) => updateElement(selectedEl.id, { heightMm: Number(e.target.value) })} />
                    </Stack>
                  )}

                  {selectedEl.type === 'materialsTable' && (
                    <>
                      <NumberField label="Table Width (mm)"
                        value={tableWidthDraft ?? computeTableWidthMm(selectedEl.columns, selectedEl.widthMm ?? 180)}
                        onChange={(e) => setTableWidthDraft(e.target.value)}
                        onBlur={() => {
                          const v = Number(tableWidthDraft);
                          if (tableWidthDraft != null && tableWidthDraft !== '' && v > 0) fitColumnsToWidth(v);
                          setTableWidthDraft(null);
                        }}
                        onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />
                      <Typography variant="caption" color="text.secondary">
                        Always the sum of the column widths below — type a new total and tab/click away (or press Enter) to rescale every included column proportionally to it, so it can never silently disagree with them again.
                      </Typography>
                      <Stack direction="row" spacing={1}>
                        <NumberField label="Header Font (pt)" value={selectedEl.headerFontSize ?? 8}
                          inputProps={{ list: 'estimate-font-sizes', step: 0.5 }}
                          onChange={(e) => updateElement(selectedEl.id, { headerFontSize: Number(e.target.value) })} />
                        <NumberField label="Row Font (pt)" value={selectedEl.rowFontSize ?? 9}
                          inputProps={{ list: 'estimate-font-sizes', step: 0.5 }}
                          onChange={(e) => updateElement(selectedEl.id, { rowFontSize: Number(e.target.value) })} />
                      </Stack>
                      <SelectField label="Borders" value={selectedEl.borderStyle ?? 'bottomOnly'}
                        options={BORDER_STYLE_OPTIONS}
                        onChange={(e) => updateElement(selectedEl.id, { borderStyle: e.target.value as EstimateTableBorderStyle })} />
                      <FormControlLabel
                        control={<Checkbox checked={!!selectedEl.includeChargeRows}
                          onChange={(e) => updateElement(selectedEl.id, { includeChargeRows: e.target.checked })} />}
                        label="Show MC / VA rows in table" />
                      {selectedEl.includeChargeRows && (
                        <Typography variant="caption" color="text.secondary">
                          Adds an "MC" row (Rate as ₹/g, from the estimate's own MC rate) and a "VA"
                          row (Rate as %) after the real material rows — the same MC/VA an estimate
                          already lets staff edit, just shown in the table instead of a separate
                          text element.
                        </Typography>
                      )}
                      <Divider />
                      <Typography variant="caption" color="text.secondary">
                        Columns — only the ones checked print at all; each cell shows exactly its
                        field's value (e.g. a code, a weight) with no extra text, so unchecking one
                        removes it completely rather than leaving something unwanted behind. Font
                        (pt) is per-column — leave it blank to inherit the table's Header/Row Font
                        above, or set one to shrink just that column (e.g. a tight Amount column)
                        without affecting the rest.
                      </Typography>
                      {(selectedEl.columns ?? []).map((current, idx) => (
                        <Box key={current.field} sx={{ border: '1px solid', borderColor: 'divider', borderRadius: 1, p: 1, mb: 1 }}>
                          <Stack direction="row" spacing={0.5} alignItems="center">
                            <Stack>
                              <IconButton size="small" disabled={idx === 0} onClick={() => moveColumn(current.field, -1)}>
                                <ArrowUpward fontSize="inherit" />
                              </IconButton>
                              <IconButton size="small" disabled={idx === (selectedEl.columns?.length ?? 0) - 1} onClick={() => moveColumn(current.field, 1)}>
                                <ArrowDownward fontSize="inherit" />
                              </IconButton>
                            </Stack>
                            <TextField size="small" label="Label" fullWidth value={current.label}
                              onChange={(e) => updateColumn(current.field, { label: e.target.value })} />
                            <IconButton size="small" onClick={() => toggleColumn(current.field, false)}>
                              <Delete fontSize="inherit" />
                            </IconButton>
                          </Stack>
                          <Stack direction="row" spacing={1} sx={{ mt: 1, pl: 4.5 }}>
                            <NumberField size="small" label="Width (mm)" value={current.widthMm}
                              onChange={(e) => updateColumn(current.field, { widthMm: Number(e.target.value) })} />
                            <NumberField size="small" label="Font (pt)" value={current.fontSize ?? ''}
                              placeholder={String(selectedEl.headerFontSize ?? 8)}
                              inputProps={{ list: 'estimate-font-sizes', step: 0.5 }}
                              onChange={(e) => {
                                const v = e.target.value;
                                updateColumn(current.field, { fontSize: v === '' ? undefined : Number(v) });
                              }} />
                          </Stack>
                        </Box>
                      ))}
                      <Stack direction="row" flexWrap="wrap" gap={1}>
                        {ALL_TABLE_COLUMNS.filter((c) => !(selectedEl.columns ?? []).some((cur) => cur.field === c.field)).map((candidate) => (
                          <Button key={candidate.field} size="small" variant="outlined" onClick={() => toggleColumn(candidate.field, true)}>
                            + {candidate.defaultLabel}
                          </Button>
                        ))}
                      </Stack>
                    </>
                  )}

                  {selectedEl.type === 'barcode' && (
                    <>
                      <SelectField label="Encodes" value={selectedEl.boundField ?? 'tagNumber'}
                        options={BOUND_FIELD_OPTIONS.filter((o) => o.value === 'tagNumber' || o.value === 'estimateNumber')}
                        onChange={(e) => updateElement(selectedEl.id, { boundField: e.target.value as any })} />
                      <Stack direction="row" spacing={1}>
                        <NumberField label="Width (mm)" value={selectedEl.widthMm ?? 40}
                          onChange={(e) => updateElement(selectedEl.id, { widthMm: Number(e.target.value) })} />
                        <NumberField label="Height (mm)" value={selectedEl.heightMm ?? 15}
                          onChange={(e) => updateElement(selectedEl.id, { heightMm: Number(e.target.value) })} />
                      </Stack>
                      <FormControlLabel
                        control={<Checkbox checked={selectedEl.humanReadable !== false}
                          onChange={(e) => updateElement(selectedEl.id, { humanReadable: e.target.checked })} />}
                        label="Show value as text under barcode" />
                    </>
                  )}

                  {selectedEl.type === 'image' && (
                    <>
                      <Button component="label" variant="outlined" size="small">
                        {selectedEl.imageDataUrl ? 'Replace Image…' : 'Choose Image…'}
                        <input type="file" accept="image/*" hidden
                          onChange={(e) => {
                            const file = e.target.files?.[0];
                            if (!file) return;
                            const reader = new FileReader();
                            reader.onload = () => updateElement(selectedEl.id, { imageDataUrl: String(reader.result) });
                            reader.readAsDataURL(file);
                          }} />
                      </Button>
                      <Typography variant="caption" color="text.secondary">
                        Stored directly in this template (e.g. a company logo) — no separate upload, works offline.
                      </Typography>
                      <Stack direction="row" spacing={1}>
                        <NumberField label="Width (mm)" value={selectedEl.widthMm ?? 20}
                          onChange={(e) => updateElement(selectedEl.id, { widthMm: Number(e.target.value) })} />
                        <NumberField label="Height (mm)" value={selectedEl.heightMm ?? 20}
                          onChange={(e) => updateElement(selectedEl.id, { heightMm: Number(e.target.value) })} />
                      </Stack>
                    </>
                  )}

                  <Button color="error" variant="outlined" startIcon={<Delete />} onClick={removeSelected}>Delete Element</Button>
                </>
              ) : (
                <Typography variant="body2" color="text.secondary">
                  Select an element on the canvas (or add one on the left) to edit its properties.
                </Typography>
              )}

              <Divider />

              <Typography variant="subtitle2">Preview</Typography>
              {!form.elements.length && <Alert severity="info" sx={{ fontSize: 12 }}>Add at least one element to preview.</Alert>}
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
              <Button variant="contained" color="secondary" startIcon={<Print />}
                disabled={!testTagId || !form.elements.length || previewMutation.isPending}
                onClick={() => previewMutation.mutate()}>
                {previewMutation.isPending ? 'Opening…' : 'Preview Print'}
              </Button>
            </Stack>
          </Card>
        </Grid>
      </Grid>
    </>
  );
}
