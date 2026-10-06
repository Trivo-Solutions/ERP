import { useMemo, useState } from 'react';
import {
  Box, Card, Typography, Chip, TextField, Button, Dialog, DialogTitle, DialogContent, DialogActions, Alert,
  Checkbox, FormControlLabel, Stack,
} from '@mui/material';
import { Add } from '@mui/icons-material';
import { useQuery, useMutation, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { useSnackbar } from 'notistack';
import { apiGet, apiPost } from '../../api/client';
import { PageHeader } from '../../components/common/PageHeader';
import { DataTable, DataTableColumn } from '../../components/common/DataTable';
import { SelectField } from '../../components/fields/SelectField';
import { DateField } from '../../components/fields/DateField';
import { useAuthStore } from '../../store/auth.store';

// Repair Transfers — returned jewellery moving from a branch to Head Office. A piece is NOT at Head Office until HO
// presses Receive: until then it is in transit and the branch is not holding it either. Branch users create and send;
// only Head Office users receive (the server refuses anyone else, whatever buttons are showing).

type Row = Record<string, any>;
const STATUS_COLOR: Record<string, 'default' | 'success' | 'info' | 'warning' | 'error'> = { DRAFT: 'default', IN_TRANSIT: 'info', RECEIVED: 'success', CANCELLED: 'error' };
const STATUS_OPTIONS = ['DRAFT', 'IN_TRANSIT', 'RECEIVED', 'CANCELLED'].map((s) => ({ value: s, label: s.replace('_', ' ') }));
const stamp = (v?: string | null) => (v ? new Date(v).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—');
const errText = (e: any) => e?.response?.data?.error ?? e?.message ?? 'Failed';

export function RepairTransfers() {
  const { enqueueSnackbar } = useSnackbar();
  const qc = useQueryClient();
  const can = useAuthStore((s) => s.hasPermission);

  const [f, setF] = useState({ dateFrom: '', dateTo: '', branchId: '', tagNumber: '', transferNumber: '', status: '', repairNumber: '' });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((p) => ({ ...p, [k]: e.target.value }));
  const params = Object.fromEntries(Object.entries(f).filter(([, v]) => v)) as Record<string, string>;

  const { data: rows = [], isLoading } = useQuery({ queryKey: ['repair-transfers', params], queryFn: () => apiGet<Row[]>('/tagging/repair-transfers', params), placeholderData: keepPreviousData });
  const { data: branches = [] } = useQuery({ queryKey: ['repair-branches'], queryFn: () => apiGet<any[]>('/tagging/branches') });

  const refresh = () => { qc.invalidateQueries({ queryKey: ['repair-transfers'] }); qc.invalidateQueries({ queryKey: ['repair-register'] }); qc.invalidateQueries({ queryKey: ['repair-eligible'] }); };
  const act = useMutation({
    mutationFn: ({ url, body }: { url: string; body?: object }) => apiPost(url, body ?? {}),
    onSuccess: () => { enqueueSnackbar('Done', { variant: 'success' }); refresh(); },
    onError: (e: any) => enqueueSnackbar(errText(e), { variant: 'error' }),
  });

  // ── New transfer ──
  const [dlg, setDlg] = useState(false);
  const [from, setFrom] = useState('');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [reason, setReason] = useState('');
  const [remarks, setRemarks] = useState('');
  const { data: eligible = [] } = useQuery({
    queryKey: ['repair-eligible', from], enabled: dlg && !!from,
    queryFn: () => apiGet<Row[]>('/tagging/repairs', { status: 'RETURNED_PENDING_TRANSFER', branchId: from }),
  });
  const create = useMutation({
    mutationFn: () => apiPost('/tagging/repair-transfers', { fromBranchId: from, repairCaseIds: [...picked], reason, remarks }),
    onSuccess: () => { enqueueSnackbar('Repair transfer created (draft) — send it when the pieces leave the branch', { variant: 'success' }); setDlg(false); setPicked(new Set()); setReason(''); setRemarks(''); refresh(); },
    onError: (e: any) => enqueueSnackbar(errText(e), { variant: 'error' }),
  });
  const toggle = (id: string) => setPicked((p) => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  const columns = useMemo<DataTableColumn[]>(() => [
    { key: 'transferNumber', label: 'Transfer No.', width: 150, render: (r) => <Box component="span" sx={{ fontFamily: 'monospace', fontWeight: 700 }}>{r.transferNumber}</Box> },
    { key: 'repairNumber', label: 'Repair No.', width: 150 },
    { key: 'tagNumber', label: 'Jewel Code', width: 130, render: (r) => <Box component="span" sx={{ fontFamily: 'monospace', fontWeight: 700, color: 'secondary.main' }}>{r.tagNumber}</Box> },
    { key: 'returnNumber', label: 'Sale Return No.', width: 150, filterValue: (r) => r.returnNumber ?? '—', render: (r) => r.returnNumber ?? '—' },
    { key: 'fromBranch', label: 'From Branch', width: 140 },
    { key: 'toBranch', label: 'To (HO)', width: 130 },
    { key: 'sentAt', label: 'Sent', width: 160, sortValue: (r) => (r.sentAt ? new Date(r.sentAt).getTime() : 0), filterValue: (r) => stamp(r.sentAt), render: (r) => stamp(r.sentAt), csvValue: (r) => stamp(r.sentAt) },
    { key: 'sentBy', label: 'Sent By', width: 120, filterValue: (r) => r.sentBy ?? '—', render: (r) => r.sentBy ?? '—' },
    { key: 'receivedAt', label: 'HO Received', width: 160, sortValue: (r) => (r.itemReceivedAt ? new Date(r.itemReceivedAt).getTime() : 0), filterValue: (r) => stamp(r.itemReceivedAt), render: (r) => stamp(r.itemReceivedAt), csvValue: (r) => stamp(r.itemReceivedAt) },
    { key: 'receivedBy', label: 'Received By', width: 120, filterValue: (r) => (r.itemReceivedAt ? r.receivedBy ?? '—' : '—'), render: (r) => (r.itemReceivedAt ? r.receivedBy ?? '—' : '—'), csvValue: (r) => (r.itemReceivedAt ? r.receivedBy ?? '' : '') },
    {
      key: 'status', label: 'Transfer Status', width: 140, filterValue: (r) => r.status, sortValue: (r) => r.status,
      render: (r) => <Chip size="small" variant="outlined" color={STATUS_COLOR[r.status] ?? 'default'} label={r.status.replace('_', ' ')} />, csvValue: (r) => r.status,
    },
    { key: 'reason', label: 'Reason', width: 160, render: (r) => r.reason ?? '—' },
    { key: 'remarks', label: 'Remarks', width: 200, render: (r) => r.remarks ?? '—' },
    {
      key: 'actions', label: 'Actions', width: 230, hideable: false, filterable: false, csvValue: () => '',
      render: (r) => (
        <Stack direction="row" spacing={0.5}>
          {r.status === 'DRAFT' && can('repair:send') && <Button size="small" variant="outlined" sx={{ py: 0 }} onClick={() => act.mutate({ url: `/tagging/repair-transfers/${r.transferId}/send` })}>Send</Button>}
          {r.status === 'DRAFT' && can('repair:send') && <Button size="small" variant="outlined" color="error" sx={{ py: 0 }} onClick={() => act.mutate({ url: `/tagging/repair-transfers/${r.transferId}/cancel` })}>Cancel</Button>}
          {r.status === 'IN_TRANSIT' && !r.itemReceivedAt && can('repair:receive') && (
            <Button size="small" variant="contained" color="success" sx={{ py: 0 }} onClick={() => act.mutate({ url: `/tagging/repair-transfers/${r.transferId}/receive`, body: { repairCaseIds: [r.repairCaseId] } })}>Receive at HO</Button>
          )}
        </Stack>
      ),
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [can]);

  return (
    <Box>
      <PageHeader title="Repair Transfers" subtitle="Returned jewellery sent from branches to Head Office"
        actions={can('repair:send') ? [{ label: 'New Transfer', icon: <Add />, onClick: () => setDlg(true) }] : []} />
      <Card sx={{ p: 1.5, mb: 1.5 }}>
        <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr 1fr', md: 'repeat(7, 1fr)' }, gap: 1.5, alignItems: 'center' }}>
          <DateField size="small" label="From" value={f.dateFrom} onChange={set('dateFrom')} />
          <DateField size="small" label="To" value={f.dateTo} onChange={set('dateTo')} />
          <SelectField size="small" label="From Branch" value={f.branchId} onChange={set('branchId')} emptyLabel="All Branches" options={branches.map((b: any) => ({ value: b.id, label: b.name }))} />
          <TextField size="small" label="Jewel Code" value={f.tagNumber} onChange={set('tagNumber')} InputLabelProps={{ shrink: true }} />
          <TextField size="small" label="Transfer No." value={f.transferNumber} onChange={set('transferNumber')} InputLabelProps={{ shrink: true }} />
          <TextField size="small" label="Repair No." value={f.repairNumber} onChange={set('repairNumber')} InputLabelProps={{ shrink: true }} />
          <SelectField size="small" label="Status" value={f.status} onChange={set('status')} emptyLabel="All Statuses" options={STATUS_OPTIONS} />
        </Box>
      </Card>

      <DataTable
        tableId="repair-transfers" columns={columns} rows={rows} isLoading={isLoading} getRowId={(r) => `${r.transferId}:${r.repairCaseId}`}
        emptyLabel="No repair transfers match these filters" sortable pageSizeOptions={[100, 200, 500]} maxHeight="calc(100vh - 330px)" csvFileName="repair-transfers"
      />

      <Dialog open={dlg} onClose={() => setDlg(false)} maxWidth="sm" fullWidth>
        <DialogTitle fontWeight={700}>New repair transfer to Head Office</DialogTitle>
        <DialogContent>
          <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 1.5, mt: 0.5 }}>
            <SelectField label="Sending branch" value={from} onChange={(e) => { setFrom(e.target.value); setPicked(new Set()); }} emptyLabel="Select branch" options={branches.map((b: any) => ({ value: b.id, label: b.name }))} />
            <TextField label="Reason" value={reason} onChange={(e) => setReason(e.target.value)} InputLabelProps={{ shrink: true }} />
            <TextField sx={{ gridColumn: '1 / -1' }} label="Remarks" value={remarks} onChange={(e) => setRemarks(e.target.value)} InputLabelProps={{ shrink: true }} />
          </Box>
          <Typography variant="subtitle2" sx={{ mt: 2, mb: 0.5 }}>Returned pieces waiting at this branch</Typography>
          {!from ? <Alert severity="info">Choose the sending branch.</Alert>
            : eligible.length === 0 ? <Alert severity="info">No returned pieces are waiting to be sent from this branch.</Alert>
            : eligible.map((r) => (
              <FormControlLabel key={r.id} sx={{ display: 'flex' }} control={<Checkbox size="small" checked={picked.has(r.id)} onChange={() => toggle(r.id)} />}
                label={`${r.tagNumber} — ${r.description} · ${r.returnNumber ?? ''} · ${r.customer ?? ''} · ${r.grossWeight.toFixed(3)} g`} />
            ))}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDlg(false)}>Close</Button>
          <Button variant="contained" disabled={!from || picked.size === 0 || create.isPending} onClick={() => create.mutate()}>Create draft ({picked.size})</Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
