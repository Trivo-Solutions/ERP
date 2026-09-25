import { useEffect, useRef, useState } from 'react';
import {
  Box, Card, Grid, Typography, Button, Stack, Divider, Alert,
  Tabs, Tab, Checkbox, FormControlLabel, TextField,
} from '@mui/material';
import { ArrowBack, Print, Delete, Save, ZoomIn, ZoomOut, QrCode2 } from '@mui/icons-material';
import { useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useSnackbar } from 'notistack';
import { apiGet, apiPost, apiPut } from '../../api/client';
import { PageHeader } from '../../components/common/PageHeader';
import { SelectField } from '../../components/fields/SelectField';
import { NumberField } from '../../components/fields/NumberField';
import { printTsplViaAgent } from '../../utils/printAgent';

// Must match server/src/shared/tsplGenerator.ts's KNOWN_BOUND_FIELDS exactly — this is the
// contract between what a template element can point at and what generateTsplForTag can resolve.
type BoundField =
  | 'tagNumber' | 'name' | 'metalKarat' | 'grossWeight' | 'netWeight'
  | 'stoneWeight' | 'huid' | 'sellingPrice' | 'branchName';

const BOUND_FIELD_OPTIONS: { value: BoundField; label: string }[] = [
  { value: 'tagNumber', label: 'Tag Number' },
  { value: 'name', label: 'Item Name' },
  { value: 'metalKarat', label: 'Metal Karat' },
  { value: 'grossWeight', label: 'Gross Weight' },
  { value: 'netWeight', label: 'Net Weight' },
  { value: 'stoneWeight', label: 'Stone Weight' },
  { value: 'huid', label: 'HUID' },
  { value: 'sellingPrice', label: 'Selling Price' },
  { value: 'branchName', label: 'Branch Name' },
];

type ElementType = 'text' | 'barcode' | 'qrcode' | 'box' | 'line';
type Wing = 'front' | 'back';

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
  elements: TemplateElement[];
}

const BLANK_TEMPLATE: TemplateForm = { name: '', widthMm: 50, heightMm: 30, gapMm: 2, isDefault: false, elements: [] };

const ROTATION_OPTIONS = [
  { value: '0', label: '0°' }, { value: '90', label: '90°' },
  { value: '180', label: '180°' }, { value: '270', label: '270°' },
];

function elementLabel(el: TemplateElement) {
  if (el.boundField) return `{${BOUND_FIELD_OPTIONS.find((o) => o.value === el.boundField)?.label ?? el.boundField}}`;
  return el.literalText || '(empty text)';
}

// TSPL's built-in font "3" is a fixed 16x24-dot cell at multiplier 1 — not an arbitrary point
// size — so the preview has to derive from that real cell height (matching tsplGenerator.ts's
// own mult calculation exactly), not an approximated CSS font-size. Getting this wrong is exactly
// what let a template look fine on screen while printing ~3x larger for real (found the hard way
// against a physical TSC TTP-244 Pro).
const FONT3_CELL_HEIGHT_DOTS = 24;
const DOTS_PER_MM = 8;

function ElementPreview({ el, zoom }: { el: TemplateElement; zoom: number }) {
  const rotation = el.rotation ?? 0;
  const transform = rotation ? { transform: `rotate(${rotation}deg)`, transformOrigin: 'top left' } : {};

  if (el.type === 'text') {
    const mult = Math.max(1, Math.round((el.fontSize ?? 8) / 8));
    const lineHeightPx = (FONT3_CELL_HEIGHT_DOTS * mult / DOTS_PER_MM) * zoom;
    return (
      <Typography sx={{
        fontSize: lineHeightPx * 0.8, lineHeight: `${lineHeightPx}px`,
        fontFamily: 'monospace', whiteSpace: 'nowrap', ...transform,
      }}>
        {elementLabel(el)}
      </Typography>
    );
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

export function TagTemplateDesignerPage() {
  const navigate = useNavigate();
  const { enqueueSnackbar } = useSnackbar();
  const qc = useQueryClient();

  const [selectedId, setSelectedId] = useState('');
  const [form, setForm] = useState<TemplateForm>(BLANK_TEMPLATE);
  const [activeWing, setActiveWing] = useState<Wing>('front');
  const [selectedElId, setSelectedElId] = useState<string | null>(null);
  const [zoom, setZoom] = useState(6); // px per mm — purely an on-screen editing scale
  // Purely a visual guide for a folded two-wing tag — never sent to the printer or saved. Which
  // side ends up "front" after folding still depends on which way the fold goes, so this just
  // marks where the midpoint is, not which half is which.
  const [foldLine, setFoldLine] = useState<'none' | 'vertical' | 'horizontal'>('vertical');
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
    setForm({
      id: t.id, name: t.name, widthMm: Number(t.widthMm), heightMm: Number(t.heightMm), gapMm: Number(t.gapMm),
      isDefault: t.isDefault, elements: (t.layout?.elements ?? []) as TemplateElement[],
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
    const base: TemplateElement = { id, wing: activeWing, type, xMm: 5, yMm: 5 };
    if (type === 'text') Object.assign(base, { literalText: 'Text', fontSize: 8 });
    if (type === 'barcode') Object.assign(base, { boundField: 'tagNumber' as BoundField, heightMm: 10, humanReadable: true });
    if (type === 'qrcode') Object.assign(base, { boundField: 'tagNumber' as BoundField });
    if (type === 'box') Object.assign(base, { widthMm: 10, heightMm: 10 });
    if (type === 'line') Object.assign(base, { widthMm: 10, heightMm: 0.3 });
    setForm((f) => ({ ...f, elements: [...f.elements, base] }));
    setSelectedElId(id);
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
        isDefault: form.isDefault, layout: { elements: form.elements },
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

  const testPrintMutation = useMutation({
    mutationFn: async () => {
      if (!form.id) throw new Error('Save the template before test-printing');
      if (!testTagId) throw new Error('Pick a tag to test-print with');
      const { tspl } = await apiGet<{ tspl: string }>(`/tagging/tags/${testTagId}/print`, { templateId: form.id });
      await printTsplViaAgent(tspl);
    },
    onSuccess: () => enqueueSnackbar('Test label sent to printer', { variant: 'success' }),
    onError: (e: any) => enqueueSnackbar(e.message ?? 'Test print failed', { variant: 'error' }),
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

              <Typography variant="subtitle2">Add Element ({activeWing})</Typography>
              <Stack direction="row" flexWrap="wrap" gap={1}>
                <Button size="small" variant="outlined" onClick={() => addElement('text')}>+ Text</Button>
                <Button size="small" variant="outlined" onClick={() => addElement('barcode')}>+ Barcode</Button>
                <Button size="small" variant="outlined" onClick={() => addElement('qrcode')}>+ QR Code</Button>
                <Button size="small" variant="outlined" onClick={() => addElement('box')}>+ Box</Button>
                <Button size="small" variant="outlined" onClick={() => addElement('line')}>+ Line</Button>
              </Stack>
            </Stack>
          </Card>
        </Grid>

        {/* ── Center: wing tabs + canvas. minWidth:0 stops a large/zoomed canvas from forcing
             this flex column wider than its share, which would push the right panel off-screen. ── */}
        <Grid item xs={12} md={6} sx={{ minWidth: 0 }}>
          <Card sx={{ p: 2 }}>
            <Tabs value={activeWing} onChange={(_, v) => { setActiveWing(v); setSelectedElId(null); }} sx={{ mb: 1 }}>
              <Tab value="front" label="Front" />
              <Tab value="back" label="Back" />
            </Tabs>
            <Stack direction="row" alignItems="center" justifyContent="space-between" flexWrap="wrap" gap={1} sx={{ mb: 1 }}>
              <SelectField label="Fold Line" value={foldLine} size="small" sx={{ width: 170 }}
                options={[
                  { value: 'vertical', label: 'Vertical (width)' },
                  { value: 'horizontal', label: 'Horizontal (height)' },
                  { value: 'none', label: 'None' },
                ]}
                onChange={(e) => setFoldLine(e.target.value as 'none' | 'vertical' | 'horizontal')} />
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
                {foldLine === 'vertical' && (
                  <Box sx={{
                    position: 'absolute', top: 0, bottom: 0, left: (form.widthMm / 2) * zoom,
                    borderLeft: '2px dashed', borderColor: 'error.main', pointerEvents: 'none',
                  }} />
                )}
                {foldLine === 'horizontal' && (
                  <Box sx={{
                    position: 'absolute', left: 0, right: 0, top: (form.heightMm / 2) * zoom,
                    borderTop: '2px dashed', borderColor: 'error.main', pointerEvents: 'none',
                  }} />
                )}
                {form.elements.filter((el) => el.wing === activeWing).map((el) => (
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
              Drag an element to reposition it, or edit X/Y precisely in the panel on the right. This is a layout
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
                    <NumberField label="Font Size" value={selectedEl.fontSize ?? 8}
                      onChange={(e) => updateElement(selectedEl.id, { fontSize: Number(e.target.value) })} />
                  )}
                  {(selectedEl.type === 'text' || selectedEl.type === 'barcode' || selectedEl.type === 'qrcode') && (
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
                  {(selectedEl.type === 'box' || selectedEl.type === 'line') && (
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
              <Button variant="contained" color="secondary" startIcon={<Print />}
                disabled={!form.id || !testTagId || testPrintMutation.isPending}
                onClick={() => testPrintMutation.mutate()}>
                {testPrintMutation.isPending ? 'Printing…' : 'Send Test Print'}
              </Button>
            </Stack>
          </Card>
        </Grid>
      </Grid>
    </>
  );
}
