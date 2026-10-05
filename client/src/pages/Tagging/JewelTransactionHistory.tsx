import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Box, Card, CardContent, Chip, CircularProgress, InputAdornment, TextField, Typography, Alert } from '@mui/material';
import { QrCodeScanner, Search } from '@mui/icons-material';
import { useQuery } from '@tanstack/react-query';
import { apiGet } from '../../api/client';
import { PageHeader } from '../../components/common/PageHeader';
import { StatusChip } from '../../components/common/StatusChip';
import { DataTable, DataTableColumn } from '../../components/common/DataTable';

// Jewel Transaction History: look a piece up (scan / type), then see every document it has ever been on — purchase
// or tagging, branch transfers, memos, sales, returns — as one grid underneath. The grid is the shared DataTable, so
// columns can be shown / hidden (right-click a header), reordered, filtered and exported like every other table.
// Read-only; cost price is never sent by the server.

const unwrap = (r: any) => r?.data ?? r;
const dateOnly = (v: string | Date) => {
  const d = new Date(v);
  return `${String(d.getDate()).padStart(2, '0')}-${String(d.getMonth() + 1).padStart(2, '0')}-${d.getFullYear()}`;
};
const dateTime = (v: string | Date) => `${dateOnly(v)} ${new Date(v).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}`;
const money = (n: number | null) => (n === null || n === undefined ? '' : Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const wt = (n: number | null) => (n === null || n === undefined ? '' : Number(n).toFixed(3));

const TYPE_COLOR: Record<string, 'default' | 'success' | 'info' | 'warning' | 'error' | 'secondary'> = {
  PURCHASE: 'success', TAGGED: 'success', SALE: 'info', SALE_VOID: 'error', SALE_RETURN: 'warning', PURCHASE_RETURN: 'warning',
  MEMO_OUT: 'secondary', MEMO_RETURN: 'secondary', TRANSFER_ISSUE: 'default', TRANSFER_RECEIVE: 'default', TRANSFER_REQUEST: 'default', TRANSFER_CANCEL: 'error',
};

export function JewelTransactionHistory() {
  const [params, setParams] = useSearchParams();
  const [query, setQuery] = useState('');
  const [selectedTagId, setSelectedTagId] = useState(params.get('tagId') ?? '');
  const [active, setActive] = useState(0); // keyboard-highlighted match
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  const { data: results, isFetching } = useQuery({
    queryKey: ['tx-history-search', query],
    queryFn: () => apiGet<any>('/tagging/tags/search', { q: query.trim(), status: 'ALL' }),
    enabled: query.trim().length >= 1,
  });
  const matches: any[] = query.trim().length >= 1 ? (unwrap(results) ?? []) : [];

  // Arriving from the top-bar search (`?q=`): fill the box and search. This page may already be open in a tab,
  // so it follows the parameter whenever it changes rather than only on mount.
  const urlQuery = params.get('q') ?? '';
  useEffect(() => {
    if (urlQuery) { setQuery(urlQuery); setSelectedTagId(''); }
  }, [urlQuery]);

  // A scan (or a query specific enough to land one match) opens that piece straight away; an exact tag-number
  // match wins even when the text also happens to be the start of other tags.
  useEffect(() => {
    setActive(0);
    const exact = matches.filter((m) => String(m.tagNumber).toLowerCase() === query.trim().toLowerCase());
    if (exact.length === 1) setSelectedTagId(exact[0].id);
    else if (matches.length === 1) setSelectedTagId(matches[0].id);
  }, [results]); // eslint-disable-line react-hooks/exhaustive-deps

  const choose = (id: string) => { setSelectedTagId(id); if (params.has('tagId')) setParams({}, { replace: true }); };

  const { data: txData, isLoading, error } = useQuery({
    queryKey: ['tag-transactions', selectedTagId],
    queryFn: () => apiGet<any>(`/tagging/tags/${selectedTagId}/transactions`),
    enabled: !!selectedTagId,
  });
  const tx = unwrap(txData) as { tag: any; rows: any[] } | undefined;
  const tag = tx?.tag;

  // Every row also carries the piece's own attributes, so those can be switched on as extra columns.
  const rows = useMemo(() => (tx?.rows ?? []).map((r) => ({ ...r, tag })), [tx, tag]);

  const columns = useMemo<DataTableColumn[]>(() => [
    { key: 'date', label: 'Transaction Date', width: 130, sortValue: (r) => new Date(r.date).getTime(), filterValue: (r) => dateOnly(r.date), render: (r) => dateOnly(r.date), csvValue: (r) => dateOnly(r.date) },
    { key: 'jewelCode', label: 'Jewel Code', width: 130, filterValue: (r) => r.tag.tagNumber, render: (r) => <Box component="span" sx={{ fontFamily: 'monospace', fontWeight: 700, color: 'secondary.main' }}>{r.tag.tagNumber}</Box>, csvValue: (r) => r.tag.tagNumber },
    { key: 'branchName', label: 'Branch', width: 150, filterValue: (r) => r.branchName ?? '—', render: (r) => r.branchName ?? '—', csvValue: (r) => r.branchName ?? '' },
    { key: 'category', label: 'Category Name', width: 140, filterValue: (r) => r.tag.category ?? '—', render: (r) => r.tag.category ?? '—', csvValue: (r) => r.tag.category ?? '' },
    {
      key: 'transaction', label: 'Transactions', width: 230, filterValue: (r) => r.transaction, sortValue: (r) => r.transaction, csvValue: (r) => r.transaction,
      render: (r) => <Chip size="small" variant="outlined" color={TYPE_COLOR[r.type] ?? 'default'} label={r.transaction} />,
    },
    { key: 'bookName', label: 'Book Name', width: 150, filterValue: (r) => r.bookName, render: (r) => r.bookName, csvValue: (r) => r.bookName },
    { key: 'docNo', label: 'Transaction No', width: 170, filterValue: (r) => r.docNo ?? '—', render: (r) => r.docNo ?? '—', csvValue: (r) => r.docNo ?? '' },
    { key: 'party', label: 'Customer', width: 190, filterValue: (r) => r.party ?? '—', render: (r) => r.party ?? '—', csvValue: (r) => r.party ?? '' },
    { key: 'entryBy', label: 'Entry By', width: 140, filterValue: (r) => r.entryBy ?? '—', render: (r) => r.entryBy ?? '—', csvValue: (r) => r.entryBy ?? '' },
    { key: 'remarks', label: 'Remarks', width: 260, filterValue: (r) => r.remarks ?? '—', render: (r) => r.remarks ?? '', csvValue: (r) => r.remarks ?? '' },

    // Optional columns (right-click a header to switch them on).
    { key: 'dateTime', label: 'Date & Time', width: 160, defaultHidden: true, sortValue: (r) => new Date(r.date).getTime(), filterValue: (r) => dateTime(r.date), render: (r) => dateTime(r.date), csvValue: (r) => dateTime(r.date) },
    { key: 'amount', label: 'Amount', align: 'right', width: 120, defaultHidden: true, sortValue: (r) => r.amount ?? -1, filterValue: (r) => money(r.amount) || '—', render: (r) => money(r.amount), csvValue: (r) => r.amount ?? '' },
    { key: 'qty', label: 'Qty', align: 'right', width: 70, defaultHidden: true, sortValue: (r) => r.qty, filterValue: (r) => String(r.qty), render: (r) => r.qty, csvValue: (r) => r.qty },
    { key: 'grossWeight', label: 'Gross Wt', align: 'right', width: 100, defaultHidden: true, sortValue: (r) => r.grossWeight ?? 0, filterValue: (r) => wt(r.grossWeight), render: (r) => wt(r.grossWeight), csvValue: (r) => r.grossWeight ?? '' },
    { key: 'netWeight', label: 'Net Wt', align: 'right', width: 100, defaultHidden: true, sortValue: (r) => r.netWeight ?? 0, filterValue: (r) => wt(r.netWeight), render: (r) => wt(r.netWeight), csvValue: (r) => r.netWeight ?? '' },
    { key: 'stoneWeight', label: 'Stone Wt', align: 'right', width: 100, defaultHidden: true, sortValue: (r) => r.tag.stoneWeight, filterValue: (r) => wt(r.tag.stoneWeight), render: (r) => wt(r.tag.stoneWeight), csvValue: (r) => r.tag.stoneWeight },
    { key: 'diaWt', label: 'Dia Wt', align: 'right', width: 90, defaultHidden: true, sortValue: (r) => r.tag.diaWt, filterValue: (r) => wt(r.tag.diaWt), render: (r) => wt(r.tag.diaWt), csvValue: (r) => r.tag.diaWt },
    { key: 'csWt', label: 'CS Wt', align: 'right', width: 90, defaultHidden: true, sortValue: (r) => r.tag.csWt, filterValue: (r) => wt(r.tag.csWt), render: (r) => wt(r.tag.csWt), csvValue: (r) => r.tag.csWt },
    { key: 'itemName', label: 'Item Name', width: 180, defaultHidden: true, filterValue: (r) => r.tag.name, render: (r) => r.tag.name, csvValue: (r) => r.tag.name },
    { key: 'subCategory', label: 'Sub Category', width: 140, defaultHidden: true, filterValue: (r) => r.tag.subCategory ?? '—', render: (r) => r.tag.subCategory ?? '—', csvValue: (r) => r.tag.subCategory ?? '' },
    { key: 'collection', label: 'Collection', width: 140, defaultHidden: true, filterValue: (r) => r.tag.collection ?? '—', render: (r) => r.tag.collection ?? '—', csvValue: (r) => r.tag.collection ?? '' },
    { key: 'stockType', label: 'Stock Type', width: 120, defaultHidden: true, filterValue: (r) => r.tag.stockType ?? '—', render: (r) => r.tag.stockType ?? '—', csvValue: (r) => r.tag.stockType ?? '' },
    { key: 'metal', label: 'Metal', width: 100, defaultHidden: true, filterValue: (r) => r.tag.metalType, render: (r) => r.tag.metalType, csvValue: (r) => r.tag.metalType },
    { key: 'karat', label: 'Karat', width: 80, defaultHidden: true, filterValue: (r) => r.tag.metalKarat ?? '—', render: (r) => r.tag.metalKarat ?? '—', csvValue: (r) => r.tag.metalKarat ?? '' },
    { key: 'huid', label: 'HUID', width: 130, defaultHidden: true, filterValue: (r) => r.tag.huid ?? '—', render: (r) => r.tag.huid ?? '—', csvValue: (r) => r.tag.huid ?? '' },
    { key: 'manufacturer', label: 'Manufacturer', width: 160, defaultHidden: true, filterValue: (r) => r.tag.manufacturer ?? '—', render: (r) => r.tag.manufacturer ?? '—', csvValue: (r) => r.tag.manufacturer ?? '' },
  ], []);

  const field = (label: string, value: React.ReactNode) => (
    <Box sx={{ minWidth: 0 }}>
      <Typography variant="caption" color="text.secondary" display="block">{label}</Typography>
      <Typography variant="body2" fontWeight={600} noWrap>{value || '—'}</Typography>
    </Box>
  );

  const pickerKeys = (e: React.KeyboardEvent) => {
    if (matches.length < 2) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => Math.min(i + 1, matches.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => Math.max(i - 1, 0)); }
    else if (e.key === 'Enter') { e.preventDefault(); choose(matches[active].id); }
  };

  return (
    <Box>
      <PageHeader title="Jewel Transaction History" />

      <Card sx={{ mb: 1.5 }}>
        <CardContent sx={{ pb: '16px !important' }}>
          <TextField
            inputRef={inputRef} fullWidth autoFocus size="small"
            placeholder="Scan barcode, or type tag number / name / HUID…"
            value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={pickerKeys}
            InputProps={{
              startAdornment: <InputAdornment position="start"><QrCodeScanner /></InputAdornment>,
              endAdornment: isFetching ? <InputAdornment position="end"><CircularProgress size={18} /></InputAdornment> : undefined,
            }}
          />
          {matches.length > 1 && (
            <Box sx={{ mt: 1, maxHeight: 220, overflow: 'auto', border: 1, borderColor: 'divider', borderRadius: 1 }}>
              {matches.map((m, i) => (
                <Box key={m.id} onClick={() => choose(m.id)}
                  sx={{
                    px: 1.5, py: 0.75, cursor: 'pointer', display: 'flex', justifyContent: 'space-between', gap: 2, alignItems: 'center',
                    bgcolor: m.id === selectedTagId ? 'action.selected' : i === active ? 'action.hover' : 'transparent',
                    borderBottom: 1, borderColor: 'divider', '&:hover': { bgcolor: 'action.hover' },
                  }}>
                  <Box sx={{ display: 'flex', gap: 1.5, minWidth: 0 }}>
                    <Typography sx={{ fontFamily: 'monospace', fontWeight: 700, color: 'secondary.main' }}>{m.tagNumber}</Typography>
                    <Typography variant="body2" noWrap>{m.name}</Typography>
                  </Box>
                  <StatusChip status={m.status} />
                </Box>
              ))}
            </Box>
          )}
          {query.trim().length >= 1 && !isFetching && matches.length === 0 && (
            <Typography color="text.secondary" variant="body2" sx={{ mt: 1 }}>No tag matches "{query}".</Typography>
          )}
        </CardContent>
      </Card>

      {error && <Alert severity="error" sx={{ mb: 1.5 }}>Could not load this piece's history (it may not exist, or belong to a branch you cannot see).</Alert>}

      {tag && (
        <Card sx={{ mb: 1.5, p: 1.5 }}>
          <Box sx={{ display: 'grid', gridTemplateColumns: { xs: 'repeat(2, 1fr)', md: 'repeat(8, 1fr)' }, gap: 1.5, alignItems: 'center' }}>
            <Box>
              <Typography variant="h6" fontWeight={900} sx={{ fontFamily: 'monospace', color: 'secondary.main', lineHeight: 1.2 }}>{tag.tagNumber}</Typography>
              <StatusChip status={tag.status} />
            </Box>
            {field('Item', tag.name)}
            {field('Branch', tag.branchName)}
            {field('Category', tag.category)}
            {field('Metal / Karat', `${tag.metalType} ${tag.metalKarat ?? ''}`)}
            {field('Gross / Net Wt', `${wt(tag.grossWeight)} / ${wt(tag.netWeight)} g`)}
            {field('HUID', tag.huid)}
            {field('Selling Price', money(tag.sellingPrice))}
          </Box>
        </Card>
      )}

      {selectedTagId ? (
        <>
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.5 }}>
            Newest first · right-click a column header to show or hide columns · drag a header to reorder
          </Typography>
          <DataTable
            tableId="jewel-transaction-history"
            columns={columns}
            rows={rows}
            isLoading={isLoading}
            getRowId={(r) => r.key}
            emptyLabel="No transactions recorded for this piece"
            sortable
            maxHeight="calc(100vh - 360px)"
            csvFileName="jewel-transaction-history"
          />
        </>
      ) : (
        <Card><CardContent sx={{ textAlign: 'center', py: 6 }}>
          <Search sx={{ fontSize: 40, color: 'text.disabled', mb: 1 }} />
          <Typography color="text.secondary">Scan a barcode or start typing to see a piece's full transaction history.</Typography>
        </CardContent></Card>
      )}
    </Box>
  );
}
