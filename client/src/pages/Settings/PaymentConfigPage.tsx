import { useMemo, useState } from 'react';
import {
  Alert, Box, Button, Checkbox, Chip, Dialog, DialogActions, DialogContent, DialogTitle, FormControlLabel, FormGroup,
  IconButton, Stack, Tab, Tabs, TextField, Tooltip, Typography,
} from '@mui/material';
import { Add, Block, CheckCircle, Edit } from '@mui/icons-material';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSnackbar } from 'notistack';
import { apiDelete, apiGet, apiPatch, apiPost } from '../../api/client';
import { PageHeader } from '../../components/common/PageHeader';
import { DataTable } from '../../components/common/DataTable';
import { SelectField } from '../../components/fields/SelectField';
import { PermissionGate } from '../../components/auth/PermissionGate';
import { useAuthStore } from '../../store/auth.store';

// Payment Configuration: the company's banks / payment providers, which of them each branch collects through, and its
// POS terminals (TID / MID). It is selection and reconciliation data for the payment screens - it never posts money,
// and no password, PIN, card number or API secret is ever entered here. Providers and terminals that have been used
// are deactivated, not deleted; past payments keep their own copy of the details they were taken with.

const unwrap = (d: any): any[] => d?.data ?? d ?? [];
const errMsg = (e: any, fallback: string) => e?.response?.data?.error ?? fallback;

export const PROVIDER_CATEGORIES = [
  { value: 'BANK', label: 'Bank' }, { value: 'UPI_PROVIDER', label: 'UPI provider' },
  { value: 'ACQUIRER', label: 'Acquiring / card provider' }, { value: 'OTHER', label: 'Other' },
];
export const PROVIDER_METHOD_OPTIONS = [
  { value: 'CARD', label: 'Card' }, { value: 'UPI', label: 'UPI' }, { value: 'BANK_TRANSFER', label: 'Bank transfer' }, { value: 'CHEQUE', label: 'Cheque' },
];
export const TERMINAL_METHOD_OPTIONS = [{ value: 'CARD', label: 'Card' }, { value: 'UPI', label: 'UPI (QR on the machine)' }];
const methodLabel = (m: string) => PROVIDER_METHOD_OPTIONS.find((x) => x.value === m)?.label ?? m;

/** Client-side mirror of the server's rules, so an obviously incomplete form is stopped before the round trip. */
export function providerFormError(f: { name: string; category: string; supportedMethods: string[] }): string {
  if (!f.name.trim()) return 'Enter the provider name';
  if (!f.category) return 'Choose a category';
  if (f.supportedMethods.length === 0) return 'Choose at least one payment method';
  return '';
}
export function terminalFormError(f: { code: string; name: string; providerId: string; tid: string; branchId: string; supportedMethods: string[] }): string {
  if (!f.code.trim()) return 'Enter the terminal code';
  if (!f.name.trim()) return 'Enter the terminal name';
  if (!f.providerId) return 'Choose the acquiring bank / provider';
  if (!f.tid.trim()) return 'Enter the TID';
  if (!/^[A-Za-z0-9@._\-/ ]+$/.test(f.tid)) return 'TID may only contain letters, digits and . _ - / @';
  if (!f.branchId) return 'Choose the branch the terminal is at';
  if (f.supportedMethods.length === 0) return 'Choose at least one payment method';
  return '';
}

function MethodChecks({ options, value, onChange }: { options: { value: string; label: string }[]; value: string[]; onChange: (v: string[]) => void }) {
  return (
    <FormGroup row>
      {options.map((o) => (
        <FormControlLabel key={o.value} label={o.label}
          control={<Checkbox size="small" checked={value.includes(o.value)}
            onChange={(e) => onChange(e.target.checked ? [...value, o.value] : value.filter((x) => x !== o.value))} />} />
      ))}
    </FormGroup>
  );
}

// ─── Providers ───────────────────────────────────────────────────────────────

const blankProvider = () => ({ name: '', shortCode: '', category: 'BANK', supportedMethods: [] as string[], merchantRef: '' });

function ProviderDialog({ editing, onClose }: { editing: any | null; onClose: () => void }) {
  const { enqueueSnackbar } = useSnackbar();
  const qc = useQueryClient();
  const [form, setForm] = useState(editing ? { name: editing.name, shortCode: editing.shortCode ?? '', category: editing.category, supportedMethods: editing.supportedMethods as string[], merchantRef: editing.merchantRef ?? '' } : blankProvider());
  const [touched, setTouched] = useState(false);
  const error = providerFormError(form);
  const save = useMutation({
    mutationFn: () => {
      const body = { name: form.name.trim(), shortCode: form.shortCode.trim() || (editing ? null : undefined), category: form.category, supportedMethods: form.supportedMethods, merchantRef: form.merchantRef.trim() || (editing ? null : undefined) };
      return editing ? apiPatch(`/payment-config/providers/${editing.id}`, body) : apiPost('/payment-config/providers', body);
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['pc-providers'] }); enqueueSnackbar(editing ? 'Provider updated' : 'Provider added', { variant: 'success' }); onClose(); },
    onError: (e: any) => enqueueSnackbar(errMsg(e, 'Could not save the provider'), { variant: 'error' }),
  });
  const set = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }));
  return (
    <Dialog open onClose={save.isPending ? undefined : onClose} maxWidth="sm" fullWidth>
      <form noValidate onSubmit={(e) => { e.preventDefault(); setTouched(true); if (!error && !save.isPending) save.mutate(); }}>
        <DialogTitle>{editing ? 'Edit bank / provider' : 'Add bank / provider'}</DialogTitle>
        <DialogContent>
          <Stack spacing={1.75} sx={{ mt: 0.5 }}>
            <TextField size="small" autoFocus required label="Name" value={form.name} onChange={(e) => set({ name: e.target.value })} InputLabelProps={{ shrink: true }} placeholder="e.g. HDFC Bank"
              error={touched && !form.name.trim()} helperText={touched && !form.name.trim() ? 'Enter the provider name' : ' '} />
            <Stack direction="row" spacing={1.5}>
              <TextField size="small" fullWidth label="Short code (optional)" value={form.shortCode} onChange={(e) => set({ shortCode: e.target.value })} InputLabelProps={{ shrink: true }} inputProps={{ maxLength: 20 }} />
              <SelectField size="small" label="Category" value={form.category} onChange={(e) => set({ category: e.target.value })} options={PROVIDER_CATEGORIES} />
            </Stack>
            <Box>
              <Typography variant="caption" color="text.secondary">Payment methods this provider serves</Typography>
              <MethodChecks options={PROVIDER_METHOD_OPTIONS} value={form.supportedMethods} onChange={(v) => set({ supportedMethods: v })} />
              {touched && form.supportedMethods.length === 0 && <Typography variant="caption" color="error">Choose at least one payment method</Typography>}
            </Box>
            <TextField size="small" label="Merchant / VPA reference (optional)" value={form.merchantRef} onChange={(e) => set({ merchantRef: e.target.value })} InputLabelProps={{ shrink: true }}
              inputProps={{ maxLength: 80 }} helperText="A label only. Never enter passwords, PINs, API keys or account numbers." />
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={onClose} disabled={save.isPending}>Cancel</Button>
          <Button type="submit" variant="contained" disabled={save.isPending}>{save.isPending ? 'Saving…' : 'Save'}</Button>
        </DialogActions>
      </form>
    </Dialog>
  );
}

function ProvidersTab() {
  const { enqueueSnackbar } = useSnackbar();
  const qc = useQueryClient();
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [editing, setEditing] = useState<{ row: any | null } | null>(null);
  const { data, isLoading, isError } = useQuery({ queryKey: ['pc-providers'], queryFn: () => apiGet<any>('/payment-config/providers'), retry: false });
  const rows = useMemo(() => unwrap(data).filter((p) =>
    (!status || (status === 'active') === p.isActive) &&
    (!q || `${p.name} ${p.shortCode ?? ''}`.toLowerCase().includes(q.toLowerCase())),
  ), [data, q, status]);
  const toggle = useMutation({
    mutationFn: (p: any) => apiPatch(`/payment-config/providers/${p.id}`, { isActive: !p.isActive }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['pc-providers'] }); enqueueSnackbar('Updated', { variant: 'success' }); },
    onError: (e: any) => enqueueSnackbar(errMsg(e, 'Could not update'), { variant: 'error' }),
  });
  return (
    <Box>
      <Stack direction="row" spacing={1.5} alignItems="center" sx={{ mb: 1.5 }}>
        <TextField size="small" label="Search" value={q} onChange={(e) => setQ(e.target.value)} InputLabelProps={{ shrink: true }} />
        <SelectField size="small" fullWidth={false} sx={{ minWidth: 140 }} label="Status" value={status} onChange={(e) => setStatus(e.target.value)} emptyLabel="All"
          options={[{ value: 'active', label: 'Active' }, { value: 'inactive', label: 'Inactive' }]} />
        <Box sx={{ flex: 1 }} />
        <PermissionGate permission="paymentConfig:manage"><Button variant="contained" startIcon={<Add />} onClick={() => setEditing({ row: null })}>Add provider</Button></PermissionGate>
      </Stack>
      {isError && <Alert severity="error" sx={{ mb: 1 }}>Could not load providers.</Alert>}
      <DataTable tableId="pc-providers" isLoading={isLoading} rows={rows} getRowId={(r) => r.id} emptyLabel="No banks or providers yet"
        columns={[
          { key: 'name', label: 'Name', width: 200 },
          { key: 'shortCode', label: 'Code', width: 90, render: (r) => r.shortCode ?? '' },
          { key: 'category', label: 'Category', width: 160, render: (r) => PROVIDER_CATEGORIES.find((c) => c.value === r.category)?.label ?? r.category },
          { key: 'supportedMethods', label: 'Methods', width: 260, render: (r) => r.supportedMethods.map(methodLabel).join(', '), filterValue: (r) => r.supportedMethods.map(methodLabel).join(', ') },
          { key: 'isActive', label: 'Status', width: 100, render: (r) => <Chip size="small" label={r.isActive ? 'Active' : 'Inactive'} color={r.isActive ? 'success' : 'default'} />, filterValue: (r) => (r.isActive ? 'Active' : 'Inactive') },
          {
            key: 'actions', label: 'Actions', hideable: false, filterable: false, width: 110,
            render: (r) => (
              <PermissionGate permission="paymentConfig:manage">
                <Stack direction="row" spacing={0.5}>
                  <Tooltip title="Edit"><IconButton size="small" aria-label="Edit provider" onClick={() => setEditing({ row: r })}><Edit fontSize="small" /></IconButton></Tooltip>
                  <Tooltip title={r.isActive ? 'Deactivate' : 'Activate'}>
                    <IconButton size="small" aria-label={r.isActive ? 'Deactivate provider' : 'Activate provider'} onClick={() => toggle.mutate(r)}>{r.isActive ? <Block fontSize="small" /> : <CheckCircle fontSize="small" />}</IconButton>
                  </Tooltip>
                </Stack>
              </PermissionGate>
            ),
          },
        ]} />
      {editing && <ProviderDialog key={editing.row?.id ?? 'new'} editing={editing.row} onClose={() => setEditing(null)} />}
    </Box>
  );
}

// ─── Branch availability ─────────────────────────────────────────────────────

function BranchesTab({ branches }: { branches: any[] }) {
  const { enqueueSnackbar } = useSnackbar();
  const qc = useQueryClient();
  const [branchId, setBranchId] = useState('');
  const providersQ = useQuery({ queryKey: ['pc-providers'], queryFn: () => apiGet<any>('/payment-config/providers'), retry: false });
  const linksQ = useQuery({
    queryKey: ['pc-branch-providers', branchId], enabled: !!branchId, retry: false,
    queryFn: () => apiGet<any>('/payment-config/branch-providers', { branchId }),
  });
  const providers = unwrap(providersQ.data);
  const allocated = new Set(unwrap(linksQ.data).filter((l) => l.isActive).map((l) => l.providerId));
  const refresh = () => qc.invalidateQueries({ queryKey: ['pc-branch-providers', branchId] });
  const allocate = useMutation({
    mutationFn: (providerId: string) => apiPost('/payment-config/branch-providers', { branchId, providerId }),
    onSuccess: () => { refresh(); enqueueSnackbar('Provider added to branch', { variant: 'success' }); },
    onError: (e: any) => enqueueSnackbar(errMsg(e, 'Could not add the provider'), { variant: 'error' }),
  });
  const remove = useMutation({
    mutationFn: (providerId: string) => apiDelete(`/payment-config/branch-providers/${branchId}/${providerId}`),
    onSuccess: () => { refresh(); enqueueSnackbar('Provider removed from branch', { variant: 'success' }); },
    onError: (e: any) => enqueueSnackbar(errMsg(e, 'Could not remove the provider'), { variant: 'error' }),
  });
  const canManage = useAuthStore((s) => s.hasPermission)('paymentConfig:manage');
  return (
    <Box>
      <Alert severity="info" sx={{ mb: 1.5 }}>Only the providers ticked for a branch are offered when payments are taken there. Removing one never changes payments already recorded.</Alert>
      <SelectField size="small" fullWidth={false} sx={{ minWidth: 240, mb: 1.5 }} label="Branch" value={branchId} onChange={(e) => setBranchId(e.target.value)} emptyLabel="Select a branch"
        options={branches.map((b) => ({ value: b.id, label: b.name }))} />
      {!branchId && <Typography variant="body2" color="text.secondary">Choose a branch to see and change its providers.</Typography>}
      {linksQ.isError && <Alert severity="error">Could not load this branch&apos;s providers.</Alert>}
      {branchId && (linksQ.isLoading || providersQ.isLoading) && <Typography variant="body2">Loading…</Typography>}
      {branchId && !linksQ.isLoading && providers.length === 0 && <Typography variant="body2" color="text.secondary">Add banks / providers first (Providers tab).</Typography>}
      {branchId && !linksQ.isLoading && providers.length > 0 && (
        <FormGroup>
          {providers.map((p) => (
            <FormControlLabel key={p.id}
              label={<span>{p.name}{p.shortCode ? ` (${p.shortCode})` : ''} <Typography component="span" variant="caption" color="text.secondary">· {p.supportedMethods.map(methodLabel).join(', ')}{p.isActive ? '' : ' · inactive'}</Typography></span>}
              control={<Checkbox size="small" checked={allocated.has(p.id)} disabled={!canManage || allocate.isPending || remove.isPending}
                onChange={(e) => (e.target.checked ? allocate.mutate(p.id) : remove.mutate(p.id))} />} />
          ))}
        </FormGroup>
      )}
    </Box>
  );
}

// ─── POS terminals ───────────────────────────────────────────────────────────

const blankTerminal = (branchId = '') => ({ code: '', name: '', providerId: '', tid: '', mid: '', branchId, supportedMethods: ['CARD'] as string[] });

function TerminalDialog({ editing, branches, providers, onClose }: { editing: any | null; branches: any[]; providers: any[]; onClose: () => void }) {
  const { enqueueSnackbar } = useSnackbar();
  const qc = useQueryClient();
  const [form, setForm] = useState(editing
    ? { code: editing.code, name: editing.name, providerId: editing.providerId, tid: editing.tid, mid: editing.mid ?? '', branchId: editing.branchId, supportedMethods: editing.supportedMethods as string[] }
    : blankTerminal(branches.length === 1 ? branches[0].id : ''));
  const [touched, setTouched] = useState(false);
  const error = terminalFormError(form);
  const moving = !!editing && editing.branchId !== form.branchId;
  const save = useMutation({
    mutationFn: () => {
      const body = { code: form.code.trim(), name: form.name.trim(), providerId: form.providerId, tid: form.tid.trim(), mid: form.mid.trim() || (editing ? null : undefined), branchId: form.branchId, supportedMethods: form.supportedMethods };
      return editing ? apiPatch(`/payment-config/terminals/${editing.id}`, body) : apiPost('/payment-config/terminals', body);
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['pc-terminals'] }); enqueueSnackbar(editing ? 'Terminal updated' : 'Terminal added', { variant: 'success' }); onClose(); },
    onError: (e: any) => enqueueSnackbar(errMsg(e, 'Could not save the terminal'), { variant: 'error' }),
  });
  const set = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }));
  const usable = providers.filter((p) => p.isActive || p.id === editing?.providerId);
  return (
    <Dialog open onClose={save.isPending ? undefined : onClose} maxWidth="sm" fullWidth>
      <form noValidate onSubmit={(e) => { e.preventDefault(); setTouched(true); if (!error && !save.isPending) save.mutate(); }}>
        <DialogTitle>{editing ? 'Edit POS terminal' : 'Add POS terminal'}</DialogTitle>
        <DialogContent>
          <Stack spacing={1.5} sx={{ mt: 0.5 }}>
            {touched && error && <Alert severity="error">{error}</Alert>}
            <Stack direction="row" spacing={1.5}>
              <TextField size="small" autoFocus required label="Terminal code" value={form.code} onChange={(e) => set({ code: e.target.value })} InputLabelProps={{ shrink: true }} inputProps={{ maxLength: 30 }} />
              <TextField size="small" required fullWidth label="Name" value={form.name} onChange={(e) => set({ name: e.target.value })} InputLabelProps={{ shrink: true }} placeholder="e.g. Counter 1 POS" />
            </Stack>
            <SelectField size="small" required label="Acquiring bank / provider" value={form.providerId} onChange={(e) => set({ providerId: e.target.value })} emptyLabel="Select"
              options={usable.map((p) => ({ value: p.id, label: p.name }))} />
            <Stack direction="row" spacing={1.5}>
              <TextField size="small" required fullWidth label="TID" value={form.tid} onChange={(e) => set({ tid: e.target.value })} InputLabelProps={{ shrink: true }} inputProps={{ maxLength: 30 }} />
              <TextField size="small" fullWidth label="MID (optional)" value={form.mid} onChange={(e) => set({ mid: e.target.value })} InputLabelProps={{ shrink: true }} inputProps={{ maxLength: 30 }} />
            </Stack>
            <SelectField size="small" required label="Branch" value={form.branchId} onChange={(e) => set({ branchId: e.target.value })} emptyLabel="Select branch"
              options={branches.map((b) => ({ value: b.id, label: b.name }))} />
            {moving && <Alert severity="warning">Moving this terminal to another branch does not change payments already taken on it.</Alert>}
            <Box>
              <Typography variant="caption" color="text.secondary">Payment methods this machine takes</Typography>
              <MethodChecks options={TERMINAL_METHOD_OPTIONS} value={form.supportedMethods} onChange={(v) => set({ supportedMethods: v })} />
            </Box>
            <Typography variant="caption" color="text.secondary">The TID must be unique for this provider and MID. Do not enter any password or PIN.</Typography>
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={onClose} disabled={save.isPending}>Cancel</Button>
          <Button type="submit" variant="contained" disabled={save.isPending}>{save.isPending ? 'Saving…' : 'Save'}</Button>
        </DialogActions>
      </form>
    </Dialog>
  );
}

function TerminalsTab({ branches }: { branches: any[] }) {
  const { enqueueSnackbar } = useSnackbar();
  const qc = useQueryClient();
  const [branchId, setBranchId] = useState('');
  const [status, setStatus] = useState('');
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState<{ row: any | null } | null>(null);
  const providersQ = useQuery({ queryKey: ['pc-providers'], queryFn: () => apiGet<any>('/payment-config/providers'), retry: false });
  const { data, isLoading, isError } = useQuery({ queryKey: ['pc-terminals'], queryFn: () => apiGet<any>('/payment-config/terminals'), retry: false });
  const rows = useMemo(() => unwrap(data).filter((t) =>
    (!branchId || t.branchId === branchId) && (!status || (status === 'active') === t.isActive) &&
    (!q || `${t.code} ${t.name} ${t.tid}`.toLowerCase().includes(q.toLowerCase())),
  ), [data, branchId, status, q]);
  const toggle = useMutation({
    mutationFn: (t: any) => apiPatch(`/payment-config/terminals/${t.id}`, { isActive: !t.isActive }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['pc-terminals'] }); enqueueSnackbar('Updated', { variant: 'success' }); },
    onError: (e: any) => enqueueSnackbar(errMsg(e, 'Could not update'), { variant: 'error' }),
  });
  return (
    <Box>
      <Stack direction="row" spacing={1.5} alignItems="center" sx={{ mb: 1.5 }}>
        <TextField size="small" label="Search code / name / TID" value={q} onChange={(e) => setQ(e.target.value)} InputLabelProps={{ shrink: true }} />
        <SelectField size="small" fullWidth={false} sx={{ minWidth: 180 }} label="Branch" value={branchId} onChange={(e) => setBranchId(e.target.value)} emptyLabel="All branches"
          options={branches.map((b) => ({ value: b.id, label: b.name }))} />
        <SelectField size="small" fullWidth={false} sx={{ minWidth: 130 }} label="Status" value={status} onChange={(e) => setStatus(e.target.value)} emptyLabel="All"
          options={[{ value: 'active', label: 'Active' }, { value: 'inactive', label: 'Inactive' }]} />
        <Box sx={{ flex: 1 }} />
        <PermissionGate permission="paymentConfig:manage"><Button variant="contained" startIcon={<Add />} onClick={() => setEditing({ row: null })}>Add terminal</Button></PermissionGate>
      </Stack>
      {isError && <Alert severity="error" sx={{ mb: 1 }}>Could not load terminals.</Alert>}
      <DataTable tableId="pc-terminals" isLoading={isLoading} rows={rows} getRowId={(r) => r.id} emptyLabel="No POS terminals yet"
        columns={[
          { key: 'code', label: 'Code', width: 100 },
          { key: 'name', label: 'Name', width: 170 },
          { key: 'provider', label: 'Provider', width: 160, render: (r) => r.provider?.name ?? '', filterValue: (r) => r.provider?.name ?? '' },
          { key: 'tid', label: 'TID', width: 130 },
          { key: 'mid', label: 'MID', width: 130, render: (r) => r.mid ?? '' },
          { key: 'branch', label: 'Branch', width: 150, render: (r) => r.branch?.name ?? '', filterValue: (r) => r.branch?.name ?? '' },
          { key: 'supportedMethods', label: 'Methods', width: 110, render: (r) => r.supportedMethods.map(methodLabel).join(', '), filterValue: (r) => r.supportedMethods.map(methodLabel).join(', ') },
          { key: 'isActive', label: 'Status', width: 100, render: (r) => <Chip size="small" label={r.isActive ? 'Active' : 'Inactive'} color={r.isActive ? 'success' : 'default'} />, filterValue: (r) => (r.isActive ? 'Active' : 'Inactive') },
          {
            key: 'actions', label: 'Actions', hideable: false, filterable: false, width: 110,
            render: (r) => (
              <PermissionGate permission="paymentConfig:manage">
                <Stack direction="row" spacing={0.5}>
                  <Tooltip title="Edit / reassign"><IconButton size="small" aria-label="Edit terminal" onClick={() => setEditing({ row: r })}><Edit fontSize="small" /></IconButton></Tooltip>
                  <Tooltip title={r.isActive ? 'Deactivate' : 'Activate'}>
                    <IconButton size="small" aria-label={r.isActive ? 'Deactivate terminal' : 'Activate terminal'} onClick={() => toggle.mutate(r)}>{r.isActive ? <Block fontSize="small" /> : <CheckCircle fontSize="small" />}</IconButton>
                  </Tooltip>
                </Stack>
              </PermissionGate>
            ),
          },
        ]} />
      {editing && <TerminalDialog key={editing.row?.id ?? 'new'} editing={editing.row} branches={branches} providers={unwrap(providersQ.data)} onClose={() => setEditing(null)} />}
    </Box>
  );
}

// ─── Page ────────────────────────────────────────────────────────────────────

export function PaymentConfigPage() {
  const [tab, setTab] = useState(0);
  const branchesQ = useQuery({ queryKey: ['branches'], queryFn: () => apiGet<any>('/tagging/branches'), retry: false });
  const branches = unwrap(branchesQ.data);
  return (
    <Box>
      <PageHeader title="Payment Providers & POS Terminals"
        subtitle="Banks and providers, which branch collects through which, and the card machines (TID / MID). Used to fill in payment details — it does not post any money."
        actions={[]} />
      {branchesQ.isError && <Alert severity="warning" sx={{ mb: 1 }}>Could not load branches.</Alert>}
      <Tabs value={tab} onChange={(_, v) => setTab(v)} sx={{ mb: 2 }}>
        <Tab label="Banks / providers" /><Tab label="Branch availability" /><Tab label="POS terminals" />
      </Tabs>
      {tab === 0 && <ProvidersTab />}
      {tab === 1 && <BranchesTab branches={branches} />}
      {tab === 2 && <TerminalsTab branches={branches} />}
    </Box>
  );
}
