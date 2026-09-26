import { useState, useEffect } from 'react';
import {
  Box, Card, Typography, Button,
  Grid, TextField, Chip, Switch, FormControlLabel, Stack, Divider, Autocomplete,
  ToggleButtonGroup, ToggleButton, Tooltip, List, ListItemButton, ListItemIcon, ListItemText,
} from '@mui/material';
import {
  FileDownload, Category, Collections as CollectionsIcon, Diamond, AutoAwesome,
  AttachMoney, RequestQuote, Store, Delete as DeleteIcon, ChevronLeft, ChevronRight,
  Inventory2, Business,
} from '@mui/icons-material';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm, Controller } from 'react-hook-form';
import { useSnackbar } from 'notistack';
import { apiGet, apiPost, apiPatch, apiDelete } from '../../api/client';
import { PageHeader } from '../../components/common/PageHeader';
import { useTabActive } from '../../components/Layout/TabActiveContext';
import { stoneGradeCode, stoneGradeLabel } from '../../utils/stoneGrade';
import { DataTable } from '../../components/common/DataTable';

function fmtPrice(n: number) {
  return '₹' + Number(n).toLocaleString('en-IN', { maximumFractionDigits: 4 });
}

// Suggested starting points for a Stone Grade's classification fields — not a fixed list.
// Each field is a freeSolo Autocomplete, so any value typed here that isn't in the list
// below is still accepted and saved as-is.
const SHAPE_OPTIONS = ['Round', 'Princess', 'Oval', 'Pear', 'Cushion', 'Emerald', 'Radiant', 'Heart', 'Marquise'];
const COLOR_OPTIONS = ['D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M'];
const CLARITY_OPTIONS = ['FL', 'IF', 'VVS1', 'VVS2', 'VS1', 'VS2', 'SI1', 'SI2', 'I1', 'I2'];
const CUT_OPTIONS = ['Excellent', 'Very Good', 'Good', 'Fair', 'Poor'];
const QUALITY_OPTIONS = ['A', 'AA', 'AAA', 'Premium', 'Commercial'];

// Stone Type's top-level split. Cubic Zirconia is deliberately NOT its own entry here — it's
// graded the same way a diamond is (shape/color/clarity/cut), so it's just another Colour
// Stone row (itemType STONE) rather than a category that would need its own grading rules.
const ITEM_TYPES: Record<string, { label: string; color: 'primary' | 'secondary' | 'info' }> = {
  DIAMOND: { label: 'Diamond', color: 'primary' },
  STONE: { label: 'Colour Stone', color: 'secondary' },
  PEARL: { label: 'Pearl', color: 'info' },
};
const itemTypeLabel = (t?: string | null) => (t && ITEM_TYPES[t]?.label) || t || '—';
const itemTypeColor = (t?: string | null) => (t && ITEM_TYPES[t]?.color) || 'default';

// Delete for a master row. The server only deletes a row nothing references (tags, invoices, rates,
// child rows); an in-use one comes back as a 409 whose message tells the user to deactivate it.
function useMasterDelete() {
  const { enqueueSnackbar } = useSnackbar();
  return (path: string, label: string, onDone: () => void) => {
    if (!window.confirm(`Delete this ${label}? This cannot be undone.`)) return;
    apiDelete(path)
      .then(() => { enqueueSnackbar(`${label} deleted`, { variant: 'success' }); onDone(); })
      .catch((e: any) => enqueueSnackbar(e.response?.data?.error ?? 'Failed', { variant: 'error' }));
  };
}

// ─── Inline add/edit form panel ───────────────────────────────────────────────

function FormPanel({
  title, children, isEdit, saving, disabled, onAdd, onUpdate, onClear, onDelete, oneRow,
}: {
  title: string; children: React.ReactNode; isEdit: boolean; saving?: boolean; disabled?: boolean;
  onAdd: () => void; onUpdate: () => void; onClear: () => void; onDelete?: () => void;
  // Force every field onto a single flex row instead of the default auto-fit grid — for a short,
  // fixed field count (see PriceMasterTab) where wrapping onto a second line wastes the vertical
  // space the whole point of this panel is to reclaim. Not the default: a form with more fields
  // than comfortably fit one row still wants the grid's wrap-as-needed behavior.
  oneRow?: boolean;
}) {
  return (
    <Card variant="outlined" sx={{ p: 2 }}>
      <Typography variant="subtitle2" fontWeight={700} sx={{ mb: 1.5 }}>{title}</Typography>
      {/* Fields lay out side by side instead of stacking one-per-row — a form with 4-6 short
          fields was taking up several screen-heights or width vertically for no reason, starving
          the data table below/beside it of room. A multiline/textarea field opts out via
          `sx={{ gridColumn: '1 / -1' }}` to span the full row instead of squeezing into one cell. */}
      <Box sx={oneRow
        ? { display: 'flex', gap: 1.5, '& > *': { flex: 1, minWidth: 0 } }
        : { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 1.5 }}>
        {children}
      </Box>
      <Stack direction="row" spacing={1} sx={{ mt: 2 }}>
        <Button variant="contained" size="small" disabled={disabled || saving} onClick={isEdit ? onUpdate : onAdd}>
          {isEdit ? 'Update' : 'Add'}
        </Button>
        {isEdit && <Button size="small" onClick={onClear}>Cancel</Button>}
        {isEdit && onDelete && (
          <Button size="small" color="error" startIcon={<DeleteIcon fontSize="small" />} onClick={onDelete}>Delete</Button>
        )}
      </Stack>
    </Card>
  );
}

// ─── Filterable data grid ──────────────────────────────────────────────────
// Thin wrapper over the shared DataTable (client/src/components/common/DataTable.tsx) — Excel-
// style per-column checkbox+search filters, cell gridlines, drag-to-reorder columns, right-click
// column show/hide, in place of the old hand-rolled text-substring filter row. Kept as its own
// name (rather than switching every Masters tab to call DataTable directly) purely so this file's
// ~9 call sites didn't all need a mechanical rename in the same change.

function FilterGrid({
  tableId, columns, rows, isLoading, getRowId, selectedId, selectedIds, onRowClick, emptyLabel, scrollable = true,
}: {
  tableId: string;
  columns: Array<{ key: string; label: string; align?: 'left' | 'right' | 'center'; render?: (row: any) => React.ReactNode; filterValue?: (row: any) => string }>;
  rows: any[]; isLoading: boolean; getRowId: (row: any) => string;
  selectedId?: string; onRowClick?: (row: any, e: React.MouseEvent) => void; emptyLabel: string;
  // Multi-row selection (e.g. click-then-ctrl+click, Ctrl+Delete to remove) — see PriceMasterTab.
  // Independent of `selectedId`, which is the older single-row "load into the edit form" highlight.
  selectedIds?: Set<string>;
  // Default (true) is the §3 UI_DESIGN_GUIDE pattern — a wide table gets its own horizontal
  // scroll container instead of clipping. Set false only for a table whose columns are meant to
  // share the panel's full width and shrink together instead (see PriceMasterTab) — every cell
  // then needs to tolerate wrapping/truncating rather than forcing a fixed pixel width.
  scrollable?: boolean;
}) {
  return (
    <DataTable
      tableId={tableId} columns={columns} rows={rows} isLoading={isLoading} getRowId={getRowId}
      selectedId={selectedId} selectedIds={selectedIds} onRowClick={onRowClick} emptyLabel={emptyLabel}
      scrollable={scrollable}
    />
  );
}

// ─── Directly-editable table cell (click in, type, blur/Enter to commit) ─────
// For grids where the record already exists per-row and re-selecting it into a side form to
// change one field is more clicks than the edit is worth — see PriceMasterTab. Only wrap fields
// that are genuinely meant to move often (Price/ct, the weight slab, Effective Date). PriceMaster's
// Stone/Shape/Color/Clarity/Cut/Quality are a classification snapshot taken from the Grade when
// the row was created (schema.prisma) — those stay plain read-only text.

function EditableCell({
  value, onCommit, type = 'text', width, align,
}: {
  value: string | number | null | undefined; onCommit: (value: string) => void;
  // Omit width to fill the cell instead — use this inside a non-scrollable table (see
  // FilterGrid's `scrollable` prop) where columns must shrink to share the panel's width rather
  // than force a fixed pixel size that pushes the table into horizontal overflow.
  type?: string; width?: number; align?: 'left' | 'right' | 'center';
}) {
  const initial = value == null ? '' : String(value);
  const [val, setVal] = useState(initial);
  useEffect(() => setVal(initial), [initial]);

  return (
    <TextField
      variant="standard" size="small" type={type} value={val} fullWidth={width == null}
      sx={{
        ...(width != null && { width }),
        // Hide the native calendar-picker icon on date cells — keeps the row a plain typed
        // date field instead of a button that pops a picker.
        ...(type === 'date' && { '& input::-webkit-calendar-picker-indicator': { display: 'none' } }),
        // Hide the native up/down spinner on number cells — it eats width a narrow table column
        // can't spare, and was clipping values like "0.00" in the Wt Slab column.
        ...(type === 'number' && {
          '& input[type=number]': { MozAppearance: 'textfield' },
          '& input[type=number]::-webkit-outer-spin-button, & input[type=number]::-webkit-inner-spin-button': {
            WebkitAppearance: 'none', margin: 0,
          },
        }),
      }}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => setVal(e.target.value)}
      onBlur={() => { if (val !== initial) onCommit(val); }}
      onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
      // Scrolling over a focused number input is a native browser behavior that bumps the
      // value — surprising inside a dense table where the mouse is just passing through on its
      // way to scroll the page. Blur on wheel so a hover-scroll can't silently edit a price.
      onWheel={type === 'number' ? (e) => (e.target as HTMLInputElement).blur() : undefined}
      InputProps={{ disableUnderline: true }}
      inputProps={{ style: align ? { textAlign: align } : undefined }}
    />
  );
}

// ─── Generic simple master (Collections) ─────────────────────────────────────
// Material Codes used to live here too, but moved to its own MaterialCodesTab below once it
// needed a live Karat dropdown — GenericMasterSection's `fields` only support static options.

function GenericMasterSection({
  title, description, queryKey, apiPath, listParams, invalidateKeys, columns, fields,
}: {
  title: string; description?: string; queryKey: string; apiPath: string; listParams?: Record<string, any>; invalidateKeys?: string[];
  columns: Array<{ key: string; label: string; render?: (row: any) => React.ReactNode; filterValue?: (row: any) => string }>;
  fields: Array<{ name: string; label: string; type?: string; required?: boolean; options?: string[] }>;
}) {
  const { enqueueSnackbar } = useSnackbar();
  const qc = useQueryClient();
  const [selected, setSelected] = useState<any>(null);
  const deleteMaster = useMasterDelete();

  const { data, isLoading } = useQuery({ queryKey: [queryKey], queryFn: () => apiGet<any>(apiPath, listParams) });
  const rows: any[] = (data as any)?.data ?? data ?? [];

  const defaultVals: any = {};
  fields.forEach((f) => { defaultVals[f.name] = f.type === 'boolean' ? true : ''; });
  const { control, handleSubmit, reset } = useForm({ defaultValues: defaultVals });

  const mutation = useMutation({
    mutationFn: (data: any) => (selected ? apiPatch(`${apiPath}/${selected.id}`, data) : apiPost(apiPath, data)),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [queryKey] });
      invalidateKeys?.forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
      enqueueSnackbar(selected ? 'Updated' : 'Created', { variant: 'success' });
      setSelected(null); reset(defaultVals);
    },
    onError: (e: any) => enqueueSnackbar(e.response?.data?.error ?? 'Failed', { variant: 'error' }),
  });

  const toggleActive = (row: any) => {
    apiPatch(`${apiPath}/${row.id}`, { isActive: !row.isActive })
      .then(() => {
        qc.invalidateQueries({ queryKey: [queryKey] });
        invalidateKeys?.forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
      })
      .catch((e: any) => enqueueSnackbar(e.response?.data?.error ?? 'Failed', { variant: 'error' }));
  };

  const selectRow = (row: any) => {
    setSelected(row);
    const vals: any = {};
    fields.forEach((f) => { vals[f.name] = row[f.name] ?? (f.type === 'boolean' ? true : ''); });
    reset(vals);
  };

  return (
    <>
      {description && <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>{description}</Typography>}
      <Grid container spacing={2}>
      <Grid item xs={12} md={4}>
        <FormPanel title={selected ? `Edit ${title}` : `New ${title}`} isEdit={!!selected} saving={mutation.isPending}
          onAdd={handleSubmit((d) => mutation.mutate(d))} onUpdate={handleSubmit((d) => mutation.mutate(d))}
          onClear={() => { setSelected(null); reset(defaultVals); }}
          onDelete={selected ? () => deleteMaster(`${apiPath}/${selected.id}`, title.toLowerCase(), () => {
            qc.invalidateQueries({ queryKey: [queryKey] });
            invalidateKeys?.forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
            setSelected(null); reset(defaultVals);
          }) : undefined}>
          {fields.map((f) => (
            <Controller key={f.name} name={f.name} control={control} rules={{ required: f.required }}
              render={({ field, fieldState }) => {
                if (f.type === 'boolean') {
                  return <FormControlLabel control={<Switch checked={!!field.value} onChange={(e) => field.onChange(e.target.checked)} />} label={f.label} />;
                }
                if (f.options) {
                  return <TextField {...field} select fullWidth size="small" label={f.label} error={!!fieldState.error}
                    SelectProps={{ native: true }}>
                    <option value="" />
                    {f.options.map((o) => <option key={o} value={o}>{o}</option>)}
                  </TextField>;
                }
                return <TextField {...field} fullWidth size="small" label={f.label} error={!!fieldState.error}
                  helperText={fieldState.error && 'Required'}
                  multiline={f.type === 'textarea'} rows={f.type === 'textarea' ? 2 : undefined}
                  type={f.type === 'number' ? 'number' : undefined}
                  sx={f.type === 'textarea' ? { gridColumn: '1 / -1' } : undefined} />;
              }} />
          ))}
        </FormPanel>
      </Grid>
      <Grid item xs={12} md={8}>
        <FilterGrid
          tableId={`masters-generic-${queryKey}`}
          columns={[
            ...columns,
            {
              key: 'isActive', label: 'Status',
              filterValue: (r: any) => (r.isActive ? 'Active' : 'Inactive'),
              render: (r: any) => (
                <Chip label={r.isActive ? 'Active' : 'Inactive'} size="small" color={r.isActive ? 'success' : 'default'}
                  sx={{ cursor: 'pointer' }} onClick={(e) => { e.stopPropagation(); toggleActive(r); }} />
              ),
            },
          ]}
          rows={rows} isLoading={isLoading} getRowId={(r: any) => r.id} selectedId={selected?.id}
          emptyLabel={`No ${title.toLowerCase()}s yet`} onRowClick={selectRow}
        />
      </Grid>
    </Grid>
    </>
  );
}

// ─── Categories & Sub-categories ──────────────────────────────────────────────

function CategoriesTab() {
  const { enqueueSnackbar } = useSnackbar();
  const qc = useQueryClient();
  const [selectedCat, setSelectedCat] = useState<any>(null);
  const [selectedSub, setSelectedSub] = useState<any>(null);
  const deleteMaster = useMasterDelete();

  const { data: catData, isLoading: catLoading } = useQuery({
    queryKey: ['master-categories'],
    queryFn: () => apiGet<any>('/masters/categories'),
  });
  const categories: any[] = (catData as any)?.data ?? (catData as any) ?? [];

  const { data: subData, isLoading: subLoading } = useQuery({
    queryKey: ['master-subcategories', selectedCat?.id ?? ''],
    queryFn: () => apiGet<any>('/masters/subcategories', { categoryId: selectedCat?.id || undefined }),
  });
  const subCategories: any[] = (subData as any)?.data ?? (subData as any) ?? [];

  const catDefaults = { code: '', name: '' };
  const { control: catControl, handleSubmit: handleCatSubmit, reset: resetCat } = useForm({ defaultValues: catDefaults });
  const catMutation = useMutation({
    mutationFn: (data: any) => (selectedCat ? apiPatch(`/masters/categories/${selectedCat.id}`, data) : apiPost('/masters/categories', data)),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['master-categories'] });
      enqueueSnackbar(selectedCat ? 'Category updated' : 'Category created', { variant: 'success' });
      setSelectedCat(null); resetCat(catDefaults);
    },
    onError: (e: any) => enqueueSnackbar(e.response?.data?.error ?? 'Failed', { variant: 'error' }),
  });

  const subDefaults = { code: '', name: '' };
  const { control: subControl, handleSubmit: handleSubSubmit, reset: resetSub } = useForm({ defaultValues: subDefaults });
  const subMutation = useMutation({
    mutationFn: (data: any) => (selectedSub
      ? apiPatch(`/masters/subcategories/${selectedSub.id}`, data)
      : apiPost('/masters/subcategories', { ...data, categoryId: selectedCat?.id })),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['master-subcategories'] });
      enqueueSnackbar(selectedSub ? 'Sub-category updated' : 'Sub-category created', { variant: 'success' });
      setSelectedSub(null); resetSub(subDefaults);
    },
    onError: (e: any) => enqueueSnackbar(e.response?.data?.error ?? 'Failed', { variant: 'error' }),
  });

  const toggleActive = (path: string, qk: string, id: string, val: boolean) => {
    apiPatch(`${path}/${id}`, { isActive: !val })
      .then(() => qc.invalidateQueries({ queryKey: [qk] }))
      .catch((e: any) => enqueueSnackbar(e.response?.data?.error ?? 'Failed', { variant: 'error' }));
  };

  // Two equal-width columns, each form-on-top / table-below — categories and
  // sub-categories get the same width and the same shape, side by side.
  return (
    <Grid container spacing={2}>
      <Grid item xs={12} md={6}>
        <Stack spacing={1.5}>
          <Typography variant="subtitle2" fontWeight={700}>Categories</Typography>
          <FormPanel title={selectedCat ? `Edit — ${selectedCat.code}` : 'New Category'}
            isEdit={!!selectedCat} saving={catMutation.isPending}
            onAdd={handleCatSubmit((d) => catMutation.mutate(d))}
            onUpdate={handleCatSubmit((d) => catMutation.mutate(d))}
            onClear={() => { setSelectedCat(null); setSelectedSub(null); resetCat(catDefaults); }}
            onDelete={selectedCat ? () => deleteMaster(`/masters/categories/${selectedCat.id}`, 'category', () => {
              qc.invalidateQueries({ queryKey: ['master-categories'] });
              setSelectedCat(null); setSelectedSub(null); resetCat(catDefaults);
            }) : undefined}>
            <Controller name="code" control={catControl} rules={{ required: true }}
              render={({ field, fieldState }) => <TextField {...field} fullWidth size="small" label="Category Code *" error={!!fieldState.error} />} />
            <Controller name="name" control={catControl} rules={{ required: true }}
              render={({ field, fieldState }) => <TextField {...field} fullWidth size="small" label="Category Name *" error={!!fieldState.error} />} />
          </FormPanel>
          <FilterGrid
            tableId="masters-categories"
            columns={[
              { key: 'code', label: 'Code', render: (r: any) => <Typography fontFamily="monospace" fontWeight={700} color="#44C47A" fontSize={12}>{r.code}</Typography> },
              { key: 'name', label: 'Name' },
              { key: 'subCount', label: 'Sub-cats', filterValue: (r: any) => String(r._count?.subCategories ?? 0), render: (r: any) => <Chip label={r._count?.subCategories ?? 0} size="small" /> },
            ]}
            rows={categories} isLoading={catLoading} getRowId={(r: any) => r.id}
            selectedId={selectedCat?.id} emptyLabel="No categories yet"
            onRowClick={(row: any) => { setSelectedCat(row); setSelectedSub(null); resetCat({ code: row.code, name: row.name }); }}
          />
        </Stack>
      </Grid>

      <Grid item xs={12} md={6}>
        <Stack spacing={1.5}>
          <Typography variant="subtitle2" fontWeight={700}>
            Sub-categories{selectedCat ? ` — ${selectedCat.name}` : ' (select a category)'}
          </Typography>
          <FormPanel title={selectedSub ? `Edit — ${selectedSub.code}` : 'New Sub-category'}
            isEdit={!!selectedSub} saving={subMutation.isPending} disabled={!selectedCat}
            onAdd={handleSubSubmit((d) => subMutation.mutate(d))}
            onUpdate={handleSubSubmit((d) => subMutation.mutate(d))}
            onClear={() => { setSelectedSub(null); resetSub(subDefaults); }}
            onDelete={selectedSub ? () => deleteMaster(`/masters/subcategories/${selectedSub.id}`, 'sub-category', () => {
              qc.invalidateQueries({ queryKey: ['master-subcategories'] });
              qc.invalidateQueries({ queryKey: ['master-categories'] });
              setSelectedSub(null); resetSub(subDefaults);
            }) : undefined}>
            <Controller name="code" control={subControl} rules={{ required: true }}
              render={({ field, fieldState }) => <TextField {...field} fullWidth size="small" label="Sub-category Code *" disabled={!selectedCat} error={!!fieldState.error} />} />
            <Controller name="name" control={subControl} rules={{ required: true }}
              render={({ field, fieldState }) => <TextField {...field} fullWidth size="small" label="Sub-category Name *" disabled={!selectedCat} error={!!fieldState.error} />} />
          </FormPanel>
          <FilterGrid
            tableId="masters-subcategories"
            columns={[
              { key: 'code', label: 'Code', render: (r: any) => <Typography fontFamily="monospace" fontWeight={700} color="#44C47A" fontSize={12}>{r.code}</Typography> },
              { key: 'name', label: 'Name' },
              { key: 'category', label: 'Category', filterValue: (r: any) => r.category?.name ?? '', render: (r: any) => r.category?.name },
              {
                key: 'isActive', label: 'Status',
                filterValue: (r: any) => (r.isActive ? 'Active' : 'Inactive'),
                render: (r: any) => (
                  <Chip label={r.isActive ? 'Active' : 'Inactive'} size="small" color={r.isActive ? 'success' : 'default'}
                    sx={{ cursor: 'pointer' }}
                    onClick={(e) => { e.stopPropagation(); toggleActive('/masters/subcategories', 'master-subcategories', r.id, r.isActive); }} />
                ),
              },
            ]}
            rows={subCategories} isLoading={subLoading} getRowId={(r: any) => r.id}
            selectedId={selectedSub?.id} emptyLabel={selectedCat ? 'No sub-categories' : 'Select a category to view'}
            onRowClick={(row: any) => { setSelectedSub(row); resetSub({ code: row.code, name: row.name }); }}
          />
        </Stack>
      </Grid>
    </Grid>
  );
}

// ─── Stone Types & Stone Grades ──────────────────────────────────────────────
// Stone Type = base gem identity (Diamond, Ruby...), reused across every combination.
// Stone Grade = a specific, reusable shape/color/clarity/cut (diamond) or quality (colored
// stone) combination for that gem — defined once here, then just picked (never re-typed)
// by any number of Price Master entries over time. Same master-detail shape as
// Categories/Sub-categories above.

function StoneTypesTab() {
  const { enqueueSnackbar } = useSnackbar();
  const qc = useQueryClient();
  const [selectedType, setSelectedType] = useState<any>(null);
  const [selectedGrade, setSelectedGrade] = useState<any>(null);
  const deleteMaster = useMasterDelete();

  const { data: typeData, isLoading: typeLoading } = useQuery({
    queryKey: ['master-stone-types'], queryFn: () => apiGet<any>('/masters/stone-types'),
  });
  const stoneTypes: any[] = (typeData as any)?.data ?? typeData ?? [];

  const { data: gradeData, isLoading: gradeLoading } = useQuery({
    queryKey: ['master-stone-grades', selectedType?.id ?? ''],
    queryFn: () => apiGet<any>('/masters/stone-grades', { stoneTypeId: selectedType?.id || undefined }),
  });
  const stoneGrades: any[] = (gradeData as any)?.data ?? gradeData ?? [];

  // Unfiltered, across every stone type — feeds the Shape/Color/Clarity/Cut/Quality autocomplete
  // suggestions below so a value typed once (e.g. a custom "E-F" color bucket) shows up as a
  // suggestion for every grade entered after it, not just the fixed starter list. Same
  // invalidation key prefix as the per-type query above, so a new grade refreshes both.
  const { data: allGradesData } = useQuery({
    queryKey: ['master-stone-grades', 'all'], queryFn: () => apiGet<any>('/masters/stone-grades'),
  });
  const allGrades: any[] = (allGradesData as any)?.data ?? allGradesData ?? [];
  const usedValues = (field: 'shape' | 'color' | 'clarity' | 'cut' | 'quality') =>
    Array.from(new Set(allGrades.map((g) => g[field]).filter(Boolean)));
  const shapeSuggestions = Array.from(new Set([...SHAPE_OPTIONS, ...usedValues('shape')]));
  const colorSuggestions = Array.from(new Set([...COLOR_OPTIONS, ...usedValues('color')]));
  const claritySuggestions = Array.from(new Set([...CLARITY_OPTIONS, ...usedValues('clarity')]));
  const cutSuggestions = Array.from(new Set([...CUT_OPTIONS, ...usedValues('cut')]));
  const qualitySuggestions = Array.from(new Set([...QUALITY_OPTIONS, ...usedValues('quality')]));

  const typeDefaults = { code: '', name: '', itemType: '', unit: 'CT', description: '' };
  const { control: typeControl, handleSubmit: handleTypeSubmit, reset: resetType } = useForm({ defaultValues: typeDefaults });
  const typeMutation = useMutation({
    mutationFn: (data: any) => (selectedType ? apiPatch(`/masters/stone-types/${selectedType.id}`, data) : apiPost('/masters/stone-types', data)),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['master-stone-types'] });
      enqueueSnackbar(selectedType ? 'Stone type updated' : 'Stone type created', { variant: 'success' });
      setSelectedType(null); resetType(typeDefaults);
    },
    onError: (e: any) => enqueueSnackbar(e.response?.data?.error ?? 'Failed', { variant: 'error' }),
  });

  const gradeDefaults = { shape: '', color: '', clarity: '', cut: '', quality: '' };
  const { control: gradeControl, handleSubmit: handleGradeSubmit, reset: resetGrade } = useForm({ defaultValues: gradeDefaults });
  const gradeMutation = useMutation({
    mutationFn: (data: any) => (selectedGrade
      ? apiPatch(`/masters/stone-grades/${selectedGrade.id}`, data)
      : apiPost('/masters/stone-grades', { ...data, stoneTypeId: selectedType?.id })),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['master-stone-grades'] });
      enqueueSnackbar(selectedGrade ? 'Stone grade updated' : 'Stone grade created', { variant: 'success' });
      setSelectedGrade(null); resetGrade(gradeDefaults);
    },
    onError: (e: any) => enqueueSnackbar(e.response?.data?.error ?? 'Failed', { variant: 'error' }),
  });

  const toggleTypeActive = (row: any) => {
    apiPatch(`/masters/stone-types/${row.id}`, { isActive: !row.isActive })
      .then(() => qc.invalidateQueries({ queryKey: ['master-stone-types'] }))
      .catch((e: any) => enqueueSnackbar(e.response?.data?.error ?? 'Failed', { variant: 'error' }));
  };
  const toggleGradeActive = (row: any) => {
    apiPatch(`/masters/stone-grades/${row.id}`, { isActive: !row.isActive })
      .then(() => qc.invalidateQueries({ queryKey: ['master-stone-grades'] }))
      .catch((e: any) => enqueueSnackbar(e.response?.data?.error ?? 'Failed', { variant: 'error' }));
  };

  return (
    <>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
        Gemstones and diamonds only — Diamond, Colour Stone (includes Cubic Zirconia, graded the same
        way as a diamond), or Pearl. Every grade can carry shape/color/clarity/cut and/or quality —
        fill in whichever apply to that gem and leave the rest blank — then it's priced by the Price
        Master rate card for that exact grade and weight. Metals and other generic items belong under
        Material Codes instead, which prices by a flat Making Charge.
      </Typography>
      <Grid container spacing={2}>
      <Grid item xs={12} md={6}>
        <Stack spacing={1.5}>
          <Typography variant="subtitle2" fontWeight={700}>Stone Types</Typography>
          <FormPanel title={selectedType ? `Edit — ${selectedType.code}` : 'New Stone Type'} isEdit={!!selectedType} saving={typeMutation.isPending}
            onAdd={handleTypeSubmit((d) => typeMutation.mutate(d))} onUpdate={handleTypeSubmit((d) => typeMutation.mutate(d))}
            onClear={() => { setSelectedType(null); setSelectedGrade(null); resetType(typeDefaults); }}
            onDelete={selectedType ? () => deleteMaster(`/masters/stone-types/${selectedType.id}`, 'stone type', () => {
              qc.invalidateQueries({ queryKey: ['master-stone-types'] });
              setSelectedType(null); setSelectedGrade(null); resetType(typeDefaults);
            }) : undefined}>
            <Controller name="itemType" control={typeControl} rules={{ required: true }} render={({ field, fieldState }) => (
              <TextField {...field} select fullWidth size="small" label="Item Type *" error={!!fieldState.error} SelectProps={{ native: true }}>
                <option value="" />
                <option value="DIAMOND">Diamond</option>
                <option value="STONE">Colour Stone (incl. CZ)</option>
                <option value="PEARL">Pearl</option>
              </TextField>
            )} />
            <Controller name="code" control={typeControl} rules={{ required: true }} render={({ field, fieldState }) => (
              <TextField {...field} fullWidth size="small" label="Code (e.g. DIA, RUB) *" error={!!fieldState.error} />
            )} />
            <Controller name="name" control={typeControl} rules={{ required: true }} render={({ field, fieldState }) => (
              <TextField {...field} fullWidth size="small" label="Name (e.g. Diamond, Ruby) *" error={!!fieldState.error} />
            )} />
            <Controller name="unit" control={typeControl} render={({ field }) => (
              <TextField {...field} select fullWidth size="small" label="Unit" SelectProps={{ native: true }}
                InputLabelProps={{ shrink: true }} helperText="How this stone is measured when tagged — carats (pieces/parcels) or grams (bulk lots)">
                <option value="CT">Carats (CT)</option>
                <option value="GM">Grams (GM)</option>
              </TextField>
            )} />
            <Controller name="description" control={typeControl} render={({ field }) => <TextField {...field} fullWidth size="small" label="Description" multiline rows={2} sx={{ gridColumn: '1 / -1' }} />} />
          </FormPanel>
          <FilterGrid
            tableId="masters-stone-types"
            columns={[
              { key: 'code', label: 'Code', render: (r: any) => <Typography fontFamily="monospace" fontWeight={700} color="#44C47A" fontSize={12}>{r.code}</Typography> },
              { key: 'name', label: 'Name' },
              { key: 'itemType', label: 'Type', filterValue: (r: any) => itemTypeLabel(r.itemType), render: (r: any) => <Chip label={itemTypeLabel(r.itemType)} size="small" color={itemTypeColor(r.itemType)} /> },
              { key: 'unit', label: 'Unit', render: (r: any) => r.unit ?? 'CT' },
              {
                key: 'isActive', label: 'Status',
                filterValue: (r: any) => (r.isActive ? 'Active' : 'Inactive'),
                render: (r: any) => (
                  <Chip label={r.isActive ? 'Active' : 'Inactive'} size="small" color={r.isActive ? 'success' : 'default'}
                    sx={{ cursor: 'pointer' }} onClick={(e) => { e.stopPropagation(); toggleTypeActive(r); }} />
                ),
              },
            ]}
            rows={stoneTypes} isLoading={typeLoading} getRowId={(r: any) => r.id} selectedId={selectedType?.id}
            emptyLabel="No stone types yet"
            onRowClick={(row: any) => {
              setSelectedType(row); setSelectedGrade(null);
              resetType({ code: row.code, name: row.name, itemType: row.itemType ?? '', unit: row.unit ?? 'CT', description: row.description ?? '' });
            }}
          />
        </Stack>
      </Grid>

      <Grid item xs={12} md={6}>
        <Stack spacing={1.5}>
          <Typography variant="subtitle2" fontWeight={700}>
            Stone Grades{selectedType ? ` — ${selectedType.name}` : ' (select a stone type)'}
          </Typography>
          <FormPanel title={selectedGrade ? 'Edit Stone Grade' : 'New Stone Grade'} isEdit={!!selectedGrade} saving={gradeMutation.isPending}
            disabled={!selectedType}
            onAdd={handleGradeSubmit((d) => gradeMutation.mutate(d))} onUpdate={handleGradeSubmit((d) => gradeMutation.mutate(d))}
            onClear={() => { setSelectedGrade(null); resetGrade(gradeDefaults); }}
            onDelete={selectedGrade ? () => deleteMaster(`/masters/stone-grades/${selectedGrade.id}`, 'stone grade', () => {
              qc.invalidateQueries({ queryKey: ['master-stone-grades'] });
              setSelectedGrade(null); resetGrade(gradeDefaults);
            }) : undefined}>
            {/* Not gated by itemType — CZ (itemType STONE) still needs diamond-style shape/color/
                clarity/cut, and a fancy-color diamond can want a quality note too. Every field is
                optional, so just leave whichever don't apply to this gem blank. */}
            {selectedType ? <>
              <Controller name="shape" control={gradeControl} render={({ field: { onChange, value, ...field } }) => (
                <Autocomplete freeSolo options={shapeSuggestions} value={value || null}
                  onChange={(_, v) => onChange(v ?? '')} onInputChange={(_, v) => onChange(v)}
                  renderInput={(params) => <TextField {...params} {...field} size="small" label="Shape" helperText="Pick one or type a new shape — it's remembered for next time" />} />
              )} />
              <Controller name="color" control={gradeControl} render={({ field: { onChange, value, ...field } }) => (
                <Autocomplete freeSolo options={colorSuggestions} value={value || null}
                  onChange={(_, v) => onChange(v ?? '')} onInputChange={(_, v) => onChange(v)}
                  renderInput={(params) => <TextField {...params} {...field} size="small" label="Color Grade" helperText="Pick one or type a new grade — it's remembered for next time" />} />
              )} />
              <Controller name="clarity" control={gradeControl} render={({ field: { onChange, value, ...field } }) => (
                <Autocomplete freeSolo options={claritySuggestions} value={value || null}
                  onChange={(_, v) => onChange(v ?? '')} onInputChange={(_, v) => onChange(v)}
                  renderInput={(params) => <TextField {...params} {...field} size="small" label="Clarity" helperText="Pick one or type a new grade — it's remembered for next time" />} />
              )} />
              <Controller name="cut" control={gradeControl} render={({ field: { onChange, value, ...field } }) => (
                <Autocomplete freeSolo options={cutSuggestions} value={value || null}
                  onChange={(_, v) => onChange(v ?? '')} onInputChange={(_, v) => onChange(v)}
                  renderInput={(params) => <TextField {...params} {...field} size="small" label="Cut" helperText="Pick one or type a new grade — it's remembered for next time" />} />
              )} />
              <Controller name="quality" control={gradeControl} render={({ field: { onChange, value, ...field } }) => (
                <Autocomplete freeSolo options={qualitySuggestions} value={value || null}
                  onChange={(_, v) => onChange(v ?? '')} onInputChange={(_, v) => onChange(v)}
                  renderInput={(params) => <TextField {...params} {...field} size="small" label="Quality Grade" helperText="Pick one or type a new grade — it's remembered for next time" />} />
              )} />
            </> : <Typography variant="caption" color="text.secondary">Select a stone type on the left first.</Typography>}
          </FormPanel>
          {/* Code already encodes Shape/Clarity/Color (and Quality, for a colour stone) — see
              stoneGradeCode() — so this stays lean: Code + the one thing it doesn't carry (Cut)
              + Status, instead of six columns repeating the same grade six different ways. */}
          <FilterGrid
            tableId="masters-stone-grades"
            columns={[
              { key: 'code', label: 'Code', filterValue: (r: any) => stoneGradeCode(r), render: (r: any) => <Typography fontFamily="monospace" fontWeight={700} color="#44C47A" fontSize={12}>{stoneGradeCode(r)}</Typography> },
              { key: 'cut', label: 'Cut', render: (r: any) => r.cut || '—' },
              {
                key: 'isActive', label: 'Status',
                filterValue: (r: any) => (r.isActive ? 'Active' : 'Inactive'),
                render: (r: any) => (
                  <Chip label={r.isActive ? 'Active' : 'Inactive'} size="small" color={r.isActive ? 'success' : 'default'}
                    sx={{ cursor: 'pointer' }} onClick={(e) => { e.stopPropagation(); toggleGradeActive(r); }} />
                ),
              },
            ]}
            rows={stoneGrades} isLoading={gradeLoading} getRowId={(r: any) => r.id} selectedId={selectedGrade?.id}
            emptyLabel={selectedType ? 'No grades yet' : 'Select a stone type to view'}
            onRowClick={(row: any) => {
              setSelectedGrade(row);
              resetGrade({ shape: row.shape ?? '', color: row.color ?? '', clarity: row.clarity ?? '', cut: row.cut ?? '', quality: row.quality ?? '' });
            }}
          />
        </Stack>
      </Grid>
    </Grid>
    </>
  );
}

// ─── Price Master ──────────────────────────────────────────────────────────────

function PriceMasterTab() {
  const { enqueueSnackbar } = useSnackbar();
  const qc = useQueryClient();
  const [itemTypeFilter, setItemTypeFilter] = useState('');

  const { data: gradesData } = useQuery({ queryKey: ['master-stone-grades'], queryFn: () => apiGet<any>('/masters/stone-grades') });
  const grades: any[] = (gradesData as any)?.data ?? (gradesData as any) ?? [];

  const { data, isLoading } = useQuery({
    queryKey: ['master-price', itemTypeFilter],
    queryFn: () => apiGet<any>('/masters/price-master', { itemType: itemTypeFilter || undefined }),
  });
  const prices: any[] = (data as any)?.data ?? (data as any) ?? [];

  const defaultVals = {
    stoneGradeId: '', weightFrom: '', weightTo: '', pricePerCarat: '',
    effectiveDate: new Date().toISOString().split('T')[0],
  };
  const { control, handleSubmit, reset } = useForm({ defaultValues: defaultVals });

  // Row selection for bulk delete: plain click selects only that row, Ctrl/Cmd+click toggles it
  // into/out of the selection, and Ctrl+Delete removes everything selected — replaces the old
  // per-row delete icon.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const toggleRow = (row: any, e: React.MouseEvent) => {
    setSelectedIds((prev) => {
      const next = (e.ctrlKey || e.metaKey) ? new Set(prev) : new Set<string>();
      if (next.has(row.id)) next.delete(row.id); else next.add(row.id);
      return next;
    });
  };

  const createMutation = useMutation({
    mutationFn: (data: any) => apiPost('/masters/price-master', data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['master-price'] });
      enqueueSnackbar('Price entry created', { variant: 'success' });
      reset(defaultVals);
    },
    onError: (e: any) => enqueueSnackbar(e.response?.data?.error ?? 'Failed', { variant: 'error' }),
  });

  // Cell-level edits (Price/ct, Effective Date, Notes) PATCH straight from the table — see
  // EditableCell. Everything else in a row (Stone/Shape/Color/Clarity/Cut/Quality/Wt Slab) is a
  // classification snapshot taken from the Grade at write time (schema.prisma: PriceMaster) and
  // deliberately stays read-only here; re-classifying a price entry means creating a new one
  // against the right Grade, not editing history in place.
  const patchMutation = useMutation({
    mutationFn: ({ id, data }: { id: string; data: any }) => apiPatch(`/masters/price-master/${id}`, data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['master-price'] }),
    onError: (e: any) => enqueueSnackbar(e.response?.data?.error ?? 'Update failed', { variant: 'error' }),
  });

  // A window-level handler: a Masters tab kept open in the background must not act on Ctrl+Delete typed elsewhere.
  const tabActive = useTabActive();
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const isEditingField = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA';
      if (!tabActive || !(e.ctrlKey || e.metaKey) || e.key !== 'Delete' || selectedIds.size === 0 || isEditingField) return;
      e.preventDefault();
      const ids = Array.from(selectedIds);
      Promise.all(ids.map((id) => apiDelete(`/masters/price-master/${id}`)))
        .then(() => {
          qc.invalidateQueries({ queryKey: ['master-price'] });
          enqueueSnackbar(`${ids.length} price ${ids.length === 1 ? 'entry' : 'entries'} deleted`, { variant: 'success' });
          setSelectedIds(new Set());
        })
        .catch((e: any) => enqueueSnackbar(e.response?.data?.error ?? 'Delete failed', { variant: 'error' }));
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [tabActive, selectedIds, qc, enqueueSnackbar]);

  return (
    <Box>
      <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 2 }}>
        <ToggleButtonGroup size="small" value={itemTypeFilter} exclusive onChange={(_, v) => setItemTypeFilter(v ?? '')}>
          <ToggleButton value="">All</ToggleButton>
          <ToggleButton value="DIAMOND">Diamonds</ToggleButton>
          <ToggleButton value="STONE">Colored Stones</ToggleButton>
          <ToggleButton value="PEARL">Pearls</ToggleButton>
        </ToggleButtonGroup>
      </Stack>

      <Stack spacing={2}>
        <FormPanel title="New Price Entry" isEdit={false} saving={createMutation.isPending} oneRow
          onAdd={handleSubmit((d) => createMutation.mutate(d))} onUpdate={() => {}}
          onClear={() => reset(defaultVals)}>
          <Controller name="stoneGradeId" control={control} rules={{ required: true }} render={({ field, fieldState }) => (
            <TextField {...field} select fullWidth size="small" label="Stone Grade *" error={!!fieldState.error} SelectProps={{ native: true }}>
              <option value="" />
              {grades.map((g: any) => <option key={g.id} value={g.id}>{stoneGradeLabel(g)}</option>)}
            </TextField>
          )} />
          {/* Weight slab applies to any grade, not just diamonds — CZ and pearls can be priced by
              carat band too. */}
          <Controller name="weightFrom" control={control} render={({ field }) => <TextField {...field} fullWidth size="small" label="Weight Slab From (ct)" type="number" inputProps={{ step: 0.01, min: 0 }} />} />
          <Controller name="weightTo" control={control} render={({ field }) => <TextField {...field} fullWidth size="small" label="Weight Slab To (ct)" type="number" inputProps={{ step: 0.01, min: 0 }} />} />
          <Controller name="pricePerCarat" control={control} rules={{ required: true }} render={({ field, fieldState }) => (
            <TextField {...field} fullWidth size="small" label="Price per Carat (₹) *" type="number" inputProps={{ step: 0.01, min: 0 }} error={!!fieldState.error} />
          )} />
          <Controller name="effectiveDate" control={control} render={({ field }) => (
            <TextField {...field} fullWidth size="small" label="Effective Date" type="date" InputLabelProps={{ shrink: true }} />
          )} />
        </FormPanel>
        <Box>
          <FilterGrid
            tableId="masters-price-master"
            columns={[
              { key: 'itemType', label: 'Type', filterValue: (p: any) => itemTypeLabel(p.itemType), render: (p: any) => <Chip label={itemTypeLabel(p.itemType)} size="small" color={itemTypeColor(p.itemType)} /> },
              { key: 'stone', label: 'Stone', filterValue: (p: any) => p.stoneGrade?.stoneType?.name ?? '', render: (p: any) => p.stoneGrade?.stoneType?.name },
              { key: 'shape', label: 'Shape', render: (p: any) => p.shape ?? '—' },
              { key: 'color', label: 'Color', render: (p: any) => p.color ?? '—' },
              { key: 'clarity', label: 'Clarity', render: (p: any) => p.clarity ?? '—' },
              { key: 'cut', label: 'Cut', render: (p: any) => p.cut ?? '—' },
              {
                key: 'weight', label: 'Wt Slab (ct)',
                filterValue: (p: any) => (p.weightFrom != null ? `${p.weightFrom}-${p.weightTo}` : ''),
                render: (p: any) => (
                  <Stack direction="row" spacing={0.5} alignItems="center">
                    <EditableCell value={p.weightFrom != null ? Number(p.weightFrom) : ''} type="number" width={64}
                      onCommit={(v) => patchMutation.mutate({ id: p.id, data: { weightFrom: v === '' ? null : v } })} />
                    <Typography variant="caption" color="text.secondary">–</Typography>
                    <EditableCell value={p.weightTo != null ? Number(p.weightTo) : ''} type="number" width={64}
                      onCommit={(v) => patchMutation.mutate({ id: p.id, data: { weightTo: v === '' ? null : v } })} />
                  </Stack>
                ),
              },
              { key: 'quality', label: 'Quality', render: (p: any) => p.quality ?? '—' },
              {
                key: 'pricePerCarat', label: 'Price/ct (₹)', align: 'right',
                filterValue: (p: any) => String(p.pricePerCarat),
                render: (p: any) => (
                  <EditableCell value={Number(p.pricePerCarat)} type="number" align="right"
                    onCommit={(v) => patchMutation.mutate({ id: p.id, data: { pricePerCarat: v } })} />
                ),
              },
              {
                key: 'effectiveDate', label: 'Effective',
                filterValue: (p: any) => new Date(p.effectiveDate).toLocaleDateString('en-IN'),
                render: (p: any) => (
                  <EditableCell value={new Date(p.effectiveDate).toISOString().split('T')[0]} type="date"
                    onCommit={(v) => patchMutation.mutate({ id: p.id, data: { effectiveDate: v } })} />
                ),
              },
            ]}
            rows={prices} isLoading={isLoading} getRowId={(p: any) => p.id}
            emptyLabel="No price entries" scrollable={false}
            selectedIds={selectedIds} onRowClick={toggleRow}
          />
          <Typography variant="caption" color="text.secondary" sx={{ px: 1.5, display: 'block' }}>
            Click a row to select it, Ctrl/Cmd+click to select more, then Ctrl+Delete to remove the selected entries.
          </Typography>
        </Box>
      </Stack>
    </Box>
  );
}

// ─── Making Charges & Wastage ──────────────────────────────────────────────────

function exportToCSV(rows: any[]) {
  const headers = ['Karat', 'Category', 'Material Code', 'Name', 'Make Type', 'Making Wastage %', 'Sale Wastage %', 'Making Charge', 'Charge Type', 'Effective Date', 'Notes'];
  const csvRows = [
    headers.join(','),
    ...rows.map((r) => [
      r.karat ?? '',
      r.category?.name ?? '',
      r.materialCode?.code ?? '',
      r.materialCode?.name ?? '',
      r.makeType ?? '',
      r.wastagePercent,
      r.saleWastagePercent,
      r.makingCharge,
      r.makingChargeType,
      new Date(r.effectiveDate).toLocaleDateString('en-IN'),
      (r.notes ?? '').replace(/,/g, ';'),
    ].join(',')),
  ].join('\n');
  const blob = new Blob([csvRows], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `making-charges-${new Date().toISOString().split('T')[0]}.csv`;
  a.click(); URL.revokeObjectURL(url);
}

// ─── Material Codes ────────────────────────────────────────────────────────────
// Bespoke (not GenericMasterSection) because Karat needs a live dropdown fed by the KaratMaster
// master, and GenericMasterSection's `fields` only support a static option list.

function MaterialCodesTab() {
  const { enqueueSnackbar } = useSnackbar();
  const qc = useQueryClient();
  const [selected, setSelected] = useState<any>(null);
  const deleteMaster = useMasterDelete();

  const { data: karatsData } = useQuery({ queryKey: ['karats'], queryFn: () => apiGet<any>('/masters/karats') });
  const karats: any[] = (karatsData as any)?.data ?? (karatsData as any) ?? [];

  const { data, isLoading } = useQuery({ queryKey: ['master-material-codes'], queryFn: () => apiGet<any>('/masters/material-codes') });
  const rows: any[] = (data as any)?.data ?? (data as any) ?? [];

  const defaultVals = { code: '', name: '', materialType: 'METAL', karat: '', unit: 'GM', description: '' };
  const { control, handleSubmit, reset, watch } = useForm({ defaultValues: defaultVals });
  const materialType = watch('materialType');

  const mutation = useMutation({
    mutationFn: (data: any) => {
      const payload = { ...data, karat: data.materialType === 'METAL' ? (data.karat || null) : null };
      return selected
        ? apiPatch(`/masters/material-codes/${selected.id}`, payload)
        : apiPost('/masters/material-codes', payload);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['master-material-codes'] });
      enqueueSnackbar(selected ? 'Updated' : 'Created', { variant: 'success' });
      setSelected(null); reset(defaultVals);
    },
    onError: (e: any) => enqueueSnackbar(e.response?.data?.error ?? 'Failed', { variant: 'error' }),
  });

  const selectRow = (row: any) => {
    setSelected(row);
    reset({
      code: row.code ?? '', name: row.name ?? '', materialType: row.materialType ?? 'METAL',
      karat: row.karat ?? '', unit: row.unit ?? 'GM', description: row.description ?? '',
    });
  };

  return (
    <Box>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
        Metals and other generic, non-stone items — priced by a Making Charge (labour rate + wastage %).
        A METAL code's Karat (e.g. G22 → 22K) drives two things: NewTagPage auto-derives a tag's overall
        karat from whichever METAL material row carries the most weight, and Making Charge wastage/VA can
        then vary by that karat. Gemstones and diamonds belong under Stone Types instead, which prices by
        a weight-banded rate card.
      </Typography>
      <Grid container spacing={2}>
        <Grid item xs={12} md={4}>
          <FormPanel title={selected ? 'Edit Material Code' : 'New Material Code'} isEdit={!!selected} saving={mutation.isPending}
            onAdd={handleSubmit((d) => mutation.mutate(d))} onUpdate={handleSubmit((d) => mutation.mutate(d))}
            onClear={() => { setSelected(null); reset(defaultVals); }}
            onDelete={selected ? () => deleteMaster(`/masters/material-codes/${selected.id}`, 'material code', () => {
              qc.invalidateQueries({ queryKey: ['master-material-codes'] });
              setSelected(null); reset(defaultVals);
            }) : undefined}>
            <Controller name="code" control={control} rules={{ required: true }} render={({ field, fieldState }) => (
              <TextField {...field} fullWidth size="small" label="Code (e.g. G22, FIND-01) *" error={!!fieldState.error} />
            )} />
            <Controller name="name" control={control} rules={{ required: true }} render={({ field, fieldState }) => (
              <TextField {...field} fullWidth size="small" label="Name (e.g. 22K Gold) *" error={!!fieldState.error} />
            )} />
            <Controller name="materialType" control={control} rules={{ required: true }} render={({ field, fieldState }) => (
              <TextField {...field} select fullWidth size="small" label="Material Type *" error={!!fieldState.error} SelectProps={{ native: true }}>
                <option value="METAL">METAL</option>
                <option value="OTHER">OTHER</option>
              </TextField>
            )} />
            {materialType === 'METAL' && (
              <Controller name="karat" control={control} render={({ field }) => (
                <TextField {...field} select fullWidth size="small" label="Karat" SelectProps={{ native: true }}>
                  <option value="">— None —</option>
                  {karats.map((k: any) => <option key={k.id} value={k.code}>{k.code}</option>)}
                </TextField>
              )} />
            )}
            <Controller name="unit" control={control} rules={{ required: true }} render={({ field, fieldState }) => (
              <TextField {...field} select fullWidth size="small" label="Unit *" error={!!fieldState.error} SelectProps={{ native: true }}>
                <option value="GM">GM</option>
                <option value="CT">CT</option>
                <option value="PC">PC</option>
              </TextField>
            )} />
            <Controller name="description" control={control} render={({ field }) => (
              <TextField {...field} fullWidth size="small" label="Description" multiline rows={2} sx={{ gridColumn: '1 / -1' }} />
            )} />
          </FormPanel>
        </Grid>
        <Grid item xs={12} md={8}>
          <FilterGrid
            tableId="masters-material-codes"
            columns={[
              { key: 'code', label: 'Code', render: (r: any) => <Typography fontFamily="monospace" fontWeight={700} color="#44C47A" fontSize={12}>{r.code}</Typography> },
              { key: 'name', label: 'Name' },
              { key: 'materialType', label: 'Type', render: (r: any) => <Chip label={r.materialType} size="small" color={r.materialType === 'METAL' ? 'primary' : 'secondary'} /> },
              { key: 'karat', label: 'Karat', filterValue: (r: any) => r.karat ?? '', render: (r: any) => r.karat ? <Chip label={r.karat} size="small" color="warning" /> : '—' },
              { key: 'unit', label: 'Unit' },
              { key: 'description', label: 'Description' },
            ]}
            rows={rows} isLoading={isLoading} getRowId={(r) => r.id}
            selectedId={selected?.id} onRowClick={selectRow} emptyLabel="No material codes yet" />
        </Grid>
      </Grid>
    </Box>
  );
}

function MakingChargesTab() {
  const { enqueueSnackbar } = useSnackbar();
  const qc = useQueryClient();
  const [selected, setSelected] = useState<any>(null);

  const { data: matCodesData } = useQuery({ queryKey: ['master-material-codes'], queryFn: () => apiGet<any>('/masters/material-codes') });
  const materialCodes: any[] = (matCodesData as any)?.data ?? (matCodesData as any) ?? [];

  const { data: catsData } = useQuery({ queryKey: ['master-categories'], queryFn: () => apiGet<any>('/masters/categories') });
  const categories: any[] = (catsData as any)?.data ?? (catsData as any) ?? [];

  const { data: karatsData } = useQuery({ queryKey: ['karats'], queryFn: () => apiGet<any>('/masters/karats') });
  const karats: any[] = (karatsData as any)?.data ?? (karatsData as any) ?? [];

  const { data, isLoading } = useQuery({ queryKey: ['master-making-charges'], queryFn: () => apiGet<any>('/masters/making-charges') });
  const rows: any[] = (data as any)?.data ?? (data as any) ?? [];

  const defaultVals = {
    materialCodeId: '', karat: '', categoryId: '', makeType: '', wastagePercent: '', saleWastagePercent: '',
    makingCharge: '', makingChargeType: 'PER_GRAM', effectiveDate: new Date().toISOString().split('T')[0], notes: '',
  };
  const { control, handleSubmit, reset } = useForm({ defaultValues: defaultVals });

  const mutation = useMutation({
    mutationFn: (data: any) => {
      const payload = {
        ...data,
        materialCodeId: data.materialCodeId || null,
        karat: data.karat || null,
        categoryId: data.categoryId || null,
        makeType: data.makeType || null,
        wastagePercent: Number(data.wastagePercent),
        saleWastagePercent: Number(data.saleWastagePercent),
        makingCharge: Number(data.makingCharge),
        notes: data.notes || null,
      };
      return selected
        ? apiPatch(`/masters/making-charges/${selected.id}`, payload)
        : apiPost('/masters/making-charges', payload);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['master-making-charges'] });
      enqueueSnackbar(selected ? 'Updated' : 'Created', { variant: 'success' });
      setSelected(null); reset(defaultVals);
    },
    onError: (e: any) => enqueueSnackbar(e.response?.data?.error ?? 'Failed', { variant: 'error' }),
  });

  const deactivate = () => {
    if (!selected) return;
    apiDelete(`/masters/making-charges/${selected.id}`)
      .then(() => { qc.invalidateQueries({ queryKey: ['master-making-charges'] }); setSelected(null); reset(defaultVals); })
      .catch((e: any) => enqueueSnackbar(e.response?.data?.error ?? 'Failed', { variant: 'error' }));
  };

  const selectRow = (row: any) => {
    setSelected(row);
    reset({
      materialCodeId: row.materialCodeId ?? '', karat: row.karat ?? '', categoryId: row.categoryId ?? '', makeType: row.makeType ?? '',
      wastagePercent: row.wastagePercent ?? '', saleWastagePercent: row.saleWastagePercent ?? '',
      makingCharge: row.makingCharge ?? '', makingChargeType: row.makingChargeType ?? 'PER_GRAM',
      effectiveDate: row.effectiveDate ? new Date(row.effectiveDate).toISOString().split('T')[0] : new Date().toISOString().split('T')[0],
      notes: row.notes ?? '',
    });
  };

  return (
    <Box>
      <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 2 }}>
        <Typography variant="body2" color="text.secondary">
          Define making charges and wastage % per karat + category (e.g. 22K Necklace → 18% VA +
          ₹450/gm, 18K Bangle → 22% VA). Leave Karat/Category/Make Type blank for "any" — the
          most specific matching row wins on a sale.
        </Typography>
        <Tooltip title="Export to CSV">
          <span>
            <Button variant="outlined" size="small" startIcon={<FileDownload />}
              onClick={() => exportToCSV(rows)} disabled={rows.length === 0}>
              Export CSV
            </Button>
          </span>
        </Tooltip>
      </Stack>

      <Grid container spacing={2}>
        <Grid item xs={12} md={4}>
          <FormPanel title={selected ? 'Edit Making Charge' : 'New Making Charge Entry'} isEdit={!!selected} saving={mutation.isPending}
            onAdd={handleSubmit((d) => mutation.mutate(d))} onUpdate={handleSubmit((d) => mutation.mutate(d))}
            onClear={() => { setSelected(null); reset(defaultVals); }} onDelete={selected ? deactivate : undefined}>
            <Controller name="karat" control={control} render={({ field }) => (
              <TextField {...field} select fullWidth size="small" label="Karat (optional)" SelectProps={{ native: true }}>
                <option value="">— Any —</option>
                {karats.map((k: any) => <option key={k.id} value={k.code}>{k.code}</option>)}
              </TextField>
            )} />
            <Controller name="materialCodeId" control={control} render={({ field }) => (
              <TextField {...field} select fullWidth size="small" label="Material Code (non-metal flat rate only)" SelectProps={{ native: true }}>
                <option value="">— Any —</option>
                {materialCodes.map((mc: any) => <option key={mc.id} value={mc.id}>{mc.code} — {mc.name}</option>)}
              </TextField>
            )} />
            <Controller name="makeType" control={control} render={({ field }) => (
              <TextField {...field} select fullWidth size="small" label="Make Type (optional)" SelectProps={{ native: true }}>
                <option value="">— Any —</option>
                {['GOLD', 'DIAMOND', 'SILVER', 'PLATINUM', 'OTHER'].map((t) => <option key={t} value={t}>{t}</option>)}
              </TextField>
            )} />
            <Controller name="categoryId" control={control} render={({ field }) => (
              <TextField {...field} select fullWidth size="small" label="Category (optional)" SelectProps={{ native: true }}>
                <option value="">— Any —</option>
                {categories.map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </TextField>
            )} />
            <Divider><Typography variant="caption" color="text.secondary">Wastage % (of net weight)</Typography></Divider>
            <Controller name="wastagePercent" control={control} rules={{ required: true }} render={({ field, fieldState }) => (
              <TextField {...field} fullWidth size="small" label="Making Wastage % *" type="number"
                inputProps={{ step: 0.01, min: 0, max: 100 }} helperText="Internal manufacturing loss" error={!!fieldState.error} />
            )} />
            <Controller name="saleWastagePercent" control={control} rules={{ required: true }} render={({ field, fieldState }) => (
              <TextField {...field} fullWidth size="small" label="Sale Wastage % *" type="number"
                inputProps={{ step: 0.01, min: 0, max: 100 }} helperText="Wastage charged to customer" error={!!fieldState.error} />
            )} />
            <Divider><Typography variant="caption" color="text.secondary">Making Charge</Typography></Divider>
            <Controller name="makingCharge" control={control} rules={{ required: true }} render={({ field, fieldState }) => (
              <TextField {...field} fullWidth size="small" label="Making Charge Value (₹) *" type="number"
                inputProps={{ step: 0.01, min: 0 }} error={!!fieldState.error} />
            )} />
            <Controller name="makingChargeType" control={control} render={({ field }) => (
              <TextField {...field} select fullWidth size="small" label="Charge Type" SelectProps={{ native: true }}>
                <option value="PER_GRAM">Per Gram (₹/gm)</option>
                <option value="PER_PIECE">Per Piece (₹/pc)</option>
                <option value="PERCENTAGE">% of Metal Value</option>
              </TextField>
            )} />
            <Controller name="effectiveDate" control={control} render={({ field }) => (
              <TextField {...field} fullWidth size="small" label="Effective Date" type="date" InputLabelProps={{ shrink: true }} />
            )} />
            <Controller name="notes" control={control} render={({ field }) => <TextField {...field} fullWidth size="small" label="Notes" />} />
          </FormPanel>
        </Grid>
        <Grid item xs={12} md={8}>
          <FilterGrid
            tableId="masters-making-charges"
            columns={[
              { key: 'karat', label: 'Karat', filterValue: (r: any) => r.karat ?? '', render: (r: any) => r.karat ? <Chip label={r.karat} size="small" color="warning" /> : '— Any —' },
              { key: 'category', label: 'Category', filterValue: (r: any) => r.category?.name ?? '', render: (r: any) => r.category?.name ?? '— Any —' },
              { key: 'materialCode', label: 'Material Code', filterValue: (r: any) => r.materialCode?.code ?? '', render: (r: any) => <Typography fontFamily="monospace" fontWeight={700} color="#44C47A" fontSize={12}>{r.materialCode?.code ?? '—'}</Typography> },
              { key: 'name', label: 'Name', filterValue: (r: any) => r.materialCode?.name ?? '', render: (r: any) => r.materialCode?.name ?? '—' },
              { key: 'makeType', label: 'Make Type', render: (r: any) => r.makeType && <Chip label={r.makeType} size="small" /> },
              {
                key: 'wastagePercent', label: 'Making Wastage %', align: 'right',
                filterValue: (r: any) => String(r.wastagePercent),
                render: (r: any) => <Typography fontFamily="monospace" fontWeight={700} color="#E65100">{Number(r.wastagePercent).toFixed(2)}%</Typography>,
              },
              {
                key: 'saleWastagePercent', label: 'Sale Wastage %', align: 'right',
                filterValue: (r: any) => String(r.saleWastagePercent),
                render: (r: any) => <Typography fontFamily="monospace" fontWeight={700} color="#1B3280">{Number(r.saleWastagePercent).toFixed(2)}%</Typography>,
              },
              {
                key: 'makingCharge', label: 'Making Charge (₹)', align: 'right',
                filterValue: (r: any) => String(r.makingCharge),
                render: (r: any) => <Typography fontFamily="monospace" fontWeight={700}>₹{Number(r.makingCharge).toLocaleString('en-IN', { maximumFractionDigits: 2 })}</Typography>,
              },
              { key: 'makingChargeType', label: 'Type', render: (r: any) => <Chip label={r.makingChargeType} size="small" variant="outlined" /> },
              {
                key: 'effectiveDate', label: 'Effective',
                filterValue: (r: any) => new Date(r.effectiveDate).toLocaleDateString('en-IN'),
                render: (r: any) => new Date(r.effectiveDate).toLocaleDateString('en-IN'),
              },
            ]}
            rows={rows} isLoading={isLoading} getRowId={(r: any) => r.id} selectedId={selected?.id}
            emptyLabel='No entries yet — add one, or click a row to edit' onRowClick={selectRow}
          />
        </Grid>
      </Grid>
    </Box>
  );
}

// ─── Branches (reuse existing API) ─────────────────────────────────────────────

function BranchesTab() {
  const { enqueueSnackbar } = useSnackbar();
  const qc = useQueryClient();
  const [selected, setSelected] = useState<any>(null);

  const { data, isLoading } = useQuery({ queryKey: ['branches'], queryFn: () => apiGet<any>('/tagging/branches') });
  const branches: any[] = (data as any)?.data ?? data ?? [];

  const defaultVals = { name: '', address: '', city: '', state: '', phone: '', email: '', managerName: '', isHeadOffice: false };
  const { control, handleSubmit, reset } = useForm({ defaultValues: defaultVals });

  const mutation = useMutation({
    mutationFn: (formData: any) => (selected ? apiPatch(`/tagging/branches/${selected.id}`, formData) : apiPost('/tagging/branches', formData)),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['branches'] });
      enqueueSnackbar(selected ? 'Branch updated' : 'Branch created', { variant: 'success' });
      setSelected(null); reset(defaultVals);
    },
    onError: (e: any) => enqueueSnackbar(e.response?.data?.error ?? 'Failed', { variant: 'error' }),
  });

  const selectRow = (branch: any) => {
    setSelected(branch);
    reset({
      name: branch.name, address: branch.address ?? '', city: branch.city ?? '',
      state: branch.state ?? '', phone: branch.phone ?? '', email: branch.email ?? '',
      managerName: branch.managerName ?? '', isHeadOffice: branch.isHeadOffice,
    });
  };

  return (
    <Grid container spacing={2}>
      <Grid item xs={12} md={4}>
        <FormPanel title={selected ? 'Edit Branch' : 'Add Branch'} isEdit={!!selected} saving={mutation.isPending}
          onAdd={handleSubmit((d) => mutation.mutate(d))} onUpdate={handleSubmit((d) => mutation.mutate(d))}
          onClear={() => { setSelected(null); reset(defaultVals); }}>
          <Controller name="name" control={control} rules={{ required: true }} render={({ field, fieldState }) => <TextField {...field} fullWidth size="small" label="Branch Name *" error={!!fieldState.error} />} />
          <Controller name="address" control={control} render={({ field }) => <TextField {...field} fullWidth size="small" label="Address" />} />
          <Controller name="city" control={control} render={({ field }) => <TextField {...field} fullWidth size="small" label="City" />} />
          <Controller name="state" control={control} render={({ field }) => <TextField {...field} fullWidth size="small" label="State" />} />
          <Controller name="phone" control={control} render={({ field }) => <TextField {...field} fullWidth size="small" label="Phone" />} />
          <Controller name="email" control={control} render={({ field }) => <TextField {...field} fullWidth size="small" label="Email" type="email" />} />
          <Controller name="managerName" control={control} render={({ field }) => <TextField {...field} fullWidth size="small" label="Manager Name" />} />
          <Controller name="isHeadOffice" control={control} render={({ field }) => <FormControlLabel control={<Switch checked={!!field.value} onChange={(e) => field.onChange(e.target.checked)} />} label="Head Office" />} />
        </FormPanel>
      </Grid>
      <Grid item xs={12} md={8}>
        <FilterGrid
          tableId="masters-branches"
          columns={[
            { key: 'branchCode', label: 'Code', render: (b: any) => <Typography fontFamily="monospace" fontWeight={700} color="#44C47A" fontSize={12}>{b.branchCode}</Typography> },
            { key: 'name', label: 'Name' },
            { key: 'city', label: 'City', render: (b: any) => b.city ?? '—' },
            { key: 'managerName', label: 'Manager', render: (b: any) => b.managerName ?? '—' },
            {
              key: 'isHeadOffice', label: 'Type', filterValue: (b: any) => (b.isHeadOffice ? 'Head Office' : ''),
              render: (b: any) => b.isHeadOffice && <Chip label="Head Office" size="small" color="primary" />,
            },
            {
              key: 'isActive', label: 'Status', filterValue: (b: any) => (b.isActive ? 'Active' : 'Inactive'),
              render: (b: any) => <Chip label={b.isActive ? 'Active' : 'Inactive'} size="small" color={b.isActive ? 'success' : 'default'} />,
            },
          ]}
          rows={branches} isLoading={isLoading} getRowId={(b: any) => b.id} selectedId={selected?.id}
          emptyLabel="No branches yet" onRowClick={selectRow}
        />
      </Grid>
    </Grid>
  );
}

// ─── Clients (party master — customers, dealers, and manufacturers/vendors) ──
// Reuses the existing /orders/clients endpoints (same data the Orders > Clients page and the
// New Tag page's Manufacturer picker read) rather than a separate masters-only copy — this is
// just a second, masters-styled front door onto the same Client table.

function ClientsTab() {
  const { enqueueSnackbar } = useSnackbar();
  const qc = useQueryClient();
  const [selected, setSelected] = useState<any>(null);

  const { data, isLoading } = useQuery({ queryKey: ['clients'], queryFn: () => apiGet<any[]>('/orders/clients') });
  const rows: any[] = (data as any)?.data ?? data ?? [];

  const defaultVals = {
    name: '', type: 'WHOLESALE', gstNumber: '', phone: '', email: '',
    address: '', city: '', district: '', state: '', pincode: '',
    creditLimit: '', pricingTier: 'STANDARD',
  };
  const { control, handleSubmit, reset } = useForm({ defaultValues: defaultVals });

  const mutation = useMutation({
    mutationFn: (data: any) => {
      const payload = { ...data, creditLimit: data.creditLimit === '' ? undefined : Number(data.creditLimit) };
      return selected ? apiPatch(`/orders/clients/${selected.id}`, payload) : apiPost('/orders/clients', payload);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['clients'] });
      enqueueSnackbar(selected ? 'Client updated' : 'Client created', { variant: 'success' });
      setSelected(null); reset(defaultVals);
    },
    onError: (e: any) => enqueueSnackbar(e.response?.data?.error ?? 'Failed', { variant: 'error' }),
  });

  const toggleActive = (row: any) => {
    apiPatch(`/orders/clients/${row.id}`, { isActive: !row.isActive })
      .then(() => qc.invalidateQueries({ queryKey: ['clients'] }))
      .catch((e: any) => enqueueSnackbar(e.response?.data?.error ?? 'Failed', { variant: 'error' }));
  };

  const selectRow = (row: any) => {
    setSelected(row);
    reset({
      name: row.name ?? '', type: row.type ?? 'WHOLESALE', gstNumber: row.gstNumber ?? '',
      phone: row.phone ?? '', email: row.email ?? '', address: row.address ?? '', city: row.city ?? '',
      district: row.district ?? '', state: row.state ?? '', pincode: row.pincode ?? '',
      creditLimit: row.creditLimit ?? '', pricingTier: row.pricingTier ?? 'STANDARD',
    });
  };

  return (
    <>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
        Every party this business deals with — retail/wholesale/export customers and manufacturers
        (vendors a finished piece was sourced from, picked on the New Tag page). Same records as
        Orders &gt; Clients; this is just a masters-styled front door onto the same table.
      </Typography>
      <Grid container spacing={2}>
        <Grid item xs={12} md={4}>
          <FormPanel title={selected ? `Edit — ${selected.clientCode}` : 'New Client'} isEdit={!!selected} saving={mutation.isPending}
            onAdd={handleSubmit((d) => mutation.mutate(d))} onUpdate={handleSubmit((d) => mutation.mutate(d))}
            onClear={() => { setSelected(null); reset(defaultVals); }}>
            <Controller name="name" control={control} rules={{ required: true }} render={({ field, fieldState }) => (
              <TextField {...field} fullWidth size="small" label="Name *" error={!!fieldState.error} />
            )} />
            <Controller name="type" control={control} render={({ field }) => (
              <TextField {...field} select fullWidth size="small" label="Type" SelectProps={{ native: true }}>
                <option value="RETAIL">Retail</option>
                <option value="WHOLESALE">Wholesale</option>
                <option value="EXPORT">Export</option>
                <option value="MANUFACTURER">Manufacturer</option>
              </TextField>
            )} />
            <Controller name="gstNumber" control={control} render={({ field }) => <TextField {...field} fullWidth size="small" label="GST Number" />} />
            <Controller name="phone" control={control} render={({ field }) => <TextField {...field} fullWidth size="small" label="Phone" />} />
            <Controller name="email" control={control} render={({ field }) => <TextField {...field} fullWidth size="small" label="Email" type="email" />} />
            <Controller name="address" control={control} render={({ field }) => <TextField {...field} fullWidth size="small" label="Door No / Address" />} />
            <Controller name="city" control={control} render={({ field }) => <TextField {...field} fullWidth size="small" label="City" />} />
            <Controller name="district" control={control} render={({ field }) => <TextField {...field} fullWidth size="small" label="District" />} />
            <Controller name="state" control={control} render={({ field }) => <TextField {...field} fullWidth size="small" label="State" />} />
            <Controller name="pincode" control={control} render={({ field }) => <TextField {...field} fullWidth size="small" label="Pincode" />} />
            <Controller name="creditLimit" control={control} render={({ field }) => <TextField {...field} fullWidth size="small" label="Credit Limit" type="number" inputProps={{ step: 0.01, min: 0 }} />} />
            <Controller name="pricingTier" control={control} render={({ field }) => (
              <TextField {...field} select fullWidth size="small" label="Pricing Tier" SelectProps={{ native: true }}>
                <option value="STANDARD">Standard</option>
                <option value="PREFERRED">Preferred</option>
                <option value="PREMIUM">Premium</option>
              </TextField>
            )} />
          </FormPanel>
        </Grid>
        <Grid item xs={12} md={8}>
          <FilterGrid
            tableId="masters-clients"
            columns={[
              { key: 'clientCode', label: 'Code', render: (c: any) => <Typography fontFamily="monospace" fontWeight={700} color="#44C47A" fontSize={12}>{c.clientCode}</Typography> },
              { key: 'name', label: 'Name' },
              { key: 'type', label: 'Type', render: (c: any) => <Chip label={c.type} size="small" color={c.type === 'MANUFACTURER' ? 'info' : 'default'} /> },
              { key: 'gstNumber', label: 'GSTIN', render: (c: any) => c.gstNumber ?? '—' },
              { key: 'phone', label: 'Phone', render: (c: any) => c.phone ?? '—' },
              { key: 'city', label: 'City', render: (c: any) => c.city ?? '—' },
              {
                key: 'creditLimit', label: 'Credit Limit', align: 'right',
                filterValue: (c: any) => String(c.creditLimit ?? ''),
                render: (c: any) => c.creditLimit ? `₹${Number(c.creditLimit).toLocaleString('en-IN')}` : '—',
              },
              {
                key: 'isActive', label: 'Status',
                filterValue: (r: any) => (r.isActive ? 'Active' : 'Inactive'),
                render: (r: any) => (
                  <Chip label={r.isActive ? 'Active' : 'Inactive'} size="small" color={r.isActive ? 'success' : 'default'}
                    sx={{ cursor: 'pointer' }} onClick={(e) => { e.stopPropagation(); toggleActive(r); }} />
                ),
              },
            ]}
            rows={rows} isLoading={isLoading} getRowId={(r: any) => r.id} selectedId={selected?.id}
            emptyLabel="No clients yet" onRowClick={selectRow}
          />
        </Grid>
      </Grid>
    </>
  );
}

// ─── Main Masters Page ────────────────────────────────────────────────────────

const SECTIONS: Array<{ key: string; label: string; icon: React.ReactNode }> = [
  { key: 'categories', label: 'Categories', icon: <Category fontSize="small" /> },
  { key: 'stockTypes', label: 'Stock Types', icon: <Inventory2 fontSize="small" /> },
  { key: 'clients', label: 'Clients', icon: <Business fontSize="small" /> },
  { key: 'collections', label: 'Collections', icon: <CollectionsIcon fontSize="small" /> },
  { key: 'karats', label: 'Karats', icon: <Diamond fontSize="small" /> },
  { key: 'materialCodes', label: 'Material Codes', icon: <Diamond fontSize="small" /> },
  { key: 'stoneTypes', label: 'Stone Types', icon: <AutoAwesome fontSize="small" /> },
  { key: 'priceMaster', label: 'Price Master', icon: <AttachMoney fontSize="small" /> },
  { key: 'makingCharges', label: 'Making & Wastage', icon: <RequestQuote fontSize="small" /> },
  { key: 'branches', label: 'Branches', icon: <Store fontSize="small" /> },
];

const NAV_COLLAPSED_KEY = 'masters-nav-collapsed';

export function MastersPage() {
  const [section, setSection] = useState('categories');
  const [collapsed, setCollapsed] = useState(() => {
    try { return localStorage.getItem(NAV_COLLAPSED_KEY) === '1'; } catch { return false; }
  });
  const toggleCollapsed = () => setCollapsed((c) => {
    try { localStorage.setItem(NAV_COLLAPSED_KEY, c ? '0' : '1'); } catch { /* ignore */ }
    return !c;
  });

  return (
    <Box>
      <PageHeader title="Masters" />

      <Stack direction="row" spacing={2} alignItems="flex-start">
        <Card variant="outlined" sx={{ width: collapsed ? 52 : 200, flexShrink: 0, transition: 'width 0.15s' }}>
          <List dense disablePadding>
            {SECTIONS.map((s) => (
              <Tooltip key={s.key} title={collapsed ? s.label : ''} placement="right">
                <ListItemButton selected={section === s.key} onClick={() => setSection(s.key)}
                  sx={{ py: 1, px: collapsed ? 1.5 : 2, justifyContent: collapsed ? 'center' : 'flex-start' }}>
                  <ListItemIcon sx={{ minWidth: collapsed ? 0 : 32, justifyContent: 'center' }}>{s.icon}</ListItemIcon>
                  {!collapsed && <ListItemText primary={s.label} primaryTypographyProps={{ fontSize: 13, fontWeight: section === s.key ? 700 : 400 }} />}
                </ListItemButton>
              </Tooltip>
            ))}
          </List>
          <Divider />
          <Tooltip title={collapsed ? 'Expand' : 'Collapse'} placement="right">
            <ListItemButton onClick={toggleCollapsed} sx={{ py: 0.75, justifyContent: 'center' }}>
              {collapsed ? <ChevronRight fontSize="small" /> : <ChevronLeft fontSize="small" />}
            </ListItemButton>
          </Tooltip>
        </Card>

        <Box sx={{ flex: 1, minWidth: 0 }}>
          {section === 'categories' && <CategoriesTab />}

          {section === 'stockTypes' && (
            <GenericMasterSection title="Stock Type" queryKey="master-stock-types" apiPath="/masters/stock-types"
              description="How a piece is held — Ready Stock, Approval Stock, Karigar Stock, etc. Code is meant to be short (a single letter is the common case, e.g. R/A/K) since it becomes the first segment of every tag number created against this stock type."
              columns={[
                { key: 'code', label: 'Code', render: (r: any) => <Typography fontFamily="monospace" fontWeight={700} color="#44C47A" fontSize={12}>{r.code}</Typography> },
                { key: 'name', label: 'Name' },
                { key: 'description', label: 'Description' },
              ]}
              fields={[
                { name: 'code', label: 'Code (e.g. R for Ready Stock)', required: true },
                { name: 'name', label: 'Name (e.g. Ready Stock)', required: true },
                { name: 'description', label: 'Description', type: 'textarea' },
              ]} />
          )}

          {section === 'clients' && <ClientsTab />}

          {section === 'collections' && (
            <GenericMasterSection title="Collection" queryKey="master-collections" apiPath="/masters/collections"
              columns={[
                { key: 'code', label: 'Code', render: (r: any) => <Typography fontFamily="monospace" fontWeight={700} color="#44C47A" fontSize={12}>{r.code}</Typography> },
                { key: 'name', label: 'Name' },
                { key: 'description', label: 'Description' },
              ]}
              fields={[
                { name: 'code', label: 'Code (e.g. BRD)', required: true },
                { name: 'name', label: 'Name (e.g. Bridal)', required: true },
                { name: 'description', label: 'Description', type: 'textarea' },
              ]} />
          )}

          {section === 'karats' && (
            <GenericMasterSection title="Karat" queryKey="master-karats-manage" apiPath="/masters/karats"
              listParams={{ includeInactive: 'true' }} invalidateKeys={['karats', 'master-karats']}
              description="The karat / purity list offered in every Karat dropdown (PO lots, tags, rates, invoices). Add a new karat here; click a Status chip to remove one from the dropdowns (it is deactivated, not deleted — existing tags and invoices keep their karat). Avoid renaming a code that is already in use."
              columns={[
                { key: 'code', label: 'Karat', render: (r: any) => <Chip label={r.code} size="small" color="warning" /> },
                { key: 'metalType', label: 'Metal' },
                { key: 'purity', label: 'Purity', render: (r: any) => Number(r.purity).toFixed(4) },
              ]}
              fields={[
                { name: 'code', label: 'Karat code (e.g. 22K, 925)', required: true },
                { name: 'metalType', label: 'Metal *', required: true, options: ['GOLD', 'SILVER', 'PLATINUM'] },
                { name: 'purity', label: 'Purity fraction (e.g. 0.9167 for 22K)', type: 'number', required: true },
              ]} />
          )}

          {section === 'materialCodes' && <MaterialCodesTab />}

          {section === 'stoneTypes' && <StoneTypesTab />}

          {section === 'priceMaster' && <PriceMasterTab />}
          {section === 'makingCharges' && <MakingChargesTab />}
          {section === 'branches' && <BranchesTab />}
        </Box>
      </Stack>
    </Box>
  );
}
