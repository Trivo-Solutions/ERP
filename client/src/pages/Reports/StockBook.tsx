import { useMemo, useRef, useState } from 'react';
import { Box, Card, TableRow, TableCell, Typography, Chip, TextField, ToggleButton, ToggleButtonGroup, Alert, InputAdornment, IconButton, Tooltip, SvgIcon } from '@mui/material';
import { Search } from '@mui/icons-material';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { apiGet } from '../../api/client';
import { PageHeader } from '../../components/common/PageHeader';
import { DataTable, DataTableColumn } from '../../components/common/DataTable';
import { SelectField } from '../../components/fields/SelectField';
import { DateField } from '../../components/fields/DateField';

// Stock Book: every tag of the chosen branch as one flat grid — or, in Summary, the same rows rolled
// up by whichever fields you group on (the pivot-style view a jeweller expects from a stock report).
// The server sends one row per tag, already scoped to the caller's branch grants; the grid itself is
// the shared DataTable, so columns are switched on/off, dragged into order and auto-fitted exactly as
// on the Masters tables (right-click a header), and every column has the Excel-style filter.

// @mui/icons-material has no spreadsheet-brand icon, so: a green sheet drawn as a grid (header row +
// cells) — reads as "spreadsheet", where a lone letter X reads as "close". A fixed brand green
// (readable in light and dark), so it deliberately ignores the theme palette.
function ExcelIcon() {
  return (
    <SvgIcon viewBox="2 2 20 20">
      <rect x="3" y="3" width="18" height="18" rx="2.5" fill="#1D6F42" />
      <rect x="3" y="3" width="18" height="5" rx="2.5" fill="#145232" />
      <rect x="3" y="6" width="18" height="2" fill="#145232" />
      <path d="M3.5 13.5h17M3.5 17.5h17M9.5 8v13M15 8v13" stroke="#fff" strokeWidth="1.3" fill="none" />
    </SvgIcon>
  );
}

const money = (n: number) => '₹' + Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const wt = (n: number) => Number(n || 0).toFixed(3);
const blankIfZero = (f: (n: number) => string) => (n: number) => (n ? f(n) : '');

const STATUS_LABEL: Record<string, string> = {
  IN_STOCK: 'In Stock', ON_APPROVAL: 'On Memo', TRANSFERRED: 'In Transit', SOLD: 'Sold', RETIRED: 'Retired',
  RETURNED_PENDING_INSPECTION: 'Returned — pending inspection', IN_TRANSIT_TO_HO: 'In transit to HO', HO_RECEIVED: 'At HO — pending inspection', REPAIR_REQUIRED: 'Repair required', IN_REPAIR: 'In repair', REPAIR_COMPLETED: 'Repair done', MELT_PENDING: 'Melt pending', RETAGGED: 'Retagged',
};
const STATUS_OPTIONS = [
  { value: 'IN_STOCK', label: 'On Hand (In Stock)' },
  { value: 'STOCK', label: 'All Stock (in stock + memo + in transit)' },
  { value: 'ON_APPROVAL', label: 'On Memo (with dealer)' },
  { value: 'TRANSFERRED', label: 'In Transit' },
  { value: 'SOLD', label: 'Sold' },
  { value: 'RETIRED', label: 'Retired' },
  { value: 'RETURNED_PENDING_INSPECTION', label: 'Returned — pending inspection' },
  { value: 'IN_TRANSIT_TO_HO', label: 'In transit to HO' },
  { value: 'HO_RECEIVED', label: 'At HO — pending inspection' },
  { value: 'REPAIR_REQUIRED', label: 'Repair required' },
  { value: 'IN_REPAIR', label: 'In repair' },
  { value: 'REPAIR_COMPLETED', label: 'Repair done' },
  { value: 'MELT_PENDING', label: 'Melt pending' },
  { value: 'RETAGGED', label: 'Retagged' },
  { value: 'ALL', label: 'Every status' },
];

type Row = Record<string, any>;

// Fields a person can group the Summary by — text on the row.
interface Dimension { key: string; label: string; text: (r: Row) => string; hidden?: boolean }
const dimension = (key: string, label: string, hidden = true, text?: (r: Row) => string): Dimension =>
  ({ key, label, hidden, text: text ?? ((r) => String(r[key] ?? '')) });
const DIMENSIONS: Dimension[] = [
  dimension('status', 'Status', false, (r) => STATUS_LABEL[r.status] ?? r.status),
  dimension('branchName', 'Branch'),
  dimension('category', 'Category', false),
  dimension('subCategory', 'Sub Category'),
  dimension('collection', 'Collection'),
  dimension('stockType', 'Stock Type'),
  dimension('makeType', 'Make Type', false),
  dimension('metalType', 'Base Metal'),
  dimension('metalKarat', 'Karat', false),
  dimension('settingType', 'Setting'),
  dimension('manufacturer', 'Manufacturer'),
  dimension('enteredBy', 'Entry By'),
];
const DIM_BY_KEY = new Map(DIMENSIONS.map((d) => [d.key, d]));

// Numbers that sum. Shown in both views; in Summary they are the rolled-up totals.
interface Measure { key: string; label: string; fmt: (n: number) => string; hidden?: boolean }
const MEASURES: Measure[] = [
  { key: 'qty', label: 'Qty', fmt: String },
  { key: 'grossWeight', label: 'Gross Wt', fmt: wt },
  { key: 'netWeight', label: 'Net Wt', fmt: wt },
  { key: 'stoneWeight', label: 'Stone Wt (ct)', fmt: wt, hidden: true },
  { key: 'diaWt', label: 'Dia Wt', fmt: blankIfZero(wt) },
  { key: 'csWt', label: 'CS Wt', fmt: blankIfZero(wt) },
  { key: 'stonePieces', label: 'Stone Pcs', fmt: blankIfZero(String), hidden: true },
  { key: 'costPrice', label: 'Cost Price', fmt: money },
  { key: 'sellingPrice', label: 'Selling Price (today)', fmt: money },
];

const dimColumn = (d: Dimension, hidden: boolean): DataTableColumn => ({
  key: d.key, label: d.label, defaultHidden: hidden, width: 130, filterValue: d.text, sortValue: (r) => d.text(r).toLowerCase(),
  render: (r) => d.text(r) || '—',
});
const measureColumn = (m: Measure): DataTableColumn => ({
  key: m.key, label: m.label, align: 'right', defaultHidden: m.hidden, width: m.fmt === money ? 160 : 110, filterable: false,
  filterValue: (r) => m.fmt(Number(r[m.key] || 0)), sortValue: (r) => Number(r[m.key] || 0), csvValue: (r) => Number(r[m.key] || 0),
  render: (r) => <Box component="span" sx={{ fontFamily: 'monospace' }}>{m.fmt(Number(r[m.key] || 0))}</Box>,
});

// Detail: one row per tag. Everything is a column; the right-click menu decides which are on screen.
const DETAIL_COLUMNS: DataTableColumn[] = [
  {
    key: 'tagNumber', label: 'Jewel Code', width: 130,
    render: (r) => <Box component="span" sx={{ fontFamily: 'monospace', fontWeight: 700, color: 'secondary.main' }}>{r.tagNumber}</Box>,
  },
  { key: 'name', label: 'Name', defaultHidden: true, width: 170 },
  ...DIMENSIONS.map((d) => dimColumn(d, d.hidden ?? false)),
  { key: 'huid', label: 'HUID', defaultHidden: true, width: 120 },
  {
    key: 'taggedOn', label: 'Tagged On', defaultHidden: true, width: 110,
    filterValue: (r) => new Date(r.taggedOn).toLocaleDateString('en-IN'), sortValue: (r) => new Date(r.taggedOn).getTime(),
    render: (r) => new Date(r.taggedOn).toLocaleDateString('en-IN'),
  },
  { key: 'daysInStatus', label: 'Days in Status', align: 'right', defaultHidden: true, width: 100, sortValue: (r) => Number(r.daysInStatus) },
  ...MEASURES.map(measureColumn),
];

const LAYOUT_KEY = 'stockbook:layout:v2';
interface Layout { view: 'detail' | 'summary'; groupBy: string[] }
function loadLayout(): Layout {
  const fallback: Layout = { view: 'detail', groupBy: ['category'] };
  try {
    const p = JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? 'null');
    if (!p) return fallback;
    const groupBy = Array.isArray(p.groupBy) ? p.groupBy.filter((k: string) => DIM_BY_KEY.has(k)) : fallback.groupBy;
    return { view: p.view === 'summary' ? 'summary' : 'detail', groupBy: groupBy.length ? groupBy : fallback.groupBy };
  } catch { return fallback; }
}

export function StockBook() {
  const [branchId, setBranchId] = useState('');
  const [status, setStatus] = useState('IN_STOCK');
  const [categoryId, setCategoryId] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [search, setSearch] = useState('');
  const [layout, setLayoutState] = useState<Layout>(loadLayout);
  const exportRef = useRef<(() => void) | null>(null); // filled in by the table: it alone knows the visible columns + sorted rows
  const setLayout = (patch: Partial<Layout>) => setLayoutState((l) => {
    const next = { ...l, ...patch };
    try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(next)); } catch { /* private mode — just won't persist */ }
    return next;
  });

  const { data: categories } = useQuery({ queryKey: ['categories'], queryFn: () => apiGet<any[]>('/masters/categories') });
  const { data, isLoading, isFetching } = useQuery({
    queryKey: ['stock-book', branchId, status, categoryId, dateFrom, dateTo],
    queryFn: () => apiGet<any>('/tagging/reports/stock-book', {
      ...(branchId && { branchId }), status, ...(categoryId && { categoryId }),
      ...(dateFrom && { dateFrom }), ...(dateTo && { dateTo }),
    }),
    placeholderData: keepPreviousData, // keep the branch picker (it comes from this response) while a filter reloads
  });

  const branches: any[] = data?.branches ?? [];
  const summary = layout.view === 'summary';

  // Quick find over what the server sent — lets a counter person jump to a tag number or HUID
  // without a round trip per keystroke.
  const filtered = useMemo<Row[]>(() => {
    const rows: Row[] = data?.rows ?? [];
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) => r.tagNumber.toLowerCase().includes(q) || r.name.toLowerCase().includes(q) || (r.huid ?? '').toLowerCase().includes(q));
  }, [data, search]);

  // Summary rows: one per unique combination of the grouping fields, measures summed.
  const summaryRows = useMemo<Row[]>(() => {
    if (!summary) return [];
    const dims = layout.groupBy.map((k) => DIM_BY_KEY.get(k)!);
    const groups = new Map<string, Row>();
    for (const r of filtered) {
      const key = dims.map((d) => d.text(r)).join('\u0000');
      let g = groups.get(key);
      if (!g) {
        g = { _id: key };
        for (const d of dims) g[d.key] = d.text(r);
        for (const m of MEASURES) g[m.key] = 0;
        groups.set(key, g);
      }
      for (const m of MEASURES) g[m.key] += Number(r[m.key] || 0);
    }
    // Ordered by the grouping fields, left to right — so dragging a grouping column to the front
    // makes it the primary sort, like a pivot. (A header click still overrides this.)
    return Array.from(groups.values()).sort((a, b) => {
      for (const d of dims) {
        const c = String(a[d.key]).localeCompare(String(b[d.key]), undefined, { numeric: true, sensitivity: 'base' });
        if (c) return c;
      }
      return 0;
    });
  }, [filtered, summary, layout.groupBy]);

  // Dragging a grouping column re-orders the grouping (and therefore the sort above). The table keeps
  // its own column order; this just reads the relative order of the grouping columns back out of it.
  const onColumnOrderChange = (order: string[]) => {
    if (!summary) return;
    const inGroup = new Set(layout.groupBy);
    const next = order.filter((k) => inGroup.has(k));
    if (next.length === layout.groupBy.length && next.some((k, i) => k !== layout.groupBy[i])) setLayout({ groupBy: next });
  };

  // Summary text is already resolved onto the row, so its dimension columns just read it back.
  const summaryColumns = useMemo<DataTableColumn[]>(() => [
    ...layout.groupBy.map((k) => {
      const d = DIM_BY_KEY.get(k)!;
      const text = (r: Row) => String(r[k] ?? '');
      return { ...dimColumn(d, false), filterValue: text, sortValue: (r: Row) => text(r).toLowerCase(), render: (r: Row) => text(r) || '—' };
    }),
    ...MEASURES.map(measureColumn),
  ], [layout.groupBy]);

  // Total row: follows the column filters and the user's current column order/visibility.
  const totalsRow = (rows: Row[], cols: DataTableColumn[]) => {
    const sums = new Map(MEASURES.map((m) => [m.key, rows.reduce((s, r) => s + Number(r[m.key] || 0), 0)]));
    if (rows.length === 0) return null;
    return (
      <TableRow sx={{ '& td': { position: 'sticky', bottom: 0, bgcolor: 'background.paper', fontWeight: 700, borderTop: 2, borderColor: 'divider' } }}>
        {cols.map((c, i) => {
          const m = MEASURES.find((x) => x.key === c.key);
          return (
            <TableCell key={c.key} align={m ? 'right' : 'left'} sx={{ whiteSpace: 'nowrap', fontFamily: m ? 'monospace' : undefined }}>
              {m ? m.fmt(sums.get(m.key)!) : i === 0 ? 'Grand Total' : ''}
            </TableCell>
          );
        })}
      </TableRow>
    );
  };

  const toggleGroup = (key: string) => {
    const next = layout.groupBy.includes(key) ? layout.groupBy.filter((k) => k !== key) : [...layout.groupBy, key];
    if (next.length) setLayout({ groupBy: next }); // Summary needs at least one grouping field
  };

  // A user granted a single branch sees just that branch (the server scopes them regardless);
  // everyone else can pick one or leave it on "All Branches" (= all of *their* branches).
  const branchLabel = branches.length === 1 ? branches[0].name : 'All Branches';
  // Each SET of grouping fields keeps its own remembered column layout; the key remounts the table
  // when the set changes (DataTable reads its saved layout once, on mount). The set is sorted so that
  // merely re-ordering the same fields by drag doesn't look like a different grouping and reset it.
  const tableId = summary ? `stock-book-summary:${[...layout.groupBy].sort().join('+')}` : 'stock-book-detail';

  return (
    <Box>
      <PageHeader title="Stock Book" />

      <Card sx={{ p: 1.5, mb: 1.5 }}>
        <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr 1fr', md: 'repeat(6, 1fr)' }, gap: 1.5, alignItems: 'center' }}>
          <SelectField size="small" label="Branch" value={branchId} onChange={(e) => setBranchId(e.target.value)}
            emptyLabel={branchLabel} options={branches.length > 1 ? branches.map((b) => ({ value: b.id, label: b.name })) : []} />
          <SelectField size="small" label="Report Type" value={status} onChange={(e) => setStatus(e.target.value)} options={STATUS_OPTIONS} />
          <SelectField size="small" label="Category" value={categoryId} onChange={(e) => setCategoryId(e.target.value)}
            emptyLabel="All Categories" options={(categories ?? []).map((c: any) => ({ value: c.id, label: c.name }))} />
          <DateField size="small" label="Tagged From" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} />
          <DateField size="small" label="Tagged To" value={dateTo} onChange={(e) => setDateTo(e.target.value)} />
          <TextField size="small" label="Find" placeholder="Tag / name / HUID" value={search}
            onChange={(e) => setSearch(e.target.value)} InputLabelProps={{ shrink: true }}
            InputProps={{ startAdornment: <InputAdornment position="start"><Search fontSize="small" /></InputAdornment> }} />
        </Box>

        {/* No row wrap: the Group-by chips wrap inside their own flexible area, so the export button
            always stays on this line, pinned right, however many chips there are or how narrow the screen. */}
        <Box sx={{ display: 'flex', gap: 1.5, mt: 1.5, alignItems: 'flex-start' }}>
          <ToggleButtonGroup size="small" exclusive sx={{ flexShrink: 0 }} value={layout.view} onChange={(_, v) => v && setLayout({ view: v })}>
            <ToggleButton value="detail">Detail</ToggleButton>
            <ToggleButton value="summary">Summary</ToggleButton>
          </ToggleButtonGroup>
          {summary ? (
            <Box sx={{ display: 'flex', gap: 0.5, alignItems: 'center', flexWrap: 'wrap', flex: 1, minWidth: 0, minHeight: 40 }}>
              <Typography variant="caption" color="text.secondary">Group by:</Typography>
              {DIMENSIONS.map((d) => {
                const idx = layout.groupBy.indexOf(d.key);
                return (
                  <Chip key={d.key} size="small" clickable onClick={() => toggleGroup(d.key)}
                    color={idx >= 0 ? 'primary' : 'default'} variant={idx >= 0 ? 'filled' : 'outlined'}
                    label={idx >= 0 ? `${idx + 1}. ${d.label}` : d.label} />
                );
              })}
            </Box>
          ) : null}
          <Tooltip title="Export to Excel — downloads a CSV of the columns and rows currently shown">
            <span style={{ marginLeft: 'auto', flexShrink: 0 }}>
              <IconButton aria-label="Export to Excel" sx={{ border: 1, borderColor: 'divider', borderRadius: 1, p: 0.75 }}
                disabled={(summary ? summaryRows.length : filtered.length) === 0}
                onClick={() => exportRef.current?.()}>
                <ExcelIcon />
              </IconButton>
            </span>
          </Tooltip>
        </Box>
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
          Right-click a column header to show/hide columns or auto-fit · drag a header to reorder
          {summary ? ' (drag a Group-by column to change the grouping order)' : ''}
          {isFetching && !isLoading ? ' · refreshing…' : ''}
        </Typography>
      </Card>

      {data?.truncated && (
        <Alert severity="warning" sx={{ mb: 1.5 }}>
          Showing the first {Number(data.limit).toLocaleString('en-IN')} pieces only — narrow the branch, category or date range to see the rest.
        </Alert>
      )}

      <DataTable
        key={tableId}
        tableId={tableId}
        columns={summary ? summaryColumns : DETAIL_COLUMNS}
        rows={summary ? summaryRows : filtered}
        isLoading={isLoading}
        getRowId={(r) => r._id ?? r.id}
        emptyLabel="No stock matches these filters"
        sortable
        pageSizeOptions={summary ? undefined : [200, 100, 500, 1000]}
        maxHeight="calc(100vh - 360px)"
        csvFileName={summary ? 'stock-book-summary' : 'stock-book'}
        exportRef={exportRef}
        footer={(rows, cols) => totalsRow(rows, cols)}
        onColumnOrderChange={onColumnOrderChange}
      />
    </Box>
  );
}
