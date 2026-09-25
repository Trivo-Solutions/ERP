import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Box, Card, Typography, Button,
  Grid, MenuItem, TextField, Drawer, Stack, Divider, IconButton, Chip, CircularProgress,
} from '@mui/material';
import { Add, Close, Block, Edit } from '@mui/icons-material';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useSnackbar } from 'notistack';
import { apiGet, apiPatch } from '../../api/client';
import { PageHeader } from '../../components/common/PageHeader';
import { StatusChip } from '../../components/common/StatusChip';
import { DataTable } from '../../components/common/DataTable';

const TAG_STATUSES = ['IN_STOCK', 'ON_APPROVAL', 'TRANSFERRED', 'SOLD', 'RETURNED', 'RETIRED'];

function todayStr() {
  return new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD, matches <input type="date">
}

function fmt(n: number) {
  return '₹' + n.toLocaleString('en-IN', { maximumFractionDigits: 2 });
}

// ─── Tag Detail Drawer ────────────────────────────────────────────────────────

function TagDrawer({ tagId, onClose }: { tagId: string; onClose: () => void }) {
  const navigate = useNavigate();
  const { enqueueSnackbar } = useSnackbar();
  const qc = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ['jewelry-tag', tagId],
    queryFn: () => apiGet<any>(`/tagging/tags/${tagId}`),
    enabled: !!tagId,
  });
  const tag = (data as any)?.data ?? data;

  const retireMutation = useMutation({
    mutationFn: () => apiPatch(`/tagging/tags/${tagId}/retire`, {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['jewelry-tags'] });
      qc.invalidateQueries({ queryKey: ['jewelry-tag', tagId] });
      enqueueSnackbar('Tag retired', { variant: 'success' });
    },
    onError: (e: any) => enqueueSnackbar(e.response?.data?.error ?? 'Failed', { variant: 'error' }),
  });

  return (
    <Drawer anchor="right" open={!!tagId} onClose={onClose} PaperProps={{ sx: { width: 560 } }}>
      <Box sx={{ p: 3, height: '100%', overflow: 'auto' }}>
        <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 2 }}>
          <Typography variant="h6" fontWeight={700}>Tag Detail</Typography>
          <Stack direction="row" spacing={0.5}>
            {tag && (
              <IconButton onClick={() => navigate(`/tagging/tags/${tagId}/edit`)} title="Edit tag details">
                <Edit fontSize="small" />
              </IconButton>
            )}
            <IconButton onClick={onClose}><Close /></IconButton>
          </Stack>
        </Stack>

        {isLoading && <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}><CircularProgress /></Box>}

        {tag && (
          <>
            <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 2 }}>
              <Typography variant="h5" fontWeight={900} sx={{ fontFamily: 'monospace', color: '#44C47A' }}>
                {tag.tagNumber}
              </Typography>
              <StatusChip status={tag.status} />
            </Stack>

            <Grid container spacing={1.5} sx={{ mb: 2 }}>
              <Grid item xs={12}><Typography fontWeight={700} variant="subtitle1">{tag.name}</Typography></Grid>
              <Grid item xs={4}><Typography variant="caption" color="text.secondary">Branch</Typography>
                <Typography>{tag.branch?.name}</Typography></Grid>
              <Grid item xs={4}><Typography variant="caption" color="text.secondary">Metal</Typography>
                <Typography>{tag.metalType} {tag.metalKarat}</Typography></Grid>
              <Grid item xs={4}><Typography variant="caption" color="text.secondary">Setting</Typography>
                <Typography>{tag.settingType || '—'}</Typography></Grid>
              <Grid item xs={4}><Typography variant="caption" color="text.secondary">Gross Weight</Typography>
                <Typography fontFamily="monospace">{Number(tag.grossWeight).toFixed(3)} g</Typography></Grid>
              <Grid item xs={4}><Typography variant="caption" color="text.secondary">Net Weight</Typography>
                <Typography fontFamily="monospace">{Number(tag.netWeight).toFixed(3)} g</Typography></Grid>
              <Grid item xs={4}><Typography variant="caption" color="text.secondary">Stone Weight</Typography>
                <Typography fontFamily="monospace">{Number(tag.stoneWeight).toFixed(3)} ct</Typography></Grid>
              <Grid item xs={6}><Typography variant="caption" color="text.secondary">HUID</Typography>
                <Typography fontFamily="monospace">{tag.huid || '—'}</Typography></Grid>
              <Grid item xs={6}><Typography variant="caption" color="text.secondary">Job Card</Typography>
                <Typography fontFamily="monospace">{tag.jobCard?.jobNumber || '—'}</Typography></Grid>
              <Grid item xs={6}><Typography variant="caption" color="text.secondary">Cost Price</Typography>
                <Typography fontWeight={700}>{fmt(Number(tag.costPrice))}</Typography></Grid>
              <Grid item xs={6}><Typography variant="caption" color="text.secondary">Selling Price</Typography>
                <Typography fontWeight={700} color="primary.main">{fmt(Number(tag.sellingPrice))}</Typography></Grid>
              {tag.notes && <Grid item xs={12}><Typography variant="caption" color="text.secondary">Notes</Typography>
                <Typography>{tag.notes}</Typography></Grid>}
            </Grid>

            {(tag.memoItems ?? []).length > 0 && (
              <>
                <Divider sx={{ my: 2 }} />
                <Typography variant="subtitle2" fontWeight={700} gutterBottom>Approval History</Typography>
                {tag.memoItems.map((mi: any) => (
                  <Box key={mi.id} sx={{ p: 1.5, bgcolor: 'action.hover', borderRadius: 1, mb: 1 }}>
                    <Stack direction="row" justifyContent="space-between">
                      <Typography variant="body2" fontWeight={600}>{mi.memo?.memoNumber}</Typography>
                      <Chip label={mi.memo?.status} size="small" />
                    </Stack>
                    <Typography variant="caption" color="text.secondary">
                      Sent {new Date(mi.memo?.sentDate).toLocaleDateString('en-IN')}
                    </Typography>
                  </Box>
                ))}
              </>
            )}

            {(tag.transferItems ?? []).length > 0 && (
              <>
                <Divider sx={{ my: 2 }} />
                <Typography variant="subtitle2" fontWeight={700} gutterBottom>Transfer History</Typography>
                {tag.transferItems.map((ti: any) => (
                  <Box key={ti.id} sx={{ p: 1.5, bgcolor: 'action.hover', borderRadius: 1, mb: 1 }}>
                    <Stack direction="row" justifyContent="space-between">
                      <Typography variant="body2" fontWeight={600}>{ti.transfer?.transferNumber}</Typography>
                      <Chip label={ti.transfer?.status} size="small" />
                    </Stack>
                    <Typography variant="caption" color="text.secondary">
                      {ti.transfer?.fromBranch?.name} → {ti.transfer?.toBranch?.name}
                    </Typography>
                  </Box>
                ))}
              </>
            )}

            {['IN_STOCK', 'RETURNED'].includes(tag.status) && (
              <>
                <Divider sx={{ my: 2 }} />
                <Button variant="outlined" color="error" startIcon={<Block />}
                  disabled={retireMutation.isPending} onClick={() => retireMutation.mutate()}>
                  Retire Tag
                </Button>
              </>
            )}
          </>
        )}
      </Box>
    </Drawer>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export function TagsPage() {
  const navigate = useNavigate();
  const [statusFilter, setStatusFilter] = useState('');
  const [branchFilter, setBranchFilter] = useState('');
  const [dateFrom, setDateFrom]         = useState(todayStr());
  const [dateTo, setDateTo]             = useState(todayStr());
  const [selectedTagId, setSelectedTagId] = useState('');

  const { data: branchData } = useQuery({
    queryKey: ['branches'],
    queryFn: () => apiGet<any>('/tagging/branches'),
  });
  const branches: any[] = (branchData as any)?.data ?? branchData ?? [];

  const { data, isLoading } = useQuery({
    queryKey: ['jewelry-tags', statusFilter, branchFilter, dateFrom, dateTo],
    queryFn: () => apiGet<any>('/tagging/tags', {
      status:   statusFilter || undefined,
      branchId: branchFilter || undefined,
      dateFrom: dateFrom     || undefined,
      dateTo:   dateTo       || undefined,
    }),
  });
  const tags: any[] = (data as any)?.tags ?? [];

  const clearFilters = () => {
    setStatusFilter(''); setBranchFilter(''); setDateFrom(''); setDateTo('');
  };
  const hasFilter = statusFilter || branchFilter || dateFrom || dateTo;

  return (
    <Box>
      <PageHeader
        title="Tags & Inventory"
        subtitle="Track every finished jewelry piece by its unique tag"
        breadcrumbs={[{ label: 'Jewelry Tagging', path: '/tagging/tags' }, { label: 'Tags' }]}
        actions={[{
          label: 'New Tag', icon: <Add />,
          onClick: () => navigate('/tagging/tags/new'),
        }]}
      />

      {/* Filters */}
      <Card sx={{ mb: 2, p: 1.5 }}>
        <Grid container spacing={2} alignItems="center">
          <Grid item xs={6} sm={3} md={2}>
            <TextField select fullWidth size="small" label="Status" value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}>
              <MenuItem value="">All Statuses</MenuItem>
              {TAG_STATUSES.map((s) => <MenuItem key={s} value={s}>{s}</MenuItem>)}
            </TextField>
          </Grid>
          <Grid item xs={6} sm={3} md={2}>
            <TextField select fullWidth size="small" label="Branch" value={branchFilter}
              onChange={(e) => setBranchFilter(e.target.value)}>
              <MenuItem value="">All Branches</MenuItem>
              {branches.map((b: any) => <MenuItem key={b.id} value={b.id}>{b.name}</MenuItem>)}
            </TextField>
          </Grid>
          <Grid item xs={6} sm={3} md={2}>
            <TextField fullWidth size="small" label="Tagged From" type="date"
              value={dateFrom} onChange={(e) => setDateFrom(e.target.value)}
              InputLabelProps={{ shrink: true }} />
          </Grid>
          <Grid item xs={6} sm={3} md={2}>
            <TextField fullWidth size="small" label="Tagged To" type="date"
              value={dateTo} onChange={(e) => setDateTo(e.target.value)}
              InputLabelProps={{ shrink: true }} />
          </Grid>
          <Grid item>
            <Typography variant="caption" color="text.secondary">
              {(data as any)?.total ?? 0} tags
            </Typography>
          </Grid>
          {hasFilter && (
            <Grid item>
              <Button size="small" variant="text" onClick={clearFilters}>Clear</Button>
            </Grid>
          )}
        </Grid>
      </Card>

      {/* Table — same DataTable every Masters screen uses: drag column headers to reorder,
          right-click a header to hide/show/auto-fit/reset, drag the right edge to resize, and
          the small funnel icon on hover opens an Excel-style per-column value filter (separate
          from — and stacked on top of — the server-side Status/Branch/date filters above). */}
      <DataTable
        tableId="tagging-tags"
        rows={tags}
        isLoading={isLoading}
        getRowId={(t: any) => t.id}
        onRowClick={(t: any) => setSelectedTagId(t.id)}
        emptyLabel={hasFilter ? 'No tags match the current filters.' : 'No tags yet — click "New Tag" to start.'}
        columns={[
          {
            key: 'tagNumber', label: 'Tag Number', width: 150,
            render: (t: any) => <Typography sx={{ fontFamily: 'monospace', fontWeight: 700, color: '#44C47A', fontSize: 12 }}>{t.tagNumber}</Typography>,
          },
          {
            key: 'name', label: 'Name', width: 180,
            render: (t: any) => <Typography variant="body2" noWrap fontWeight={600}>{t.name}</Typography>,
          },
          {
            key: 'branch', label: 'Branch', width: 130,
            filterValue: (t: any) => t.branch?.name ?? '',
            render: (t: any) => <Typography fontSize={12}>{t.branch?.name}</Typography>,
          },
          {
            key: 'metal', label: 'Metal / Karat', width: 130,
            filterValue: (t: any) => `${t.metalType} ${t.metalKarat ?? ''}`.trim(),
            render: (t: any) => <Chip label={`${t.metalType} ${t.metalKarat ?? ''}`} size="small" />,
          },
          {
            key: 'grossWeight', label: 'Gross Wt', align: 'right', width: 100,
            render: (t: any) => <Typography sx={{ fontFamily: 'monospace', fontSize: 12 }}>{Number(t.grossWeight).toFixed(3)} g</Typography>,
          },
          {
            key: 'sellingPrice', label: 'Selling Price', align: 'right', width: 130,
            render: (t: any) => <Typography sx={{ fontFamily: 'monospace', fontWeight: 700, fontSize: 12 }}>{fmt(Number(t.sellingPrice))}</Typography>,
          },
          {
            key: 'huid', label: 'HUID', width: 110,
            render: (t: any) => <Typography sx={{ fontFamily: 'monospace', fontSize: 11 }}>{t.huid || '—'}</Typography>,
          },
          {
            key: 'status', label: 'Status', width: 110,
            render: (t: any) => <StatusChip status={t.status} />,
          },
          {
            key: 'createdAt', label: 'Tagged On', width: 100,
            filterValue: (t: any) => new Date(t.createdAt).toLocaleDateString('en-IN'),
            render: (t: any) => <Typography fontSize={11}>{new Date(t.createdAt).toLocaleDateString('en-IN')}</Typography>,
          },
          {
            key: 'actions', label: 'Edit', align: 'center', width: 56, hideable: false, filterable: false,
            render: (t: any) => (
              <IconButton size="small" title="Edit tag details"
                onClick={(e) => { e.stopPropagation(); navigate(`/tagging/tags/${t.id}/edit`); }}>
                <Edit fontSize="small" />
              </IconButton>
            ),
          },
        ]}
      />

      {selectedTagId && <TagDrawer tagId={selectedTagId} onClose={() => setSelectedTagId('')} />}
    </Box>
  );
}
