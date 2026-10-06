import { useMemo, useState } from 'react';
import {
  Box, Card, Typography, Chip, TextField, Button, Dialog, DialogTitle, DialogContent, DialogActions, Stack, Alert, Tooltip,
} from '@mui/material';
import { useQuery, useMutation, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { useSnackbar } from 'notistack';
import { apiGet, apiPost } from '../../api/client';
import { PageHeader } from '../../components/common/PageHeader';
import { DataTable, DataTableColumn } from '../../components/common/DataTable';
import { SelectField } from '../../components/fields/SelectField';
import { DateField } from '../../components/fields/DateField';
import { useAuthStore } from '../../store/auth.store';
import { printTsplViaAgent } from '../../utils/printAgent';
import { printAgentSnackbarAction } from '../../utils/printAgentSnackbarAction';

// Repair Register — what happened to returned jewellery after the customer brought it back. The financial side
// (what was refunded) stays in the Sales Return register; this is the physical side: transfer to Head Office,
// inspection, repair, final inspection, and either back to stock (same Jewel Code), melt, or a true retag.
// Buttons only mirror the permission each endpoint enforces — the server is what actually refuses.

type Row = Record<string, any>;

export const REPAIR_STATUS_LABEL: Record<string, string> = {
  RETURNED_PENDING_TRANSFER: 'Returned — pending transfer', IN_TRANSIT_TO_HO: 'In transit to HO', HO_RECEIVED: 'At HO — pending inspection',
  REPAIR_REQUIRED: 'Repair required', IN_REPAIR: 'In repair', REPAIR_COMPLETED: 'Repair done — pending final inspection',
  INSPECTION_PASSED: 'Passed — back in stock', MELT_PENDING: 'Melt pending', RETAGGED: 'Retagged',
};
const STATUS_COLOR: Record<string, 'default' | 'success' | 'info' | 'warning' | 'error'> = {
  RETURNED_PENDING_TRANSFER: 'warning', IN_TRANSIT_TO_HO: 'info', HO_RECEIVED: 'warning', REPAIR_REQUIRED: 'error', IN_REPAIR: 'error',
  REPAIR_COMPLETED: 'warning', INSPECTION_PASSED: 'success', MELT_PENDING: 'default', RETAGGED: 'default',
};
const LOCATION_LABEL: Record<string, string> = { BRANCH: 'Branch', IN_TRANSIT: 'In transit', HEAD_OFFICE: 'Head Office' };
const STATUS_OPTIONS = Object.entries(REPAIR_STATUS_LABEL).map(([value, label]) => ({ value, label }));
const RESULT_OPTIONS = [{ value: 'PASS', label: 'PASS' }, { value: 'REPAIR_REQUIRED', label: 'REPAIR_REQUIRED' }, { value: 'MELT', label: 'MELT' }];

const day = (v?: string | null) => (v ? new Date(v).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');
const stamp = (v?: string | null) => (v ? new Date(v).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—');
const errText = (e: any) => e?.response?.data?.error ?? e?.message ?? 'Failed';
const num = (v: unknown) => (v === '' || v === undefined || v === null ? undefined : Number(v));

type Action = 'inspect' | 'start' | 'complete' | 'final' | 'retag';

export function RepairRegister() {
  const { enqueueSnackbar } = useSnackbar();
  const qc = useQueryClient();
  const can = useAuthStore((s) => s.hasPermission);

  const [f, setF] = useState({ dateFrom: '', dateTo: '', branchId: '', headOffice: '', repairNumber: '', tagNumber: '', returnNumber: '', invoiceNumber: '', customer: '', status: '', assignedToId: '', repairEmployeeId: '', inspectionResult: '' });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((p) => ({ ...p, [k]: e.target.value }));
  const params = Object.fromEntries(Object.entries(f).filter(([, v]) => v)) as Record<string, string>;

  const { data: rows = [], isLoading, isFetching } = useQuery({
    queryKey: ['repair-register', params],
    queryFn: () => apiGet<Row[]>('/tagging/repairs', params),
    placeholderData: keepPreviousData,
  });
  const { data: branches = [] } = useQuery({ queryKey: ['repair-branches'], queryFn: () => apiGet<any[]>('/tagging/branches') });
  const { data: employees = [] } = useQuery({ queryKey: ['repair-employees'], queryFn: () => apiGet<{ id: string; name: string }[]>('/tagging/repairs/employees') });

  const [dlg, setDlg] = useState<{ action: Action; row: Row } | null>(null);
  const [form, setForm] = useState<Record<string, string>>({});
  const open = (action: Action, row: Row) => { setForm(action === 'inspect' ? { result: 'PASS' } : action === 'final' ? { result: 'PASS' } : {}); setDlg({ action, row }); };
  const fset = (k: string) => (e: { target: { value: string } }) => setForm((p) => ({ ...p, [k]: e.target.value }));

  const refresh = () => qc.invalidateQueries({ queryKey: ['repair-register'] });
  const mut = useMutation({
    mutationFn: async () => {
      if (!dlg) return;
      const id = dlg.row.id;
      switch (dlg.action) {
        case 'inspect': return apiPost(`/tagging/repairs/${id}/inspect`, { result: form.result, reason: form.reason, remarks: form.remarks, assignedToId: form.assignedToId || undefined });
        case 'start': return apiPost(`/tagging/repairs/${id}/start`, { repairEmployeeId: form.repairEmployeeId || undefined, remarks: form.remarks });
        case 'complete': return apiPost(`/tagging/repairs/${id}/complete`, { details: form.details, repairCost: num(form.repairCost), remarks: form.remarks });
        case 'final': return apiPost(`/tagging/repairs/${id}/final-inspection`, { result: form.result, remarks: form.remarks });
        case 'retag': return apiPost(`/tagging/repairs/${id}/retag`, {
          reason: form.reason, remarks: form.remarks,
          changes: Object.fromEntries(Object.entries({
            grossWeight: num(form.grossWeight), stoneWeight: num(form.stoneWeight), netWeight: num(form.netWeight), sellingPrice: num(form.sellingPrice),
            metalKarat: form.metalKarat || undefined, name: form.name || undefined, huid: form.huid || undefined,
          }).filter(([, v]) => v !== undefined)),
        });
      }
    },
    onSuccess: (res: any) => {
      const msg = dlg?.action === 'retag' ? `Retagged as ${res?.newTagNumber}` : 'Saved';
      enqueueSnackbar(msg, { variant: 'success' });
      setDlg(null);
      refresh();
    },
    onError: (e: any) => enqueueSnackbar(errText(e), { variant: 'error' }),
  });

  const reprint = useMutation({
    mutationFn: async (row: Row) => {
      const out = await apiPost<{ print?: { tspl: string } }>(`/tagging/tags/${row.tagId}/reprint`, { reason: 'Reprinted from Repair Register' });
      if (out?.print?.tspl) await printTsplViaAgent(out.print.tspl);
    },
    onSuccess: () => enqueueSnackbar('Same tag reprinted (recorded in audit)', { variant: 'success' }),
    onError: (e: any) => enqueueSnackbar(errText(e), { variant: 'error', action: printAgentSnackbarAction(e) }),
  });

  const actionsFor = (r: Row) => {
    const out: JSX.Element[] = [];
    const btn = (label: string, onClick: () => void, color: 'primary' | 'warning' | 'success' | 'inherit' = 'primary') =>
      out.push(<Button key={label} size="small" variant="outlined" color={color} sx={{ py: 0, minWidth: 0 }} onClick={onClick}>{label}</Button>);
    if (r.status === 'HO_RECEIVED') {
      if (can('repair:inspect')) btn('Inspect', () => open('inspect', r), 'warning');
      if (can('retag:create')) btn('Retag', () => open('retag', r), 'inherit');
    }
    if (r.status === 'REPAIR_REQUIRED' && can('repair:work')) btn('Start repair', () => open('start', r), 'warning');
    if (r.status === 'IN_REPAIR' && can('repair:work')) btn('Complete repair', () => open('complete', r), 'success');
    if (r.status === 'REPAIR_COMPLETED') {
      if (can('repair:inspect')) btn('Final inspection', () => open('final', r), 'success');
      if (can('retag:create')) btn('Retag', () => open('retag', r), 'inherit');
    }
    if (['INSPECTION_PASSED', 'HO_RECEIVED'].includes(r.status) && can('retag:reprint')) btn('Reprint tag', () => reprint.mutate(r), 'inherit');
    return <Stack direction="row" spacing={0.5} sx={{ flexWrap: 'nowrap' }}>{out}</Stack>;
  };

  const columns = useMemo<DataTableColumn[]>(() => [
    { key: 'repairNumber', label: 'Repair No.', width: 150, render: (r) => <Box component="span" sx={{ fontFamily: 'monospace', fontWeight: 700 }}>{r.repairNumber}</Box> },
    { key: 'tagNumber', label: 'Jewel Code', width: 130, render: (r) => <Box component="span" sx={{ fontFamily: 'monospace', fontWeight: 700, color: 'secondary.main' }}>{r.tagNumber}</Box> },
    { key: 'description', label: 'Description', width: 160 },
    { key: 'originBranch', label: 'Original Branch', width: 140 },
    { key: 'currentLocation', label: 'Current Location', width: 150, filterValue: (r) => LOCATION_LABEL[r.currentLocation] ?? r.currentLocation, render: (r) => `${LOCATION_LABEL[r.currentLocation] ?? r.currentLocation} (${r.currentBranch})`, csvValue: (r) => `${LOCATION_LABEL[r.currentLocation]} (${r.currentBranch})` },
    { key: 'customer', label: 'Customer', width: 150, filterValue: (r) => r.customer ?? '—', render: (r) => r.customer ?? '—' },
    { key: 'returnNumber', label: 'Sale Return No.', width: 150, filterValue: (r) => r.returnNumber ?? '—', render: (r) => r.returnNumber ?? '—' },
    { key: 'invoiceNumber', label: 'Original Invoice', width: 150, filterValue: (r) => r.invoiceNumber ?? '—', render: (r) => r.invoiceNumber ?? '—' },
    { key: 'returnDate', label: 'Return Date', width: 120, sortValue: (r) => (r.returnDate ? new Date(r.returnDate).getTime() : 0), filterValue: (r) => day(r.returnDate), render: (r) => day(r.returnDate), csvValue: (r) => day(r.returnDate) },
    { key: 'transferNumber', label: 'HO Transfer No.', width: 150, filterValue: (r) => r.transferNumber ?? '—', render: (r) => r.transferNumber ?? '—' },
    { key: 'hoReceivedAt', label: 'HO Received', width: 150, sortValue: (r) => (r.hoReceivedAt ? new Date(r.hoReceivedAt).getTime() : 0), filterValue: (r) => day(r.hoReceivedAt), render: (r) => stamp(r.hoReceivedAt), csvValue: (r) => stamp(r.hoReceivedAt) },
    { key: 'inspectionResult', label: 'Inspection', width: 130, filterValue: (r) => r.inspectionResult ?? 'Pending', render: (r) => r.inspectionResult ?? 'Pending', csvValue: (r) => r.inspectionResult ?? 'Pending' },
    { key: 'repairReason', label: 'Repair Reason', width: 180, filterValue: (r) => r.repairReason ?? '—', render: (r) => r.repairReason ?? '—' },
    { key: 'assignedTo', label: 'Assigned To', width: 130, filterValue: (r) => r.assignedTo ?? '—', render: (r) => r.assignedTo ?? '—' },
    { key: 'repairEmployee', label: 'Repair Employee', width: 130, filterValue: (r) => r.repairEmployee ?? '—', render: (r) => r.repairEmployee ?? '—' },
    { key: 'repairStartedAt', label: 'Repair Start', width: 120, filterValue: (r) => day(r.repairStartedAt), render: (r) => day(r.repairStartedAt), csvValue: (r) => day(r.repairStartedAt) },
    { key: 'repairCompletedAt', label: 'Repair Completed', width: 130, filterValue: (r) => day(r.repairCompletedAt), render: (r) => day(r.repairCompletedAt), csvValue: (r) => day(r.repairCompletedAt) },
    { key: 'finalInspectedAt', label: 'Final Inspection', width: 130, filterValue: (r) => day(r.finalInspectedAt), render: (r) => day(r.finalInspectedAt), csvValue: (r) => day(r.finalInspectedAt) },
    {
      key: 'status', label: 'Status', width: 230, filterValue: (r) => REPAIR_STATUS_LABEL[r.status] ?? r.status, sortValue: (r) => r.status,
      render: (r) => <Chip size="small" variant="outlined" color={STATUS_COLOR[r.status] ?? 'default'} label={REPAIR_STATUS_LABEL[r.status] ?? r.status} />,
      csvValue: (r) => REPAIR_STATUS_LABEL[r.status] ?? r.status,
    },
    { key: 'newTagNumber', label: 'Retagged As', width: 130, defaultHidden: true, filterValue: (r) => r.newTagNumber ?? '—', render: (r) => r.newTagNumber ?? '—' },
    { key: 'karat', label: 'Karat', width: 80, defaultHidden: true, render: (r) => r.karat ?? '—' },
    { key: 'grossWeight', label: 'Gross Wt', width: 90, align: 'right', defaultHidden: true, sortValue: (r) => r.grossWeight, render: (r) => r.grossWeight.toFixed(3) },
    { key: 'stoneWeight', label: 'Stone Wt', width: 90, align: 'right', defaultHidden: true, sortValue: (r) => r.stoneWeight, render: (r) => r.stoneWeight.toFixed(3) },
    { key: 'netWeight', label: 'Net Wt', width: 90, align: 'right', defaultHidden: true, sortValue: (r) => r.netWeight, render: (r) => r.netWeight.toFixed(3) },
    { key: 'returnReason', label: 'Return Reason', width: 160, defaultHidden: true, render: (r) => r.returnReason ?? '—' },
    { key: 'remarks', label: 'Remarks', width: 200, defaultHidden: true, render: (r) => r.remarks ?? '—' },
    { key: 'createdBy', label: 'Created By', width: 120, defaultHidden: true, render: (r) => r.createdBy ?? '—' },
    { key: 'createdAt', label: 'Created', width: 150, defaultHidden: true, render: (r) => stamp(r.createdAt), csvValue: (r) => stamp(r.createdAt) },
    { key: 'actions', label: 'Actions', width: 330, hideable: false, filterable: false, render: (r) => actionsFor(r), csvValue: () => '' },
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [can]);

  const row = dlg?.row;
  const title = dlg ? { inspect: 'Inspect returned piece', start: 'Start repair', complete: 'Complete repair', final: 'Final inspection', retag: 'Retag (new Jewel Code)' }[dlg.action] : '';
  const needsReason = dlg?.action === 'inspect' && form.result !== 'PASS';
  const canSubmit = !dlg ? false
    : dlg.action === 'inspect' ? (form.result === 'PASS' || !!form.reason?.trim())
    : dlg.action === 'complete' ? !!form.details?.trim()
    : dlg.action === 'final' ? (form.result === 'PASS' || !!form.remarks?.trim())
    : dlg.action === 'retag' ? !!form.reason?.trim()
    : true;

  return (
    <Box>
      <PageHeader title="Repair Register" subtitle="Returned jewellery: transfer to Head Office, inspection, repair, final inspection, retagging" />
      <Card sx={{ p: 1.5, mb: 1.5 }}>
        <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr 1fr', md: 'repeat(7, 1fr)' }, gap: 1.5, alignItems: 'center' }}>
          <DateField size="small" label="From" value={f.dateFrom} onChange={set('dateFrom')} />
          <DateField size="small" label="To" value={f.dateTo} onChange={set('dateTo')} />
          <SelectField size="small" label="Branch" value={f.branchId} onChange={set('branchId')} emptyLabel="All Branches" options={branches.map((b: any) => ({ value: b.id, label: b.name }))} />
          <SelectField size="small" label="Location" value={f.headOffice} onChange={set('headOffice')} emptyLabel="Anywhere" options={[{ value: 'true', label: 'At Head Office' }]} />
          <TextField size="small" label="Repair No." value={f.repairNumber} onChange={set('repairNumber')} InputLabelProps={{ shrink: true }} />
          <TextField size="small" label="Jewel Code" value={f.tagNumber} onChange={set('tagNumber')} InputLabelProps={{ shrink: true }} />
          <TextField size="small" label="Sale Return No." value={f.returnNumber} onChange={set('returnNumber')} InputLabelProps={{ shrink: true }} />
          <TextField size="small" label="Original Invoice" value={f.invoiceNumber} onChange={set('invoiceNumber')} InputLabelProps={{ shrink: true }} />
          <TextField size="small" label="Customer" value={f.customer} onChange={set('customer')} InputLabelProps={{ shrink: true }} />
          <SelectField size="small" label="Status" value={f.status} onChange={set('status')} emptyLabel="All Statuses" options={STATUS_OPTIONS} />
          <SelectField size="small" label="Assigned Employee" value={f.assignedToId} onChange={set('assignedToId')} emptyLabel="Anyone" options={employees.map((e) => ({ value: e.id, label: e.name }))} />
          <SelectField size="small" label="Repair Employee" value={f.repairEmployeeId} onChange={set('repairEmployeeId')} emptyLabel="Anyone" options={employees.map((e) => ({ value: e.id, label: e.name }))} />
          <SelectField size="small" label="Inspection Result" value={f.inspectionResult} onChange={set('inspectionResult')} emptyLabel="Any" options={RESULT_OPTIONS} />
        </Box>
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
          A returned piece is NOT saleable stock until Head Office inspects it and it passes · right-click a column header for more columns{isFetching && !isLoading ? ' · refreshing…' : ''}
        </Typography>
      </Card>

      <DataTable
        tableId="repair-register" columns={columns} rows={rows} isLoading={isLoading} getRowId={(r) => r.id}
        emptyLabel="No returned pieces match these filters" sortable pageSizeOptions={[100, 200, 500]} maxHeight="calc(100vh - 380px)" csvFileName="repair-register"
      />

      <Dialog open={!!dlg} onClose={() => setDlg(null)} maxWidth="sm" fullWidth>
        <DialogTitle fontWeight={700}>{title}</DialogTitle>
        <DialogContent>
          {row && (
            <Alert severity="info" sx={{ mb: 2 }}>
              <b>{row.tagNumber}</b> — {row.description}{row.karat ? ` · ${row.karat}` : ''} · Gross {row.grossWeight.toFixed(3)} g · Stone {row.stoneWeight.toFixed(3)} g · Net {row.netWeight.toFixed(3)} g
              <br />{row.repairNumber} · return {row.returnNumber ?? '—'} · invoice {row.invoiceNumber ?? '—'} · {row.customer ?? '—'} · from {row.originBranch}
            </Alert>
          )}
          <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 1.5 }}>
            {dlg?.action === 'inspect' && (<>
              <SelectField label="Inspection result" value={form.result ?? ''} onChange={fset('result')} options={RESULT_OPTIONS} />
              {form.result === 'REPAIR_REQUIRED' && (
                <SelectField label="Assign to" value={form.assignedToId ?? ''} onChange={fset('assignedToId')} emptyLabel="Unassigned" options={employees.map((e) => ({ value: e.id, label: e.name }))} />
              )}
              {needsReason && <TextField sx={{ gridColumn: '1 / -1' }} label={form.result === 'MELT' ? 'Why is it unsuitable for resale?' : 'Repair / correction reason'} required value={form.reason ?? ''} onChange={fset('reason')} InputLabelProps={{ shrink: true }} />}
              {form.result === 'MELT' && <Alert severity="warning" sx={{ gridColumn: '1 / -1' }}>It stays non-saleable and waits for a separate old-gold / melt transaction — nothing is converted here.</Alert>}
            </>)}
            {dlg?.action === 'start' && (
              <SelectField label="Repair employee" value={form.repairEmployeeId ?? row?.assignedToId ?? ''} onChange={fset('repairEmployeeId')} emptyLabel="Same as assigned" options={employees.map((e) => ({ value: e.id, label: e.name }))} />
            )}
            {dlg?.action === 'complete' && (<>
              <TextField sx={{ gridColumn: '1 / -1' }} label="Work / correction details" required multiline minRows={2} value={form.details ?? ''} onChange={fset('details')} InputLabelProps={{ shrink: true }} />
              <TextField label="Repair cost (optional)" type="number" value={form.repairCost ?? ''} onChange={fset('repairCost')} InputLabelProps={{ shrink: true }} />
            </>)}
            {dlg?.action === 'final' && (
              <SelectField label="Final inspection" value={form.result ?? ''} onChange={fset('result')} options={[{ value: 'PASS', label: 'PASS — back to stock' }, { value: 'FAIL', label: 'FAIL — needs more repair' }]} />
            )}
            {dlg?.action === 'retag' && (<>
              <Alert severity="info" sx={{ gridColumn: '1 / -1' }}>Use this only when the piece's details changed and it needs a NEW Jewel Code. If only the label is damaged, use "Reprint tag" instead. Leave a field blank to keep it unchanged.</Alert>
              <TextField label="New gross weight (g)" type="number" value={form.grossWeight ?? ''} onChange={fset('grossWeight')} InputLabelProps={{ shrink: true }} />
              <TextField label="New stone weight (g)" type="number" value={form.stoneWeight ?? ''} onChange={fset('stoneWeight')} InputLabelProps={{ shrink: true }} />
              <TextField label="New net weight (g)" type="number" value={form.netWeight ?? ''} onChange={fset('netWeight')} InputLabelProps={{ shrink: true }} />
              <TextField label="New karat" value={form.metalKarat ?? ''} onChange={fset('metalKarat')} InputLabelProps={{ shrink: true }} />
              <TextField label="New selling price" type="number" value={form.sellingPrice ?? ''} onChange={fset('sellingPrice')} InputLabelProps={{ shrink: true }} />
              <TextField label="New description" value={form.name ?? ''} onChange={fset('name')} InputLabelProps={{ shrink: true }} />
              <TextField sx={{ gridColumn: '1 / -1' }} label="Reason for retagging" required value={form.reason ?? ''} onChange={fset('reason')} InputLabelProps={{ shrink: true }} />
            </>)}
            <TextField sx={{ gridColumn: '1 / -1' }} label={dlg?.action === 'final' && form.result === 'FAIL' ? 'Why did it fail?' : 'Remarks'} required={dlg?.action === 'final' && form.result === 'FAIL'}
              multiline minRows={1} value={form.remarks ?? ''} onChange={fset('remarks')} InputLabelProps={{ shrink: true }} />
          </Box>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDlg(null)}>Cancel</Button>
          <Tooltip title={canSubmit ? '' : 'Fill the required field'}>
            <span><Button variant="contained" disabled={!canSubmit || mut.isPending} onClick={() => mut.mutate()}>{mut.isPending ? 'Saving…' : 'Confirm'}</Button></span>
          </Tooltip>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
