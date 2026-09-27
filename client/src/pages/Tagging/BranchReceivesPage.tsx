import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Box, Card, Chip, Grid, Typography } from '@mui/material';
import { useQuery } from '@tanstack/react-query';
import { apiGet } from '../../api/client';
import { PageHeader } from '../../components/common/PageHeader';
import { StatusChip } from '../../components/common/StatusChip';
import { DataTable } from '../../components/common/DataTable';
import { SelectField } from '../../components/fields/SelectField';

// The receiving branch's inbox: transfers that were approved and dispatched to it, waiting to be
// verified and taken in. Opening one goes to BranchReceiveDetailPage, where the pieces are ticked off.

const VIEWS: Record<string, { label: string; status?: string }> = {
  AWAITING: { label: 'Awaiting receipt', status: 'DISPATCHED,PARTIALLY_RECEIVED' },
  RECEIVED: { label: 'Fully received', status: 'RECEIVED' },
  ALL: { label: 'All incoming', status: 'DISPATCHED,PARTIALLY_RECEIVED,RECEIVED' },
};

const fmtDate = (v?: string) => (v ? new Date(v).toLocaleDateString('en-IN') : '');

export function BranchReceivesPage() {
  const navigate = useNavigate();
  const [view, setView] = useState('AWAITING');
  const [toBranchId, setToBranchId] = useState('');

  const { data: branchData } = useQuery({
    queryKey: ['branches'],
    queryFn: () => apiGet<any>('/tagging/branches'),
  });
  const branches: any[] = (branchData as any)?.data ?? branchData ?? [];

  const { data, isLoading } = useQuery({
    queryKey: ['branch-transfers', 'incoming', view, toBranchId],
    queryFn: () => apiGet<any>('/tagging/transfers', {
      incoming: true, status: VIEWS[view].status, toBranchId: toBranchId || undefined, limit: 100,
    }),
  });
  const transfers: any[] = (data as any)?.transfers ?? [];

  return (
    <Box>
      <PageHeader title="Branch Receives" />

      <Card sx={{ mb: 2, p: 1.5 }}>
        <Grid container spacing={2} alignItems="center">
          <Grid item xs={12} sm={4} md={3}>
            <SelectField size="small" label="Show" value={view} onChange={(e) => setView(e.target.value)}
              options={Object.entries(VIEWS).map(([value, v]) => ({ value, label: v.label }))} />
          </Grid>
          <Grid item xs={12} sm={4} md={3}>
            <SelectField size="small" label="Receiving Branch" value={toBranchId} emptyLabel="All branches"
              onChange={(e) => setToBranchId(e.target.value)}
              options={branches.map((b: any) => ({ value: b.id, label: b.name }))} />
          </Grid>
          <Grid item>
            <Typography variant="caption" color="text.secondary">{(data as any)?.total ?? 0} transfers</Typography>
          </Grid>
        </Grid>
      </Card>

      <Card>
        <DataTable
          tableId="branch-receives"
          isLoading={isLoading}
          rows={transfers}
          getRowId={(r) => r.id}
          emptyLabel={view === 'AWAITING' ? 'Nothing waiting to be received' : 'No transfers'}
          onRowClick={(r) => navigate(`/tagging/receives/${r.id}`)}
          columns={[
            { key: 'transferNumber', label: 'Transfer #', render: (r) => (
              <Typography component="span" sx={{ fontFamily: 'monospace', fontWeight: 700, fontSize: 12, color: 'secondary.main' }}>
                {r.transferNumber}
              </Typography>
            ) },
            { key: 'from', label: 'From Branch', filterValue: (r) => r.fromBranch?.name ?? '', render: (r) => r.fromBranch?.name },
            { key: 'to', label: 'To Branch', filterValue: (r) => r.toBranch?.name ?? '', render: (r) => r.toBranch?.name },
            { key: 'items', label: 'Items', align: 'center', filterable: false, render: (r) => <Chip label={r._count?.items ?? 0} size="small" /> },
            {
              key: 'received', label: 'Received', align: 'center', filterable: false,
              filterValue: () => '',
              render: (r) => {
                const total = r._count?.items ?? 0;
                const done = (r.items ?? []).filter((i: any) => i.receivedAt).length;
                return <Chip size="small" label={`${done} / ${total}`} color={done === total ? 'success' : done > 0 ? 'warning' : 'default'} />;
              },
            },
            { key: 'requestedBy', label: 'Requested By', filterValue: (r) => r.requestedBy?.name ?? '', render: (r) => r.requestedBy?.name },
            { key: 'dispatchedAt', label: 'Dispatched', filterValue: (r) => fmtDate(r.dispatchedAt), render: (r) => fmtDate(r.dispatchedAt) },
            { key: 'status', label: 'Status', filterValue: (r) => r.status, render: (r) => <StatusChip status={r.status} /> },
          ]}
        />
      </Card>
    </Box>
  );
}
