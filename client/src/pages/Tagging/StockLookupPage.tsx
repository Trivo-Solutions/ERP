import { useEffect, useRef, useState } from 'react';
import {
  Box, Card, CardContent, Grid, TextField, Typography, Stack, Divider,
  CircularProgress, InputAdornment,
} from '@mui/material';
import { QrCodeScanner, Search } from '@mui/icons-material';
import { useQuery } from '@tanstack/react-query';
import { apiGet } from '../../api/client';
import { PageHeader } from '../../components/common/PageHeader';
import { StatusChip } from '../../components/common/StatusChip';

function fmt(n: number) {
  return '₹' + Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });
}

// A clerk needs to check a piece — status and price — before deciding whether to even start a
// bill. This is deliberately read-only (no edit/retire) and searches every status, not just
// IN_STOCK, so scanning an already-SOLD or ON_APPROVAL piece still shows a clear answer instead
// of "not found" (B4). A USB barcode/RFID scanner emulates keyboard input (see HardwarePage.tsx),
// so a plain autofocused text field already "just works" for a scan — no special hook needed.
export function StockLookupPage() {
  const [query, setQuery] = useState('');
  const [selectedTagId, setSelectedTagId] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const { data: results, isFetching } = useQuery({
    queryKey: ['stock-lookup', query],
    queryFn: () => apiGet<any>('/tagging/tags/search', { q: query, status: 'ALL' }),
    enabled: query.trim().length >= 1,
  });
  const matches: any[] = (results as any)?.data ?? results ?? [];

  // A scan (or a query specific enough to land exactly one match) jumps straight to the detail
  // view — the common counter case is "one piece, one answer," not browsing a list.
  useEffect(() => {
    if (matches.length === 1) setSelectedTagId(matches[0].id);
    else if (selectedTagId && !matches.some((m) => m.id === selectedTagId)) setSelectedTagId('');
  }, [matches]); // eslint-disable-line react-hooks/exhaustive-deps

  const { data: tagData, isLoading: detailLoading } = useQuery({
    queryKey: ['jewelry-tag', selectedTagId],
    queryFn: () => apiGet<any>(`/tagging/tags/${selectedTagId}`),
    enabled: !!selectedTagId,
  });
  const tag = (tagData as any)?.data ?? tagData;

  return (
    <Box>
      <PageHeader title="Stock Lookup" subtitle="Scan or search a tag to check its status and price — no sale started"
        breadcrumbs={[{ label: 'Jewelry Tagging', path: '/tagging/tags' }, { label: 'Stock Lookup' }]} />

      <Card sx={{ mb: 2 }}>
        <CardContent>
          <TextField
            inputRef={inputRef}
            fullWidth
            autoFocus
            placeholder="Scan barcode, or type tag number / name / HUID..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            InputProps={{
              startAdornment: (
                <InputAdornment position="start"><QrCodeScanner /></InputAdornment>
              ),
              endAdornment: isFetching ? (
                <InputAdornment position="end"><CircularProgress size={18} /></InputAdornment>
              ) : undefined,
            }}
          />
        </CardContent>
      </Card>

      {query.trim().length >= 1 && matches.length > 1 && (
        <Card sx={{ mb: 2 }}>
          <Box sx={{ maxHeight: 320, overflow: 'auto' }}>
            {matches.map((m: any) => (
              <Box key={m.id} onClick={() => setSelectedTagId(m.id)}
                sx={{
                  p: 1.5, cursor: 'pointer', borderBottom: '1px solid', borderColor: 'divider',
                  bgcolor: m.id === selectedTagId ? 'action.selected' : 'transparent',
                  '&:hover': { bgcolor: 'action.hover' },
                }}>
                <Stack direction="row" justifyContent="space-between" alignItems="center">
                  <Stack direction="row" spacing={1.5} alignItems="center">
                    <Typography sx={{ fontFamily: 'monospace', fontWeight: 700, color: '#44C47A' }}>
                      {m.tagNumber}
                    </Typography>
                    <Typography variant="body2">{m.name}</Typography>
                  </Stack>
                  <Stack direction="row" spacing={1.5} alignItems="center">
                    <Typography sx={{ fontFamily: 'monospace', fontWeight: 700 }}>{fmt(m.sellingPrice)}</Typography>
                    <StatusChip status={m.status} />
                  </Stack>
                </Stack>
              </Box>
            ))}
          </Box>
        </Card>
      )}

      {query.trim().length >= 1 && !isFetching && matches.length === 0 && (
        <Card><CardContent><Typography color="text.secondary">No tag matches "{query}".</Typography></CardContent></Card>
      )}

      {detailLoading && (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}><CircularProgress /></Box>
      )}

      {tag && !detailLoading && (
        <Card>
          <CardContent>
            <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 2 }}>
              <Typography variant="h5" fontWeight={900} sx={{ fontFamily: 'monospace', color: '#44C47A' }}>
                {tag.tagNumber}
              </Typography>
              <StatusChip status={tag.status} size="medium" />
            </Stack>

            <Grid container spacing={2}>
              <Grid item xs={12}><Typography variant="h6" fontWeight={700}>{tag.name}</Typography></Grid>

              <Grid item xs={6} sm={4}>
                <Typography variant="caption" color="text.secondary">Selling Price</Typography>
                <Typography variant="h5" fontWeight={900} color="primary.main">{fmt(tag.sellingPrice)}</Typography>
              </Grid>
              <Grid item xs={6} sm={4}>
                <Typography variant="caption" color="text.secondary">Branch</Typography>
                <Typography fontWeight={600}>{tag.branch?.name ?? '—'}</Typography>
              </Grid>
              <Grid item xs={6} sm={4}>
                <Typography variant="caption" color="text.secondary">Metal / Karat</Typography>
                <Typography fontWeight={600}>{tag.metalType} {tag.metalKarat ?? ''}</Typography>
              </Grid>

              <Grid item xs={4} sm={3}>
                <Typography variant="caption" color="text.secondary">Gross Weight</Typography>
                <Typography fontFamily="monospace">{Number(tag.grossWeight).toFixed(3)} g</Typography>
              </Grid>
              <Grid item xs={4} sm={3}>
                <Typography variant="caption" color="text.secondary">Net Weight</Typography>
                <Typography fontFamily="monospace">{Number(tag.netWeight).toFixed(3)} g</Typography>
              </Grid>
              <Grid item xs={4} sm={3}>
                <Typography variant="caption" color="text.secondary">Stone Weight</Typography>
                <Typography fontFamily="monospace">{Number(tag.stoneWeight).toFixed(3)} ct</Typography>
              </Grid>
              <Grid item xs={6} sm={3}>
                <Typography variant="caption" color="text.secondary">HUID</Typography>
                <Typography fontFamily="monospace">{tag.huid || '—'}</Typography>
              </Grid>
            </Grid>

            {(tag.memoItems ?? []).length > 0 && (
              <>
                <Divider sx={{ my: 2 }} />
                <Typography variant="subtitle2" fontWeight={700} gutterBottom>Approval History</Typography>
                {tag.memoItems.map((mi: any) => (
                  <Stack key={mi.id} direction="row" justifyContent="space-between" sx={{ py: 0.5 }}>
                    <Typography variant="body2">{mi.memo?.memoNumber}</Typography>
                    <Typography variant="body2" color="text.secondary">{mi.memo?.status}</Typography>
                  </Stack>
                ))}
              </>
            )}

            {(tag.transferItems ?? []).length > 0 && (
              <>
                <Divider sx={{ my: 2 }} />
                <Typography variant="subtitle2" fontWeight={700} gutterBottom>Transfer History</Typography>
                {tag.transferItems.map((ti: any) => (
                  <Stack key={ti.id} direction="row" justifyContent="space-between" sx={{ py: 0.5 }}>
                    <Typography variant="body2">{ti.transfer?.fromBranch?.name} → {ti.transfer?.toBranch?.name}</Typography>
                    <Typography variant="body2" color="text.secondary">{ti.transfer?.status}</Typography>
                  </Stack>
                ))}
              </>
            )}
          </CardContent>
        </Card>
      )}

      {query.trim().length === 0 && (
        <Card><CardContent sx={{ textAlign: 'center', py: 6 }}>
          <Search sx={{ fontSize: 40, color: 'text.disabled', mb: 1 }} />
          <Typography color="text.secondary">Scan a barcode or start typing to look up a piece.</Typography>
        </CardContent></Card>
      )}
    </Box>
  );
}
