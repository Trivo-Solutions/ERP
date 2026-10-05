import { useEffect, useRef, useState } from 'react';
import {
  Box, Card, Grid, Typography, Button, Stack, Divider, Alert, Checkbox, FormControlLabel, TextField, IconButton,
} from '@mui/material';
import {
  ArrowBack, Print, Delete, Save, ZoomIn, ZoomOut, ArrowUpward, ArrowDownward, ContentCopy, AutoFixHigh,
  KeyboardDoubleArrowUp, KeyboardDoubleArrowDown,
} from '@mui/icons-material';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useSnackbar } from 'notistack';
import { apiGet, apiPost, apiPut } from '../../api/client';
import { PageHeader } from '../../components/common/PageHeader';
import { SelectField } from '../../components/fields/SelectField';
import { NumberField } from '../../components/fields/NumberField';
import { useAuthStore } from '../../store/auth.store';
import { printTaxInvoiceTemplate } from '../../utils/printTaxInvoiceTemplate';
import { sampleTableRows, sampleInvoiceForPreview } from '../../utils/taxInvoiceData';
import {
  TaxInvoiceTemplateElement, TaxInvoiceElementType, TaxInvoiceTableColumn, TaxInvoiceTableKind,
  TaxInvoiceTextAlign, TaxInvoiceTableBorderStyle, TaxInvoiceDesignerLayout,
  TAX_INVOICE_FIELD_MAP, taxInvoiceFieldGroups, TABLE_KIND_OPTIONS, TABLE_COLUMN_CATALOG, PAGE_PRESETS,
  DEFAULT_PAGE_WIDTH_MM, DEFAULT_PAGE_HEIGHT_MM, MM_PER_PT, COMMON_FONT_SIZES_PT,
  buildStandardLayout, computeTableWidthMm, defaultColumns, scaleColumnsTo, isDesignerLayout,
} from '../../types/taxInvoiceTemplate';

const ALIGN_OPTIONS: { value: TaxInvoiceTextAlign; label: string }[] = [
  { value: 'left', label: 'Left' }, { value: 'center', label: 'Center' }, { value: 'right', label: 'Right' },
];
const BORDER_OPTIONS: { value: TaxInvoiceTableBorderStyle; label: string }[] = [
  { value: 'all', label: 'Full grid (every cell boxed)' },
  { value: 'bottomOnly', label: 'Row rules only' },
  { value: 'none', label: 'No borders' },
];

const FIELD_GROUPS = taxInvoiceFieldGroups();
const FIELD_OPTGROUPS = FIELD_GROUPS.map((g) => ({ label: g.label, options: g.fields.map((f) => ({ value: f.key, label: f.label })) }));
// Barcodes encode a short code-like value, not an amount or an address.
const BARCODE_FIELDS = ['invoice.number', 'buyer.code', 'seller.gstin', 'einvoice.irn', 'einvoice.ackNumber'];
const BARCODE_OPTIONS = BARCODE_FIELDS.map((k) => ({ value: k, label: TAX_INVOICE_FIELD_MAP.get(k)?.label ?? k }));

interface TemplateForm {
  id?: string;
  name: string;
  description: string;
  branchId: string;
  isDefault: boolean;
  isActive: boolean;
  page: { widthMm: number; heightMm: number };
  copiesText: string; // one copy label per line
  elements: TaxInvoiceTemplateElement[];
}

function blankForm(): TemplateForm {
  const std = buildStandardLayout();
  return {
    name: '', description: '', branchId: '', isDefault: false, isActive: true,
    page: std.page, copiesText: '', elements: std.elements,
  };
}

const sampleOf = (key: string, noSymbol?: boolean) => {
  const v = TAX_INVOICE_FIELD_MAP.get(key)?.sample ?? `{${key}}`;
  return noSymbol ? v.replace(/^₹\s*/, '') : v;
};

function elementLabel(el: TaxInvoiceTemplateElement) {
  if (el.type === 'table') return `${TABLE_KIND_OPTIONS.find((o) => o.value === el.tableKind)?.label.split(' (')[0] ?? 'Table'} table`;
  if (el.type === 'qrcode') return 'e-Invoice QR code';
  if (el.type === 'image') return 'Image';
  if (el.type === 'box') return 'Box';
  if (el.type === 'line') return 'Line';
  if (el.type === 'barcode') return `Barcode: ${sampleOf(el.boundField ?? 'invoice.number')}`;
  if (el.boundField) return sampleOf(el.boundField, el.noCurrencySymbol);
  const text = (el.literalText ?? '').replace(/\{\{\s*([A-Za-z0-9_.]+)\s*\}\}/g, (_m, k: string) => sampleOf(k, el.noCurrencySymbol));
  return text || '(empty text)';
}

function ElementPreview({ el, zoom, pageWidthMm }: { el: TaxInvoiceTemplateElement; zoom: number; pageWidthMm: number }) {
  if (el.type === 'text') {
    const fontSizePx = (el.fontSize ?? 9) * MM_PER_PT * zoom;
    const wrapSx = el.widthMm != null
      ? { width: el.widthMm * zoom }
      : { maxWidth: Math.max(5, pageWidthMm - el.xMm) * zoom };
    return (
      <Typography component="div" sx={{
        fontSize: fontSizePx, fontFamily: 'Arial, sans-serif', textAlign: el.align ?? 'left', lineHeight: 1.2,
        whiteSpace: 'pre-wrap', overflowWrap: 'break-word', color: el.color ?? '#000',
        fontWeight: el.bold ? 700 : 400, fontStyle: el.italic ? 'italic' : 'normal',
        textTransform: el.uppercase ? 'uppercase' : 'none', ...wrapSx,
      }}>
        {elementLabel(el)}
      </Typography>
    );
  }
  if (el.type === 'box') {
    return <Box sx={{ width: (el.widthMm ?? 10) * zoom, height: (el.heightMm ?? 10) * zoom, border: '1px solid #000', bgcolor: el.fillColor ?? 'transparent' }} />;
  }
  if (el.type === 'line') {
    return <Box sx={{ width: (el.widthMm ?? 10) * zoom, height: Math.max(1, (el.heightMm ?? 0.3) * zoom), bgcolor: '#000' }} />;
  }
  if (el.type === 'barcode') {
    return (
      <Box sx={{ width: (el.widthMm ?? 40) * zoom, height: (el.heightMm ?? 12) * zoom, display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
        <Box sx={{ flex: 1, width: '100%', background: 'repeating-linear-gradient(90deg,#000 0,#000 2px,transparent 2px,transparent 4px)', opacity: 0.85 }} />
        {el.humanReadable !== false && (
          <Typography sx={{ fontSize: Math.max(6, 8 * zoom * 0.4), fontFamily: 'monospace' }}>{sampleOf(el.boundField ?? 'invoice.number')}</Typography>
        )}
      </Box>
    );
  }
  if (el.type === 'qrcode') {
    return (
      <Box sx={{
        width: (el.widthMm ?? 22) * zoom, height: (el.heightMm ?? 22) * zoom, border: '1px solid #000',
        background: 'repeating-conic-gradient(#000 0% 25%, #fff 0% 50%) 50% / 12% 12%',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        <Typography sx={{ fontSize: 9, bgcolor: '#fff', px: 0.5 }}>QR</Typography>
      </Box>
    );
  }
  if (el.type === 'image') {
    const w = (el.widthMm ?? 30) * zoom; const h = (el.heightMm ?? 30) * zoom;
    if (!el.imageDataUrl) {
      return (
        <Box sx={{ width: w, height: h, border: '1px dashed', borderColor: 'divider', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <Typography variant="caption" color="text.secondary">No image</Typography>
        </Box>
      );
    }
    return <Box component="img" src={el.imageDataUrl} sx={{ width: w, height: h, objectFit: 'contain' }} />;
  }
  // table
  const kind = el.tableKind ?? 'items';
  const columns = el.columns ?? [];
  const widthMm = computeTableWidthMm(columns, el.widthMm ?? 190);
  const hf = el.headerFontSize ?? 7.5; const rf = el.rowFontSize ?? 8;
  const style = el.borderStyle ?? 'all';
  const cellBorder = style === 'all' ? '1px solid #444' : 'none';
  const cellBottom = style === 'none' ? 'none' : style === 'bottomOnly' ? '1px solid #bbb' : '1px solid #444';
  const rows = sampleTableRows(kind, columns, kind === 'items' ? 3 : 2);
  const reservedPx = (el.heightMm ?? 30) * zoom;
  return (
    <Box sx={{ width: widthMm * zoom, height: reservedPx, overflow: 'hidden', outline: '1px dashed', outlineColor: 'divider', bgcolor: '#fff' }}>
      <table style={{ width: '100%', tableLayout: 'fixed', borderCollapse: 'collapse', height: '100%' }}>
        <colgroup>{columns.map((c) => <col key={c.field} style={{ width: c.widthMm * zoom }} />)}</colgroup>
        <thead>
          <tr>{columns.map((c) => (
            <th key={c.field} style={{
              textAlign: c.align ?? 'left', border: cellBorder, borderBottom: style === 'none' ? 'none' : '1px solid #444',
              background: el.headerFill ? '#eee' : 'transparent', padding: '1px 3px', fontWeight: 700,
              fontSize: (c.fontSize ?? hf) * MM_PER_PT * zoom, whiteSpace: 'normal', wordBreak: 'break-word', verticalAlign: 'top',
            }}>{c.label}</th>
          ))}</tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i}>{row.map((v, j) => (
              <td key={j} style={{
                textAlign: columns[j].align ?? 'left', border: cellBorder, borderBottom: cellBottom, padding: '1px 3px',
                fontSize: (columns[j].fontSize ?? rf) * MM_PER_PT * zoom, whiteSpace: 'pre-line', wordBreak: 'break-word', verticalAlign: 'top',
              }}>{v}</td>
            ))}</tr>
          ))}
          {/* filler row: keeps the grid's column rules running to the bottom of the reserved area, like the printout */}
          <tr><td colSpan={columns.length || 1} style={{ borderLeft: cellBorder, borderRight: cellBorder, padding: 0 }} /></tr>
        </tbody>
      </table>
    </Box>
  );
}

function legacyToForm(t: any): Partial<TemplateForm> {
  const s = t.layout?.sections;
  const itemFields = (s?.items?.columns ?? []).filter((c: string) => TABLE_COLUMN_CATALOG.items.some((d) => d.field === c));
  const std = buildStandardLayout({ title: (s?.header?.title ?? 'Tax Invoice').toUpperCase(), itemFields });
  return { page: std.page, elements: std.elements, copiesText: '' };
}

export function TaxInvoiceTemplateDesignerPage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const { enqueueSnackbar } = useSnackbar();
  const qc = useQueryClient();
  const { hasPermission } = useAuthStore();
  const canSave = hasPermission('taxInvoiceTemplate:create') || hasPermission('taxInvoiceTemplate:edit');

  const [selectedId, setSelectedId] = useState(params.get('id') ?? '');
  const [form, setForm] = useState<TemplateForm>(blankForm);
  const [selectedElId, setSelectedElId] = useState<string | null>(null);
  const [zoom, setZoom] = useState(3);
  const [previewInvoiceId, setPreviewInvoiceId] = useState('');
  const [legacyNotice, setLegacyNotice] = useState(false);
  const [tableWidthDraft, setTableWidthDraft] = useState<string | null>(null);

  const templatesQuery = useQuery({ queryKey: ['tax-invoice-templates'], queryFn: () => apiGet<any>('/sales/tax-invoice-templates') });
  const templates: any[] = (templatesQuery.data as any)?.data ?? templatesQuery.data ?? [];

  const detailQuery = useQuery({
    queryKey: ['tax-invoice-template', selectedId],
    queryFn: () => apiGet<any>(`/sales/tax-invoice-templates/${selectedId}`),
    enabled: !!selectedId,
  });

  const branchesQuery = useQuery({ queryKey: ['sales-branches'], queryFn: () => apiGet<any>('/sales/branches') });
  const branches: any[] = (branchesQuery.data as any)?.data ?? branchesQuery.data ?? [];

  const invoicesQuery = useQuery({ queryKey: ['tax-invoice-designer-invoices'], queryFn: () => apiGet<any>('/sales/invoices') });
  const recentInvoices: any[] = (invoicesQuery.data as any)?.data ?? invoicesQuery.data ?? [];

  useEffect(() => {
    if (!selectedId) { setForm(blankForm()); setSelectedElId(null); setLegacyNotice(false); return; }
    const raw = detailQuery.data as any;
    const t = raw?.data ?? raw;
    if (!t || t.id !== selectedId) return;
    const base = {
      id: t.id, name: t.name, description: t.description ?? '', branchId: t.branchId ?? '',
      isDefault: !!t.isDefault, isActive: t.isActive !== false,
    };
    if (isDesignerLayout(t.layout)) {
      const l = t.layout as TaxInvoiceDesignerLayout;
      setForm({
        ...base, page: l.page ?? { widthMm: DEFAULT_PAGE_WIDTH_MM, heightMm: DEFAULT_PAGE_HEIGHT_MM },
        copiesText: (l.copies ?? []).join('\n'), elements: l.elements,
      });
      setLegacyNotice(false);
    } else {
      setForm({ ...blankForm(), ...base, ...legacyToForm(t) } as TemplateForm);
      setLegacyNotice(true);
    }
    setSelectedElId(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, detailQuery.data]);

  useEffect(() => { setTableWidthDraft(null); }, [selectedElId]);

  const selectedEl = form.elements.find((e) => e.id === selectedElId) ?? null;

  function updateElement(id: string, patch: Partial<TaxInvoiceTemplateElement>) {
    setForm((f) => ({ ...f, elements: f.elements.map((e) => (e.id === id ? { ...e, ...patch } : e)) }));
  }

  function addElement(type: TaxInvoiceElementType) {
    const id = `el_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const cascade = form.elements.length % 6;
    const xMm = Math.min(Math.max(10, form.page.widthMm - 20), 10 + cascade * 8);
    const yMm = Math.min(Math.max(10, form.page.heightMm - 20), 10 + cascade * 8);
    const base: TaxInvoiceTemplateElement = { id, type, xMm, yMm };
    if (type === 'text') Object.assign(base, { literalText: 'Text', fontSize: 9 });
    if (type === 'box') Object.assign(base, { widthMm: 40, heightMm: 20 });
    if (type === 'line') Object.assign(base, { widthMm: 40, heightMm: 0.3 });
    if (type === 'barcode') Object.assign(base, { boundField: 'invoice.number', widthMm: 45, heightMm: 12, humanReadable: true });
    if (type === 'qrcode') Object.assign(base, { widthMm: 22, heightMm: 22 });
    if (type === 'image') Object.assign(base, { widthMm: 25, heightMm: 25 });
    if (type === 'table') {
      const hasItems = form.elements.some((e) => e.type === 'table' && e.tableKind === 'items');
      const kind: TaxInvoiceTableKind = hasItems ? 'hsnSummary' : 'items';
      const fields = kind === 'items'
        ? ['srNo', 'descriptionDetail', 'hsnCode', 'quantity', 'netWeight', 'rate', 'taxableValue', 'totalPrice']
        : TABLE_COLUMN_CATALOG[kind].slice(0, 5).map((c) => c.field);
      const cols = scaleColumnsTo(defaultColumns(kind, fields), Math.max(30, form.page.widthMm - 2 * xMm));
      Object.assign(base, {
        tableKind: kind, columns: cols, widthMm: computeTableWidthMm(cols), heightMm: kind === 'items' ? 100 : 30,
        headerFontSize: 7.5, rowFontSize: 8, borderStyle: 'all', headerFill: true, showTotalRow: kind === 'items',
      });
    }
    setForm((f) => ({ ...f, elements: [...f.elements, base] }));
    setSelectedElId(id);
  }

  function duplicateSelected() {
    if (!selectedEl) return;
    const id = `el_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const copy = { ...JSON.parse(JSON.stringify(selectedEl)), id, xMm: selectedEl.xMm + 5, yMm: selectedEl.yMm + 5 };
    setForm((f) => ({ ...f, elements: [...f.elements, copy] }));
    setSelectedElId(id);
  }

  function removeSelected() {
    if (!selectedElId) return;
    setForm((f) => ({ ...f, elements: f.elements.filter((e) => e.id !== selectedElId) }));
    setSelectedElId(null);
  }

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

  // ── tables ──
  function setColumns(columns: TaxInvoiceTableColumn[]) {
    if (!selectedEl) return;
    updateElement(selectedEl.id, { columns, widthMm: computeTableWidthMm(columns, selectedEl.widthMm) });
  }
  function updateColumn(field: string, patch: Partial<TaxInvoiceTableColumn>) {
    if (!selectedEl) return;
    setColumns((selectedEl.columns ?? []).map((c) => (c.field === field ? { ...c, ...patch } : c)));
  }
  function moveColumn(field: string, direction: -1 | 1) {
    if (!selectedEl) return;
    const cols = [...(selectedEl.columns ?? [])];
    const i = cols.findIndex((c) => c.field === field);
    const j = i + direction;
    if (i < 0 || j < 0 || j >= cols.length) return;
    [cols[i], cols[j]] = [cols[j], cols[i]];
    setColumns(cols);
  }
  function addColumn(kind: TaxInvoiceTableKind, field: string) {
    if (!selectedEl) return;
    const d = TABLE_COLUMN_CATALOG[kind].find((c) => c.field === field)!;
    setColumns([...(selectedEl.columns ?? []), { field, label: d.label, widthMm: d.widthMm, align: d.align }]);
  }
  function changeTableKind(kind: TaxInvoiceTableKind) {
    if (!selectedEl) return;
    const fields = kind === 'items'
      ? ['srNo', 'descriptionDetail', 'hsnCode', 'quantity', 'netWeight', 'rate', 'taxableValue', 'totalPrice']
      : TABLE_COLUMN_CATALOG[kind].slice(0, 5).map((c) => c.field);
    const cols = scaleColumnsTo(defaultColumns(kind, fields), computeTableWidthMm(selectedEl.columns, 120));
    updateElement(selectedEl.id, { tableKind: kind, columns: cols, widthMm: computeTableWidthMm(cols), showTotalRow: kind === 'items' ? true : selectedEl.showTotalRow });
  }

  // ── drag / resize ──
  const dragState = useRef<{
    id: string; startX: number; startY: number; mode: 'move' | 'resize-x' | 'resize-xy';
    origXMm: number; origYMm: number; origWidthMm: number; origHeightMm: number; origColumns?: TaxInvoiceTableColumn[];
  } | null>(null);

  function onElementPointerDown(e: React.PointerEvent, el: TaxInvoiceTemplateElement) {
    e.stopPropagation();
    setSelectedElId(el.id);
    dragState.current = {
      id: el.id, startX: e.clientX, startY: e.clientY, mode: 'move',
      origXMm: el.xMm, origYMm: el.yMm, origWidthMm: el.widthMm ?? 0, origHeightMm: el.heightMm ?? 0,
    };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }
  function onResizeHandlePointerDown(e: React.PointerEvent, el: TaxInvoiceTemplateElement, mode: 'resize-x' | 'resize-xy') {
    e.stopPropagation();
    setSelectedElId(el.id);
    const fallbackWidth = el.type === 'text' ? 40 : 10;
    dragState.current = {
      id: el.id, startX: e.clientX, startY: e.clientY, mode,
      origXMm: el.xMm, origYMm: el.yMm,
      origWidthMm: el.type === 'table' ? computeTableWidthMm(el.columns, el.widthMm) : (el.widthMm ?? fallbackWidth),
      origHeightMm: el.heightMm ?? (el.type === 'line' ? 0.3 : 10),
      origColumns: el.columns,
    };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }
  function onPointerMove(e: React.PointerEvent) {
    const ds = dragState.current;
    if (!ds) return;
    const dxMm = (e.clientX - ds.startX) / zoom;
    const dyMm = (e.clientY - ds.startY) / zoom;
    if (ds.mode === 'move') {
      updateElement(ds.id, {
        xMm: Math.max(0, Math.min(form.page.widthMm, Math.round((ds.origXMm + dxMm) * 10) / 10)),
        yMm: Math.max(0, Math.min(form.page.heightMm, Math.round((ds.origYMm + dyMm) * 10) / 10)),
      });
      return;
    }
    const el = form.elements.find((x) => x.id === ds.id);
    const newWidth = Math.max(2, Math.round((ds.origWidthMm + dxMm) * 10) / 10);
    if (el?.type === 'table' && ds.origColumns) {
      const cols = scaleColumnsTo(ds.origColumns, newWidth);
      const patch: Partial<TaxInvoiceTemplateElement> = { columns: cols, widthMm: computeTableWidthMm(cols) };
      if (ds.mode === 'resize-xy') patch.heightMm = Math.max(8, Math.round((ds.origHeightMm + dyMm) * 10) / 10);
      updateElement(ds.id, patch);
      return;
    }
    const patch: Partial<TaxInvoiceTemplateElement> = { widthMm: newWidth };
    if (ds.mode === 'resize-xy') patch.heightMm = Math.max(0.2, Math.round((ds.origHeightMm + dyMm) * 10) / 10);
    updateElement(ds.id, patch);
  }
  function onPointerUp() { dragState.current = null; }

  function elementWidthMm(el: TaxInvoiceTemplateElement) {
    return el.type === 'table' ? computeTableWidthMm(el.columns, el.widthMm) : el.widthMm;
  }
  function overflowsPage(el: TaxInvoiceTemplateElement) {
    const w = elementWidthMm(el);
    return w != null && el.xMm + w > form.page.widthMm + 0.01;
  }

  // ── save / preview ──
  function buildLayout(): TaxInvoiceDesignerLayout {
    return {
      page: form.page,
      copies: form.copiesText.split('\n').map((s) => s.trim()).filter(Boolean),
      elements: form.elements,
    };
  }

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (!form.name.trim()) throw new Error('Template name is required');
      if (!form.page.widthMm || !form.page.heightMm) throw new Error('Paper width and height are required');
      const payload = {
        name: form.name, description: form.description || null, branchId: form.branchId || null,
        isDefault: form.isDefault && !form.branchId, isActive: form.isActive, layout: buildLayout(),
      };
      const res = form.id
        ? await apiPut<any>(`/sales/tax-invoice-templates/${form.id}`, payload)
        : await apiPost<any>('/sales/tax-invoice-templates', payload);
      return (res as any)?.data ?? res;
    },
    onSuccess: (saved: any) => {
      enqueueSnackbar(`Template "${saved.name}" saved`, { variant: 'success' });
      qc.invalidateQueries({ queryKey: ['tax-invoice-templates'] });
      qc.invalidateQueries({ queryKey: ['tax-invoice-template', saved.id] });
      setSelectedId(saved.id);
    },
    onError: (e: any) => enqueueSnackbar(e.response?.data?.error ?? e.message ?? 'Save failed', { variant: 'error' }),
  });

  const previewMutation = useMutation({
    mutationFn: async (useSample: boolean) => {
      let invoice: any = sampleInvoiceForPreview();
      if (!useSample) {
        if (!previewInvoiceId) throw new Error('Pick an invoice to preview with');
        const res: any = await apiGet<any>(`/sales/invoices/${previewInvoiceId}`);
        invoice = res?.data ?? res;
      }
      await printTaxInvoiceTemplate(invoice, buildLayout());
    },
    onError: (e: any) => enqueueSnackbar(e.message ?? 'Preview failed', { variant: 'error' }),
  });

  function loadStandard() {
    if (form.elements.length && !window.confirm('Replace every element on the canvas with the standard GST tax invoice layout?')) return;
    const std = buildStandardLayout();
    setForm((f) => ({ ...f, page: std.page, elements: std.elements }));
    setSelectedElId(null);
  }

  const insertFieldIntoLiteral = (key: string) => {
    if (!selectedEl || !key) return;
    updateElement(selectedEl.id, { literalText: `${selectedEl.literalText ?? ''}{{${key}}}` });
  };

  return (
    <>
      <datalist id="tax-invoice-font-sizes">
        {COMMON_FONT_SIZES_PT.map((pt) => <option key={pt} value={pt} />)}
      </datalist>
      <PageHeader title="Tax Invoice Template Designer"
        actions={[{ label: 'Back to Templates', icon: <ArrowBack />, onClick: () => navigate('/sales/tax-invoice-templates'), variant: 'outlined' as const }]} />

      {legacyNotice && (
        <Alert severity="info" sx={{ mb: 2 }}>
          This template was saved in the older checklist format. It has been opened here on the standard
          designer layout (with its title and item columns carried over). Saving replaces the old format
          with this designer layout.
        </Alert>
      )}

      <Grid container spacing={2} alignItems="flex-start">
        {/* ── left: template, page, elements, layers ── */}
        <Grid item xs={12} md={3}>
          <Card sx={{ p: 2, position: 'sticky', top: 16, maxHeight: 'calc(100vh - 100px)', overflowY: 'auto' }}>
            <Stack spacing={1.5}>
              <SelectField label="Load Template" value={selectedId} emptyLabel="+ New Template"
                options={templates.map((t: any) => ({ value: t.id, label: `${t.name}${t.isDefault ? ' ★ Default' : ''}${t.isActive === false ? ' (inactive)' : ''}` }))}
                onChange={(e) => setSelectedId(e.target.value)} />
              <Divider />
              <TextField label="Template Name" value={form.name} fullWidth
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
              <TextField label="Description (optional)" value={form.description} fullWidth
                onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} />
              <SelectField label="Branch" value={form.branchId} emptyLabel="Company-wide"
                options={branches.map((b: any) => ({ value: b.id, label: b.name }))}
                onChange={(e) => setForm((f) => ({ ...f, branchId: e.target.value, isDefault: e.target.value ? false : f.isDefault }))} />
              <FormControlLabel
                control={<Checkbox checked={form.isDefault && !form.branchId} disabled={!!form.branchId}
                  onChange={(e) => setForm((f) => ({ ...f, isDefault: e.target.checked }))} />}
                label="Company default (used by every branch without its own template)" />
              <FormControlLabel
                control={<Checkbox checked={form.isActive} onChange={(e) => setForm((f) => ({ ...f, isActive: e.target.checked }))} />}
                label="Active" />

              <Divider />
              <SelectField label="Paper preset" value=""
                emptyLabel="Choose a size…"
                options={PAGE_PRESETS.map((p, i) => ({ value: i, label: p.label }))}
                onChange={(e) => {
                  const p = PAGE_PRESETS[Number(e.target.value)];
                  if (p) setForm((f) => ({ ...f, page: { widthMm: p.widthMm, heightMm: p.heightMm } }));
                }} />
              <Stack direction="row" spacing={1}>
                <NumberField label="Width (mm)" value={form.page.widthMm}
                  onChange={(e) => setForm((f) => ({ ...f, page: { ...f.page, widthMm: Number(e.target.value) } }))} />
                <NumberField label="Height (mm)" value={form.page.heightMm}
                  onChange={(e) => setForm((f) => ({ ...f, page: { ...f.page, heightMm: Number(e.target.value) } }))} />
              </Stack>
              <TextField label="Copies (one label per line)" multiline minRows={2} fullWidth value={form.copiesText}
                placeholder={'ORIGINAL FOR RECIPIENT\nDUPLICATE FOR TRANSPORTER'}
                helperText="Each line prints one full copy of the invoice; bind a text to “Copy Label” to show it. Leave empty for a single copy."
                onChange={(e) => setForm((f) => ({ ...f, copiesText: e.target.value }))} />

              <Button variant="contained" startIcon={<Save />} disabled={!canSave || saveMutation.isPending} onClick={() => saveMutation.mutate()}>
                {saveMutation.isPending ? 'Saving…' : 'Save Template'}
              </Button>
              <Button variant="outlined" startIcon={<AutoFixHigh />} onClick={loadStandard}>Load Standard GST Layout</Button>

              <Divider />
              <Typography variant="subtitle2">Add Element</Typography>
              <Stack direction="row" flexWrap="wrap" gap={1}>
                <Button size="small" variant="outlined" onClick={() => addElement('text')}>+ Text / Field</Button>
                <Button size="small" variant="outlined" onClick={() => addElement('table')}>+ Table</Button>
                <Button size="small" variant="outlined" onClick={() => addElement('box')}>+ Box</Button>
                <Button size="small" variant="outlined" onClick={() => addElement('line')}>+ Line</Button>
                <Button size="small" variant="outlined" onClick={() => addElement('image')}>+ Image / Logo</Button>
                <Button size="small" variant="outlined" onClick={() => addElement('qrcode')}>+ e-Invoice QR</Button>
                <Button size="small" variant="outlined" onClick={() => addElement('barcode')}>+ Barcode</Button>
              </Stack>

              <Divider />
              <Stack direction="row" justifyContent="space-between" alignItems="center">
                <Typography variant="subtitle2">Layers ({form.elements.length})</Typography>
                {selectedElId && (
                  <Stack direction="row" spacing={0.5}>
                    <IconButton size="small" title="Bring to front" onClick={() => moveElementToEdge(selectedElId, true)}><KeyboardDoubleArrowUp fontSize="small" /></IconButton>
                    <IconButton size="small" title="Send to back" onClick={() => moveElementToEdge(selectedElId, false)}><KeyboardDoubleArrowDown fontSize="small" /></IconButton>
                  </Stack>
                )}
              </Stack>
              <Box sx={{ maxHeight: 240, overflowY: 'auto', border: '1px solid', borderColor: 'divider', borderRadius: 1 }}>
                {form.elements.length === 0 && (
                  <Typography variant="caption" color="text.secondary" sx={{ p: 1, display: 'block' }}>No elements yet — add one above.</Typography>
                )}
                {[...form.elements].reverse().map((el, displayIdx) => (
                  <Stack key={el.id} direction="row" alignItems="center" spacing={0.5} onClick={() => setSelectedElId(el.id)}
                    sx={{ p: 0.75, cursor: 'pointer', borderBottom: '1px solid', borderColor: 'divider',
                      bgcolor: selectedElId === el.id ? 'action.selected' : 'transparent', '&:hover': { bgcolor: 'action.hover' } }}>
                    <Box sx={{ flex: 1, minWidth: 0 }}>
                      <Typography variant="body2" noWrap>{elementLabel(el)}</Typography>
                      <Typography variant="caption" color="text.secondary">{el.type}{el.repeatOnEveryPage ? ' · every page' : ''}</Typography>
                    </Box>
                    <IconButton size="small" disabled={displayIdx === 0} onClick={(e) => { e.stopPropagation(); moveElementZ(el.id, 1); }}><ArrowUpward fontSize="inherit" /></IconButton>
                    <IconButton size="small" disabled={displayIdx === form.elements.length - 1} onClick={(e) => { e.stopPropagation(); moveElementZ(el.id, -1); }}><ArrowDownward fontSize="inherit" /></IconButton>
                  </Stack>
                ))}
              </Box>
            </Stack>
          </Card>
        </Grid>

        {/* ── centre: canvas ── */}
        <Grid item xs={12} md={6} sx={{ minWidth: 0 }}>
          <Card sx={{ p: 2 }}>
            <Stack direction="row" alignItems="center" justifyContent="space-between" flexWrap="wrap" gap={1} sx={{ mb: 1 }}>
              <Typography variant="subtitle2" color="text.secondary">{form.page.widthMm}mm × {form.page.heightMm}mm</Typography>
              <Stack direction="row" alignItems="center" spacing={1}>
                <Button size="small" onClick={() => setZoom((z) => Math.max(1, z - 0.5))} startIcon={<ZoomOut />}>Zoom</Button>
                <Typography variant="caption" sx={{ minWidth: 56, textAlign: 'center' }}>{zoom} px/mm</Typography>
                <Button size="small" onClick={() => setZoom((z) => Math.min(6, z + 0.5))} startIcon={<ZoomIn />}>Zoom</Button>
              </Stack>
            </Stack>
            <Box sx={{ overflow: 'auto', maxHeight: 'calc(100vh - 220px)', p: 2, bgcolor: 'action.hover', borderRadius: 1 }}>
              <Box onPointerMove={onPointerMove} onPointerUp={onPointerUp} onClick={() => setSelectedElId(null)}
                sx={{ position: 'relative', width: form.page.widthMm * zoom, height: form.page.heightMm * zoom, bgcolor: '#fff',
                  border: '2px solid', borderColor: 'divider', boxShadow: 1, mx: 'auto', overflow: 'hidden' }}>
                {form.elements.map((el) => {
                  const overflow = overflowsPage(el);
                  const resizeMode: 'resize-x' | 'resize-xy' | null =
                    el.type === 'text' ? 'resize-x' : el.type === 'qrcode' ? 'resize-xy' : 'resize-xy';
                  return (
                    <Box key={el.id} onPointerDown={(e) => onElementPointerDown(e, el)} onClick={(e) => e.stopPropagation()}
                      sx={{ position: 'absolute', left: el.xMm * zoom, top: el.yMm * zoom, cursor: 'move', userSelect: 'none', touchAction: 'none',
                        outline: overflow || selectedElId === el.id ? '2px solid' : 'none',
                        outlineColor: overflow ? 'error.main' : 'primary.main', outlineOffset: 1 }}>
                      <ElementPreview el={el} zoom={zoom} pageWidthMm={form.page.widthMm} />
                      {selectedElId === el.id && (
                        <Box data-testid="resize-handle" onPointerDown={(e) => onResizeHandlePointerDown(e, el, resizeMode)}
                          sx={{ position: 'absolute', right: -6, bottom: resizeMode === 'resize-xy' ? -6 : undefined,
                            top: resizeMode === 'resize-x' ? '50%' : undefined, transform: resizeMode === 'resize-x' ? 'translateY(-50%)' : undefined,
                            width: 10, height: 10, borderRadius: '50%', bgcolor: 'primary.main', border: '1.5px solid #fff',
                            cursor: resizeMode === 'resize-xy' ? 'nwse-resize' : 'ew-resize', touchAction: 'none' }} />
                      )}
                    </Box>
                  );
                })}
              </Box>
            </Box>
            <Typography variant="caption" color="text.secondary">
              Drag an element to move it, or type X/Y precisely in the panel on the right. Drag the blue handle to resize
              (a table's handle rescales its columns and sets its reserved height). The item table <b>flows</b> when printed:
              it grows with the number of lines, everything designed below it moves down with it, and a long bill continues
              onto further pages with the header repeated.
            </Typography>
            {form.elements.some(overflowsPage) && (
              <Alert severity="warning" sx={{ mt: 1, fontSize: 12 }}>
                One or more elements (outlined red) run past the {form.page.widthMm}mm page width.
              </Alert>
            )}
          </Card>
        </Grid>

        {/* ── right: properties + preview ── */}
        <Grid item xs={12} md={3}>
          <Card sx={{ p: 2, position: 'sticky', top: 16, maxHeight: 'calc(100vh - 100px)', overflowY: 'auto' }}>
            <Stack spacing={1.5}>
              <Typography variant="subtitle2">Element Properties</Typography>
              {selectedEl ? (
                <>
                  <Typography variant="caption" color="text.secondary">{selectedEl.type.toUpperCase()}</Typography>
                  <Stack direction="row" spacing={1}>
                    <NumberField label="X (mm)" value={selectedEl.xMm} onChange={(e) => updateElement(selectedEl.id, { xMm: Number(e.target.value) })} />
                    <NumberField label="Y (mm)" value={selectedEl.yMm} onChange={(e) => updateElement(selectedEl.id, { yMm: Number(e.target.value) })} />
                  </Stack>
                  <FormControlLabel
                    control={<Checkbox checked={!!selectedEl.repeatOnEveryPage} onChange={(e) => updateElement(selectedEl.id, { repeatOnEveryPage: e.target.checked })} />}
                    label="Print on every page (page frame, header, page footer)" />

                  {selectedEl.type === 'text' && (
                    <>
                      <SelectField label="Bound Field" value={selectedEl.boundField ?? ''} emptyLabel="None (literal text)"
                        optgroups={FIELD_OPTGROUPS}
                        onChange={(e) => updateElement(selectedEl.id, { boundField: e.target.value || undefined })} />
                      {!selectedEl.boundField && (
                        <>
                          <TextField label="Text" fullWidth multiline minRows={2} value={selectedEl.literalText ?? ''}
                            onChange={(e) => updateElement(selectedEl.id, { literalText: e.target.value })} />
                          <SelectField label="Insert field into text" value="" emptyLabel="Choose a field…" optgroups={FIELD_OPTGROUPS}
                            onChange={(e) => insertFieldIntoLiteral(e.target.value)} />
                          <Typography variant="caption" color="text.secondary">
                            Mix words and values in one box, e.g. “GSTIN: {'{{seller.gstin}}'}   Date: {'{{invoice.date}}'}”.
                          </Typography>
                        </>
                      )}
                      <Stack direction="row" spacing={1}>
                        <NumberField label="Font Size (pt)" value={selectedEl.fontSize ?? 9} inputProps={{ list: 'tax-invoice-font-sizes', step: 0.5 }}
                          onChange={(e) => updateElement(selectedEl.id, { fontSize: Number(e.target.value) })} />
                        <NumberField label="Wrap Width (mm, 0 = auto)" value={selectedEl.widthMm ?? 0}
                          onChange={(e) => { const v = Number(e.target.value); updateElement(selectedEl.id, { widthMm: v > 0 ? v : undefined }); }} />
                      </Stack>
                      <SelectField label="Align" value={selectedEl.align ?? 'left'} options={ALIGN_OPTIONS}
                        onChange={(e) => updateElement(selectedEl.id, { align: e.target.value as TaxInvoiceTextAlign })} />
                      {!selectedEl.widthMm && (
                        <Typography variant="caption" color="text.secondary">Align only shows once Wrap Width is set.</Typography>
                      )}
                      <Stack direction="row" flexWrap="wrap">
                        <FormControlLabel control={<Checkbox size="small" checked={!!selectedEl.bold} onChange={(e) => updateElement(selectedEl.id, { bold: e.target.checked })} />} label="Bold" />
                        <FormControlLabel control={<Checkbox size="small" checked={!!selectedEl.italic} onChange={(e) => updateElement(selectedEl.id, { italic: e.target.checked })} />} label="Italic" />
                        <FormControlLabel control={<Checkbox size="small" checked={!!selectedEl.uppercase} onChange={(e) => updateElement(selectedEl.id, { uppercase: e.target.checked })} />} label="UPPERCASE" />
                        {!selectedEl.boundField && <FormControlLabel control={<Checkbox size="small" checked={!!selectedEl.hideIfEmpty} onChange={(e) => updateElement(selectedEl.id, { hideIfEmpty: e.target.checked })} />} label="Hide when empty" />}
                        <FormControlLabel control={<Checkbox size="small" checked={!!selectedEl.noCurrencySymbol} onChange={(e) => updateElement(selectedEl.id, { noCurrencySymbol: e.target.checked })} />} label="No ₹ symbol" />
                      </Stack>
                      <TextField label="Colour" type="color" value={selectedEl.color ?? '#000000'} InputLabelProps={{ shrink: true }}
                        onChange={(e) => updateElement(selectedEl.id, { color: e.target.value === '#000000' ? undefined : e.target.value })} />
                    </>
                  )}

                  {(selectedEl.type === 'box' || selectedEl.type === 'line' || selectedEl.type === 'qrcode' || selectedEl.type === 'image') && (
                    <Stack direction="row" spacing={1}>
                      <NumberField label="Width (mm)" value={selectedEl.widthMm ?? 10} onChange={(e) => updateElement(selectedEl.id, { widthMm: Number(e.target.value) })} />
                      <NumberField label="Height (mm)" value={selectedEl.heightMm ?? 10} onChange={(e) => updateElement(selectedEl.id, { heightMm: Number(e.target.value) })} />
                    </Stack>
                  )}
                  {selectedEl.type === 'box' && (
                    <>
                      <TextField label="Fill colour" type="color" value={selectedEl.fillColor ?? '#ffffff'} InputLabelProps={{ shrink: true }}
                        onChange={(e) => updateElement(selectedEl.id, { fillColor: e.target.value === '#ffffff' ? undefined : e.target.value })} />
                      <Typography variant="caption" color="text.secondary">
                        A box that surrounds the item table (starts above its top and ends below its reserved area) stretches with it, so a page frame always wraps the printed rows.
                      </Typography>
                    </>
                  )}
                  {selectedEl.type === 'qrcode' && (
                    <Typography variant="caption" color="text.secondary">
                      Prints the e-invoice signed QR code once the invoice has an IRN; nothing prints before that.
                    </Typography>
                  )}

                  {selectedEl.type === 'barcode' && (
                    <>
                      <SelectField label="Encodes" value={selectedEl.boundField ?? 'invoice.number'} options={BARCODE_OPTIONS}
                        onChange={(e) => updateElement(selectedEl.id, { boundField: e.target.value })} />
                      <Stack direction="row" spacing={1}>
                        <NumberField label="Width (mm)" value={selectedEl.widthMm ?? 45} onChange={(e) => updateElement(selectedEl.id, { widthMm: Number(e.target.value) })} />
                        <NumberField label="Height (mm)" value={selectedEl.heightMm ?? 12} onChange={(e) => updateElement(selectedEl.id, { heightMm: Number(e.target.value) })} />
                      </Stack>
                      <FormControlLabel control={<Checkbox checked={selectedEl.humanReadable !== false} onChange={(e) => updateElement(selectedEl.id, { humanReadable: e.target.checked })} />}
                        label="Show value as text under barcode" />
                    </>
                  )}

                  {selectedEl.type === 'image' && (
                    <>
                      <Button component="label" variant="outlined" size="small">
                        {selectedEl.imageDataUrl ? 'Replace Image…' : 'Choose Image…'}
                        <input type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml" hidden
                          onChange={(e) => {
                            const file = e.target.files?.[0];
                            if (!file) return;
                            if (file.size > 800 * 1024) { enqueueSnackbar('Image is over 800 KB — use a smaller logo/signature image', { variant: 'error' }); return; }
                            const reader = new FileReader();
                            reader.onload = () => updateElement(selectedEl.id, { imageDataUrl: String(reader.result) });
                            reader.readAsDataURL(file);
                          }} />
                      </Button>
                      <Typography variant="caption" color="text.secondary">
                        Stored inside this template (company logo, signature, stamp) — no separate upload. Up to 800 KB.
                      </Typography>
                    </>
                  )}

                  {selectedEl.type === 'table' && (
                    <>
                      <SelectField label="Table shows" value={selectedEl.tableKind ?? 'items'} options={TABLE_KIND_OPTIONS}
                        onChange={(e) => changeTableKind(e.target.value as TaxInvoiceTableKind)} />
                      <NumberField label="Table Width (mm)" value={tableWidthDraft ?? computeTableWidthMm(selectedEl.columns, selectedEl.widthMm ?? 190)}
                        onChange={(e) => setTableWidthDraft(e.target.value)}
                        onBlur={() => {
                          const v = Number(tableWidthDraft);
                          if (tableWidthDraft != null && tableWidthDraft !== '' && v > 0) setColumns(scaleColumnsTo(selectedEl.columns ?? [], v));
                          setTableWidthDraft(null);
                        }}
                        onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />
                      <NumberField label="Reserved height (mm, header + rows area)" value={selectedEl.heightMm ?? 30}
                        onChange={(e) => updateElement(selectedEl.id, { heightMm: Math.max(8, Number(e.target.value)) })} />
                      <Typography variant="caption" color="text.secondary">
                        {selectedEl.tableKind === 'items'
                          ? 'Space kept for the lines. Elements below this area stay put while the lines fit, and move down by the overflow when they do not; a bill too long for the page continues on the next one.'
                          : 'Space kept for this table. Anything below it moves down if the table prints taller than this.'}
                      </Typography>
                      <Stack direction="row" spacing={1}>
                        <NumberField label="Header Font (pt)" value={selectedEl.headerFontSize ?? 7.5} inputProps={{ list: 'tax-invoice-font-sizes', step: 0.5 }}
                          onChange={(e) => updateElement(selectedEl.id, { headerFontSize: Number(e.target.value) })} />
                        <NumberField label="Row Font (pt)" value={selectedEl.rowFontSize ?? 8} inputProps={{ list: 'tax-invoice-font-sizes', step: 0.5 }}
                          onChange={(e) => updateElement(selectedEl.id, { rowFontSize: Number(e.target.value) })} />
                      </Stack>
                      <SelectField label="Borders" value={selectedEl.borderStyle ?? 'all'} options={BORDER_OPTIONS}
                        onChange={(e) => updateElement(selectedEl.id, { borderStyle: e.target.value as TaxInvoiceTableBorderStyle })} />
                      <Stack direction="row" flexWrap="wrap">
                        <FormControlLabel control={<Checkbox size="small" checked={!!selectedEl.headerFill} onChange={(e) => updateElement(selectedEl.id, { headerFill: e.target.checked })} />} label="Shaded header" />
                        <FormControlLabel control={<Checkbox size="small" checked={!!selectedEl.showTotalRow} onChange={(e) => updateElement(selectedEl.id, { showTotalRow: e.target.checked })} />} label="Total row" />
                      </Stack>
                      <Divider />
                      <Typography variant="caption" color="text.secondary">
                        Columns — only the ones listed print. Reorder with the arrows; Label, Width, Font and Align are per column.
                      </Typography>
                      {(selectedEl.columns ?? []).map((c, idx, all) => (
                        <Box key={c.field} sx={{ border: '1px solid', borderColor: 'divider', borderRadius: 1, p: 1 }}>
                          <Stack direction="row" spacing={0.5} alignItems="center">
                            <Stack>
                              <IconButton size="small" disabled={idx === 0} onClick={() => moveColumn(c.field, -1)}><ArrowUpward fontSize="inherit" /></IconButton>
                              <IconButton size="small" disabled={idx === all.length - 1} onClick={() => moveColumn(c.field, 1)}><ArrowDownward fontSize="inherit" /></IconButton>
                            </Stack>
                            <TextField size="small" label="Label" fullWidth value={c.label} onChange={(e) => updateColumn(c.field, { label: e.target.value })} />
                            <IconButton size="small" onClick={() => setColumns(all.filter((x) => x.field !== c.field))}><Delete fontSize="inherit" /></IconButton>
                          </Stack>
                          <Stack direction="row" spacing={1} sx={{ mt: 1, pl: 4.5 }}>
                            <NumberField size="small" label="Width (mm)" value={c.widthMm} onChange={(e) => updateColumn(c.field, { widthMm: Number(e.target.value) })} />
                            <NumberField size="small" label="Font (pt)" value={c.fontSize ?? ''} inputProps={{ list: 'tax-invoice-font-sizes', step: 0.5 }}
                              onChange={(e) => updateColumn(c.field, { fontSize: e.target.value === '' ? undefined : Number(e.target.value) })} />
                            <SelectField size="small" label="Align" value={c.align ?? 'left'} options={ALIGN_OPTIONS}
                              onChange={(e) => updateColumn(c.field, { align: e.target.value as TaxInvoiceTextAlign })} />
                          </Stack>
                        </Box>
                      ))}
                      <Stack direction="row" flexWrap="wrap" gap={1}>
                        {TABLE_COLUMN_CATALOG[selectedEl.tableKind ?? 'items']
                          .filter((d) => !(selectedEl.columns ?? []).some((c) => c.field === d.field))
                          .map((d) => (
                            <Button key={d.field} size="small" variant="outlined" onClick={() => addColumn(selectedEl.tableKind ?? 'items', d.field)}>+ {d.label}</Button>
                          ))}
                      </Stack>
                    </>
                  )}

                  <Stack direction="row" spacing={1}>
                    <Button fullWidth variant="outlined" startIcon={<ContentCopy />} onClick={duplicateSelected}>Duplicate</Button>
                    <Button fullWidth color="error" variant="outlined" startIcon={<Delete />} onClick={removeSelected}>Delete</Button>
                  </Stack>
                </>
              ) : (
                <Typography variant="body2" color="text.secondary">Select an element on the canvas (or add one on the left) to edit its properties.</Typography>
              )}

              <Divider />
              <Typography variant="subtitle2">Preview</Typography>
              {!form.elements.length && <Alert severity="info" sx={{ fontSize: 12 }}>Add at least one element to preview.</Alert>}
              <Button variant="contained" color="secondary" startIcon={<Print />}
                disabled={!form.elements.length || previewMutation.isPending} onClick={() => previewMutation.mutate(true)}>
                {previewMutation.isPending ? 'Opening…' : 'Preview with sample data'}
              </Button>
              <SelectField label="…or with a real invoice" value={previewInvoiceId} emptyLabel="Choose an invoice…" size="small"
                options={recentInvoices.slice(0, 50).map((i: any) => ({ value: i.id, label: `${i.invoiceNumber} — ${i.client?.name ?? ''}` }))}
                onChange={(e) => setPreviewInvoiceId(e.target.value)} />
              <Button variant="outlined" startIcon={<Print />} disabled={!previewInvoiceId || !form.elements.length || previewMutation.isPending}
                onClick={() => previewMutation.mutate(false)}>
                Preview with this invoice
              </Button>
            </Stack>
          </Card>
        </Grid>
      </Grid>
    </>
  );
}
