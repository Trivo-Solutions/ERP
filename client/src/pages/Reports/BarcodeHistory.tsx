import { useMemo, useState } from 'react';
import { Box, Card, Typography, Chip, TextField, Alert, InputAdornment, IconButton, Tooltip, SvgIcon } from '@mui/material';
import { Search } from '@mui/icons-material';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { apiGet } from '../../api/client';
import { PageHeader } from '../../components/common/PageHeader';
import { DataTable, DataTableColumn } from '../../components/common/DataTable';
import { SelectField } from '../../components/fields/SelectField';
import { DateField } from '../../components/fields/DateField';
import { exportToCsv } from '../../utils/exportToCsv';

// Barcode History: every recorded change to every tag — who, when, what changed (before → after) and the
// whole tag as it stood after the change. The rows come from a database trigger, so nothing that touches a
// tag (sale, memo, transfer, return, edit, retire...) can be missing. The grid is the shared DataTable; the
// Excel export always writes EVERY field, whatever columns are switched on in the grid.

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

type Row = Record<string, any>;

const EVENT_LABEL: Record<string, string> = {
  CREATED: 'Created', BASELINE: 'Baseline', STATUS_CHANGE: 'Status Change', BRANCH_CHANGE: 'Branch Change', EDITED: 'Edited', DELETED: 'Deleted',
};
const EVENT_COLOR: Record<string, 'default' | 'success' | 'info' | 'warning' | 'error'> = {
  CREATED: 'success', BASELINE: 'default', STATUS_CHANGE: 'warning', BRANCH_CHANGE: 'info', EDITED: 'info', DELETED: 'error',
};
const EVENT_OPTIONS = Object.entries(EVENT_LABEL).map(([value, label]) => ({ value, label }));
const STATUS_LABEL: Record<string, string> = {
  IN_STOCK: 'In Stock', ON_APPROVAL: 'On Memo', TRANSFERRED: 'In Transit', SOLD: 'Sold', RETIRED: 'Retired', RETURNED: 'Returned',
};
const STATUS_OPTIONS = Object.entries(STATUS_LABEL).map(([value, label]) => ({ value, label }));

const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
const stamp = (v: string | Date) => new Date(v).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
const prettyLabel = (k: string) => k.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase()).replace(/\bId\b/, 'ID');
const show = (v: unknown): string => {
  if (v === null || v === undefined || v === '') return '—';
  if (typeof v === 'string' && ISO_DATE.test(v)) return stamp(v);
  if (typeof v === 'string') return STATUS_LABEL[v] ?? v;
  return String(v);
};
const changeText = (r: Row) =>
  Object.entries(r.changes as Record<string, { from: unknown; to: unknown }>)
    .map(([k, c]) => `${prettyLabel(k.replace(/Id$/, ''))}: ${show(c.from)} → ${show(c.to)}`).join('; ');

// Fields shown first/always; every other snapshot field becomes an optional (hidden) column.
const LEAD_KEYS = new Set(['id', 'tagNumber', 'status', 'branchId', 'branchName']);
const rawId = (k: string) => k !== 'id' && /Id$/.test(k); // the name column stands in for these on screen

const BASE_COLUMNS: DataTableColumn[] = [
  {
    key: 'changedAt', label: 'Date & Time', width: 190,
    filterValue: (r) => new Date(r.changedAt).toLocaleDateString('en-IN'), sortValue: (r) => new Date(r.changedAt).getTime(),
    render: (r) => stamp(r.changedAt), csvValue: (r) => stamp(r.changedAt),
  },
  {
    key: 'tagNumber', label: 'Jewel Code', width: 130,
    render: (r) => <Box component="span" sx={{ fontFamily: 'monospace', fontWeight: 700, color: 'secondary.main' }}>{r.tagNumber}</Box>,
  },
  {
    key: 'event', label: 'Event', width: 130, filterValue: (r) => EVENT_LABEL[r.event] ?? r.event, sortValue: (r) => r.event,
    render: (r) => <Chip size="small" color={EVENT_COLOR[r.event] ?? 'default'} variant="outlined" label={EVENT_LABEL[r.event] ?? r.event} />,
    csvValue: (r) => EVENT_LABEL[r.event] ?? r.event,
  },
  { key: 'actorName', label: 'Updated By', width: 160, filterValue: (r) => r.actorName ?? '—', render: (r) => r.actorName ?? '—', csvValue: (r) => r.actorName ?? '' },
  { key: 'status', label: 'Status', width: 110, filterValue: (r) => STATUS_LABEL[r.status] ?? r.status ?? '—', render: (r) => STATUS_LABEL[r.status] ?? r.status ?? '—', csvValue: (r) => STATUS_LABEL[r.status] ?? r.status ?? '' },
  { key: 'branchName', label: 'Branch', width: 140, filterValue: (r) => r.branchName ?? '—', render: (r) => r.branchName ?? '—', csvValue: (r) => r.branchName ?? '' },
  {
    key: 'changeText', label: 'What Changed', width: 420, filterValue: (r) => r.changeText || '—', sortValue: (r) => r.changeText,
    render: (r) => r.changeText
      ? <Typography variant="body2" sx={{ whiteSpace: 'normal' }}>{r.changeText}</Typography>
      : <Typography variant="body2" color="text.secondary">{r.event === 'CREATED' ? 'Tag created' : r.event === 'BASELINE' ? 'State when history tracking began' : r.event === 'DELETED' ? 'Tag deleted' : '—'}</Typography>,
    csvValue: (r) => r.changeText,
  },
];

export function BarcodeHistory() {
  const [tagNumber, setTagNumber] = useState('');
  const [branchId, setBranchId] = useState('');
  const [event, setEvent] = useState('');
  const [status, setStatus] = useState('');
  const [userId, setUserId] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');

  // The tag-number box queries the server (debounce-free: it is a contains-match on an indexed column and
  // only fires per keystroke after 2+ characters, which keeps the counter-scan case instant).
  const tagQuery = tagNumber.trim().length >= 2 ? tagNumber.trim() : '';
  const { data, isLoading, isFetching } = useQuery({
    queryKey: ['tag-history', tagQuery, branchId, event, status, userId, dateFrom, dateTo],
    queryFn: () => apiGet<any>('/tagging/reports/tag-history', {
      ...(tagQuery && { tagNumber: tagQuery }), ...(branchId && { branchId }), ...(event && { event }),
      ...(status && { status }), ...(userId && { userId }), ...(dateFrom && { dateFrom }), ...(dateTo && { dateTo }),
    }),
    placeholderData: keepPreviousData,
  });

  const rows = useMemo<Row[]>(
    () => (data?.rows ?? []).map((r: Row) => ({ ...r, changeText: changeText(r) })),
    [data],
  );

  // Every field any row carries (union, so a tag column added later shows up with no code change).
  const fieldKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const r of rows) for (const k of Object.keys(r.data)) keys.add(k);
    return [...keys];
  }, [rows]);

  const columns = useMemo<DataTableColumn[]>(() => [
    ...BASE_COLUMNS,
    ...fieldKeys.filter((k) => !LEAD_KEYS.has(k) && !rawId(k)).map<DataTableColumn>((k) => ({
      key: `data.${k}`, label: prettyLabel(k), defaultHidden: true, width: 130,
      filterValue: (r) => show(r.data[k]), sortValue: (r) => { const v = r.data[k]; return typeof v === 'number' ? v : show(v); },
      render: (r) => show(r.data[k]), csvValue: (r) => show(r.data[k]),
    })),
  ], [fieldKeys]);

  // Export = every field, not just the visible columns: when/who/what changed + the full tag after the change.
  const exportAll = () => {
    exportToCsv(`barcode-history-${new Date().toISOString().slice(0, 10)}`, [
      { header: 'Date & Time', value: (r: Row) => stamp(r.changedAt) },
      { header: 'Jewel Code', value: (r) => r.tagNumber },
      { header: 'Event', value: (r) => EVENT_LABEL[r.event] ?? r.event },
      { header: 'Updated By', value: (r) => r.actorName ?? '' },
      { header: 'Changed Fields', value: (r) => (r.changedFields as string[]).map(prettyLabel).join('; ') },
      { header: 'What Changed', value: (r) => r.changeText },
      ...fieldKeys.map((k) => ({ header: prettyLabel(k), value: (r: Row) => { const v = r.data[k]; return v === null || v === undefined ? '' : typeof v === 'string' && ISO_DATE.test(v) ? stamp(v) : String(v); } })),
    ], rows);
  };

  const branches: any[] = data?.branches ?? [];
  const users: any[] = data?.users ?? [];

  return (
    <Box>
      <PageHeader title="Barcode History" />

      <Card sx={{ p: 1.5, mb: 1.5 }}>
        <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr 1fr', md: 'repeat(7, 1fr)' }, gap: 1.5, alignItems: 'center' }}>
          <TextField size="small" label="Jewel Code" placeholder="Scan / type tag no." value={tagNumber}
            onChange={(e) => setTagNumber(e.target.value)} InputLabelProps={{ shrink: true }}
            InputProps={{ startAdornment: <InputAdornment position="start"><Search fontSize="small" /></InputAdornment> }} />
          <DateField size="small" label="From" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} />
          <DateField size="small" label="To" value={dateTo} onChange={(e) => setDateTo(e.target.value)} />
          <SelectField size="small" label="Event" value={event} onChange={(e) => setEvent(e.target.value)} emptyLabel="All Events" options={EVENT_OPTIONS} />
          <SelectField size="small" label="Status" value={status} onChange={(e) => setStatus(e.target.value)} emptyLabel="All Statuses" options={STATUS_OPTIONS} />
          <SelectField size="small" label="Updated By" value={userId} onChange={(e) => setUserId(e.target.value)}
            emptyLabel="All Users" options={users.map((u) => ({ value: u.id, label: u.name }))} />
          <SelectField size="small" label="Branch" value={branchId} onChange={(e) => setBranchId(e.target.value)}
            emptyLabel={branches.length === 1 ? branches[0].name : 'All Branches'} options={branches.length > 1 ? branches.map((b) => ({ value: b.id, label: b.name })) : []} />
        </Box>
        <Box sx={{ display: 'flex', gap: 1.5, mt: 1.5, alignItems: 'center' }}>
          <Typography variant="caption" color="text.secondary" sx={{ flex: 1 }}>
            Every change to a tag, newest first · right-click a column header to show more of the tag's fields (as of that change) · drag a header to reorder
            {isFetching && !isLoading ? ' · refreshing…' : ''}
          </Typography>
          <Tooltip title="Export to Excel — downloads a CSV of every field for all rows matching the filters">
            <span style={{ flexShrink: 0 }}>
              <IconButton aria-label="Export to Excel" sx={{ border: 1, borderColor: 'divider', borderRadius: 1, p: 0.75 }}
                disabled={rows.length === 0} onClick={exportAll}>
                <ExcelIcon />
              </IconButton>
            </span>
          </Tooltip>
        </Box>
      </Card>

      {data?.truncated && (
        <Alert severity="warning" sx={{ mb: 1.5 }}>
          Showing the latest {Number(data.limit).toLocaleString('en-IN')} changes only — narrow the dates, tag, user or event to see the rest.
        </Alert>
      )}

      <DataTable
        tableId="barcode-history"
        columns={columns}
        rows={rows}
        isLoading={isLoading}
        getRowId={(r) => r.id}
        emptyLabel="No tag changes match these filters"
        sortable
        pageSizeOptions={[100, 200, 500, 1000]}
        maxHeight="calc(100vh - 330px)"
        csvFileName="barcode-history"
      />
    </Box>
  );
}
