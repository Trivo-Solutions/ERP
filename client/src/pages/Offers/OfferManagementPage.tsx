import { useMemo, useState } from 'react';
import {
  Box, Button, Chip, Dialog, DialogActions, DialogContent, DialogTitle, IconButton, Stack, TextField,
  Tooltip, Typography, Alert, Table, TableBody, TableCell, TableHead, TableRow,
} from '@mui/material';
import { Add, Delete as DeleteIcon, Edit, Block, CheckCircle } from '@mui/icons-material';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSnackbar } from 'notistack';
import { apiDelete, apiGet, apiPost, apiPut } from '../../api/client';
import { PageHeader } from '../../components/common/PageHeader';
import { DataTable } from '../../components/common/DataTable';
import { DateField } from '../../components/fields/DateField';
import { NumberField } from '../../components/fields/NumberField';
import { SelectField } from '../../components/fields/SelectField';
import { PermissionGate } from '../../components/auth/PermissionGate';

// Offer Management (step 1): define dated offers on the SALE rates — making charge, VA, stone and metal. Nothing here
// changes a tag; estimates and bills pick offers up automatically by date (step 2). An offer is edited as a unit: its
// header plus a flat list of rules, one rule per line, each narrowing by stone type / category / karat if wanted.
// One offer wins per piece (no stacking): highest priority, then newest.

type Component = 'MAKING_CHARGE' | 'VA' | 'STONE' | 'METAL';
type Mode = 'PERCENT_OFF' | 'FIXED_RATE';

interface RuleRow { key: string; component: Component; mode: Mode; value: string; stoneTypeId: string; categoryId: string; karat: string }
interface OfferForm {
  name: string; description: string; effectiveFrom: string; effectiveTo: string; priority: string; branchId: string; isActive: boolean;
  rules: RuleRow[];
}

const COMPONENT_LABEL: Record<Component, string> = { MAKING_CHARGE: 'Making charge', VA: 'VA / wastage', STONE: 'Stone', METAL: 'Metal rate' };
const MODE_LABEL: Record<Mode, string> = { PERCENT_OFF: '% off', FIXED_RATE: 'Fixed rate' };
const STATUS_COLOR: Record<string, 'success' | 'info' | 'default' | 'warning'> = { ACTIVE: 'success', UPCOMING: 'info', EXPIRED: 'default', INACTIVE: 'warning' };

// What the value means: a % off is always a percentage; a fixed rate is in the component's own unit.
const FIXED_UNIT: Record<Component, string> = { MAKING_CHARGE: '₹/g', VA: '%', STONE: '₹/ct', METAL: '₹/g' };
const valueUnit = (c: Component, m: Mode) => (m === 'PERCENT_OFF' ? '%' : FIXED_UNIT[c]);

const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
let keySeq = 0;
const newKey = () => `r${++keySeq}`;
const blankRule = (over: Partial<RuleRow> = {}): RuleRow => ({ key: newKey(), component: 'MAKING_CHARGE', mode: 'PERCENT_OFF', value: '', stoneTypeId: '', categoryId: '', karat: '', ...over });
const blankForm = (): OfferForm => ({ name: '', description: '', effectiveFrom: today(), effectiveTo: '', priority: '0', branchId: '', isActive: true, rules: [blankRule()] });

const fromOffer = (o: any): OfferForm => ({
  name: o.name, description: o.description ?? '', effectiveFrom: o.effectiveFrom, effectiveTo: o.effectiveTo ?? '',
  priority: String(o.priority), branchId: o.branchId ?? '', isActive: o.isActive,
  rules: o.rules.map((r: any) => ({
    key: newKey(), component: r.component, mode: r.mode, value: String(r.value),
    stoneTypeId: r.stoneTypeId ?? '', categoryId: r.categoryId ?? '', karat: r.karat ?? '',
  })),
});

const unwrap = (d: any): any[] => d?.data ?? d ?? [];
const useLookup = (key: string, url: string) => useQuery({ queryKey: [key], queryFn: () => apiGet<any>(url), retry: false });

function ruleSummary(r: any): string {
  const what = r.component === 'STONE' ? (r.stoneType?.name ?? 'All stones') : COMPONENT_LABEL[r.component as Component];
  const amt = r.mode === 'PERCENT_OFF' ? `${r.value}% off` : `fixed ${r.value} ${FIXED_UNIT[r.component as Component]}`;
  const narrow = [r.category?.name, r.karat].filter(Boolean).join(' · ');
  return `${what}: ${amt}${narrow ? ` (${narrow})` : ''}`;
}

export function OfferManagementPage() {
  const { enqueueSnackbar } = useSnackbar();
  const qc = useQueryClient();
  const [statusFilter, setStatusFilter] = useState('ALL');
  const [editing, setEditing] = useState<{ id: string | null; form: OfferForm } | null>(null);
  const [toDelete, setToDelete] = useState<any>(null);

  const { data, isLoading } = useQuery({ queryKey: ['offers'], queryFn: () => apiGet<any>('/offers') });
  const offers = useMemo(() => unwrap(data), [data]);
  const shown = statusFilter === 'ALL' ? offers : offers.filter((o) => o.status === statusFilter);

  const invalidate = () => qc.invalidateQueries({ queryKey: ['offers'] });
  const fail = (e: any) => enqueueSnackbar(e.response?.data?.error ?? 'Failed', { variant: 'error' });

  const toggle = useMutation({
    mutationFn: (o: any) => apiPost(`/offers/${o.id}/${o.isActive ? 'deactivate' : 'activate'}`),
    onSuccess: () => { invalidate(); enqueueSnackbar('Updated', { variant: 'success' }); },
    onError: fail,
  });
  const remove = useMutation({
    mutationFn: (o: any) => apiDelete(`/offers/${o.id}`),
    onSuccess: () => { invalidate(); setToDelete(null); enqueueSnackbar('Offer deleted', { variant: 'success' }); },
    onError: (e: any) => { setToDelete(null); fail(e); },
  });

  return (
    <Box>
      <PageHeader
        title="Offer Management"
        subtitle="Dated offers on making charge, VA, stone and metal sale rates. The tag is never changed — when the dates end, the tagged price is the price again."
        actions={[]}
      />

      <Stack direction="row" spacing={1.5} alignItems="center" sx={{ mb: 1.5 }}>
        <SelectField size="small" fullWidth={false} sx={{ minWidth: 170 }} label="Show" value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          options={[{ value: 'ALL', label: 'All offers' }, { value: 'ACTIVE', label: 'Active now' }, { value: 'UPCOMING', label: 'Upcoming' }, { value: 'EXPIRED', label: 'Expired' }, { value: 'INACTIVE', label: 'Switched off' }]} />
        <Box sx={{ flex: 1 }} />
        <PermissionGate permission="offer:create">
          <Button variant="contained" startIcon={<Add />} onClick={() => setEditing({ id: null, form: blankForm() })}>New offer</Button>
        </PermissionGate>
      </Stack>

      <DataTable
        tableId="offers-list"
        isLoading={isLoading}
        rows={shown}
        getRowId={(r) => r.id}
        emptyLabel="No offers yet"
        columns={[
          { key: 'name', label: 'Offer', width: 200 },
          { key: 'status', label: 'Status', width: 110, render: (r) => <Chip size="small" label={r.status === 'INACTIVE' ? 'Switched off' : r.status[0] + r.status.slice(1).toLowerCase()} color={STATUS_COLOR[r.status]} /> },
          { key: 'effectiveFrom', label: 'From', width: 110 },
          { key: 'effectiveTo', label: 'To', width: 110, render: (r) => r.effectiveTo ?? 'Open-ended', filterValue: (r) => r.effectiveTo ?? 'Open-ended' },
          { key: 'priority', label: 'Priority', align: 'right', width: 80 },
          { key: 'branch', label: 'Branch', width: 130, render: (r) => r.branch?.name ?? 'All branches', filterValue: (r) => r.branch?.name ?? 'All branches' },
          {
            key: 'rules', label: 'What it does', width: 380, filterable: false,
            render: (r) => (
              <Box>{r.rules.map((x: any) => <Typography key={x.id} variant="body2" sx={{ whiteSpace: 'nowrap' }}>{ruleSummary(x)}</Typography>)}</Box>
            ),
          },
          {
            key: 'actions', label: 'Actions', hideable: false, filterable: false, width: 140,
            render: (r) => (
              <Stack direction="row" spacing={0.5}>
                <PermissionGate permission="offer:edit">
                  <Tooltip title="Edit"><IconButton size="small" onClick={() => setEditing({ id: r.id, form: fromOffer(r) })}><Edit fontSize="small" /></IconButton></Tooltip>
                  <Tooltip title={r.isActive ? 'Switch off' : 'Switch on'}>
                    <IconButton size="small" onClick={() => toggle.mutate(r)}>{r.isActive ? <Block fontSize="small" /> : <CheckCircle fontSize="small" />}</IconButton>
                  </Tooltip>
                </PermissionGate>
                <PermissionGate permission="offer:delete">
                  <Tooltip title="Delete"><IconButton size="small" onClick={() => setToDelete(r)}><DeleteIcon fontSize="small" /></IconButton></Tooltip>
                </PermissionGate>
              </Stack>
            ),
          },
        ]}
      />

      {editing && (
        <OfferDialog
          key={editing.id ?? 'new'}
          offerId={editing.id}
          initial={editing.form}
          onClose={() => setEditing(null)}
          onSaved={() => { invalidate(); setEditing(null); }}
        />
      )}

      <Dialog open={!!toDelete} onClose={() => setToDelete(null)}>
        <DialogTitle>Delete offer?</DialogTitle>
        <DialogContent>
          <Typography>
            “{toDelete?.name}” will be removed permanently. If it has already been used on an estimate or bill it cannot be deleted —
            switch it off instead.
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setToDelete(null)}>Cancel</Button>
          <Button color="error" variant="contained" disabled={remove.isPending} onClick={() => remove.mutate(toDelete)}>Delete</Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}

function OfferDialog({ offerId, initial, onClose, onSaved }: {
  offerId: string | null; initial: OfferForm; onClose: () => void; onSaved: () => void;
}) {
  const { enqueueSnackbar } = useSnackbar();
  const [form, setForm] = useState<OfferForm>(initial);
  const [error, setError] = useState('');
  const set = <K extends keyof OfferForm>(k: K, v: OfferForm[K]) => setForm((f) => ({ ...f, [k]: v }));
  const setRule = (key: string, patch: Partial<RuleRow>) => setForm((f) => ({ ...f, rules: f.rules.map((r) => (r.key === key ? { ...r, ...patch } : r)) }));
  // A fresh form opens with one empty placeholder rule; the first shortcut button replaces it instead of stacking under it.
  const isPlaceholder = (r: RuleRow) => r.value === '' && !r.stoneTypeId && !r.categoryId && !r.karat;
  const addRules = (...rs: RuleRow[]) => setForm((f) => ({ ...f, rules: [...(f.rules.length === 1 && isPlaceholder(f.rules[0]) ? [] : f.rules), ...rs] }));

  const stoneTypes = unwrap(useLookup('master-stone-types', '/masters/stone-types').data);
  const categories = unwrap(useLookup('master-categories', '/masters/categories').data);
  const karats = unwrap(useLookup('karats', '/masters/karats').data);
  const branches = unwrap(useLookup('branches', '/tagging/branches').data);

  const save = useMutation({
    mutationFn: () => {
      const body = {
        name: form.name, description: form.description || null, effectiveFrom: form.effectiveFrom, effectiveTo: form.effectiveTo || null,
        priority: Number(form.priority || 0), branchId: form.branchId || null, isActive: form.isActive,
        rules: form.rules.map((r) => ({
          component: r.component, mode: r.mode, value: r.value === '' ? NaN : Number(r.value),
          stoneTypeId: r.component === 'STONE' ? r.stoneTypeId || null : null, categoryId: r.categoryId || null, karat: r.karat || null,
        })),
      };
      return offerId ? apiPut(`/offers/${offerId}`, body) : apiPost('/offers', body);
    },
    onSuccess: () => { enqueueSnackbar(offerId ? 'Offer updated' : 'Offer created', { variant: 'success' }); onSaved(); },
    onError: (e: any) => setError(e.response?.data?.error ?? 'Could not save the offer'),
  });

  const submit = () => {
    setError('');
    if (!form.name.trim()) return setError('Give the offer a name');
    if (!form.effectiveFrom) return setError('Pick the date the offer starts');
    if (form.effectiveTo && form.effectiveTo < form.effectiveFrom) return setError('The end date is before the start date');
    if (form.rules.length === 0) return setError('Add at least one rule');
    const bad = form.rules.findIndex((r) => r.value === '' || !Number.isFinite(Number(r.value)) || Number(r.value) < 0 || (r.mode === 'PERCENT_OFF' && Number(r.value) > 100));
    if (bad >= 0) return setError(`Rule ${bad + 1}: enter a value (a % off can be at most 100)`);
    save.mutate();
  };

  // One stone row per stone type that does not have an unnarrowed STONE rule yet — the "enter every stone type at once" shortcut.
  const addEveryStone = () => {
    const have = new Set(form.rules.filter((r) => r.component === 'STONE' && !r.categoryId && !r.karat).map((r) => r.stoneTypeId));
    const missing = stoneTypes.filter((s: any) => !have.has(s.id));
    if (missing.length === 0) return enqueueSnackbar('Every stone type already has a rule', { variant: 'info' });
    addRules(...missing.map((s: any) => blankRule({ component: 'STONE', stoneTypeId: s.id })));
  };

  return (
    <Dialog open onClose={onClose} fullWidth maxWidth="lg">
      <DialogTitle>{offerId ? 'Edit offer' : 'New offer'}</DialogTitle>
      <DialogContent dividers>
        <Stack spacing={2}>
          {error && <Alert severity="error">{error}</Alert>}
          <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 1.5 }}>
            <TextField size="small" label="Offer name *" autoFocus value={form.name} onChange={(e) => set('name', e.target.value)} sx={{ gridColumn: 'span 2' }} />
            <DateField size="small" label="From *" value={form.effectiveFrom} onChange={(e) => set('effectiveFrom', e.target.value)} />
            <DateField size="small" label="To (blank = open-ended)" value={form.effectiveTo} onChange={(e) => set('effectiveTo', e.target.value)} />
            <NumberField size="small" label="Priority" value={form.priority} onChange={(e) => set('priority', e.target.value)}
              helperText="Higher wins if two offers overlap" />
            <SelectField size="small" label="Branch" value={form.branchId} onChange={(e) => set('branchId', e.target.value)} emptyLabel="All branches"
              options={branches.map((b: any) => ({ value: b.id, label: b.name }))} />
            <TextField size="small" label="Notes" value={form.description} onChange={(e) => set('description', e.target.value)} sx={{ gridColumn: '1 / -1' }} />
          </Box>

          <Alert severity="info" sx={{ py: 0 }}>
            One offer applies to a piece — offers are never added together. A fixed rate only applies where it is lower than the tagged
            rate. A rule that names a stone type, category or karat beats a general one.
          </Alert>

          <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
            <Button size="small" variant="outlined" onClick={() => addRules(blankRule({ component: 'MAKING_CHARGE' }))}>+ Making charge</Button>
            <Button size="small" variant="outlined" onClick={() => addRules(blankRule({ component: 'VA' }))}>+ VA</Button>
            <Button size="small" variant="outlined" onClick={() => addRules(blankRule({ component: 'STONE' }))}>+ Stone</Button>
            <Button size="small" variant="outlined" onClick={() => addRules(blankRule({ component: 'METAL' }))}>+ Metal rate</Button>
            <Button size="small" variant="outlined" onClick={addEveryStone}>+ Every stone type</Button>
          </Stack>

          <Box sx={{ overflowX: 'auto' }}>
            <Table size="small" sx={{ '& td, & th': { border: '1px solid', borderColor: 'divider', p: 0.5 } }}>
              <TableHead>
                <TableRow>
                  <TableCell>#</TableCell><TableCell>On</TableCell><TableCell>Stone type</TableCell><TableCell>Category</TableCell>
                  <TableCell>Karat</TableCell><TableCell>Offer</TableCell><TableCell>Value</TableCell><TableCell />
                </TableRow>
              </TableHead>
              <TableBody>
                {form.rules.map((r, i) => (
                  <TableRow key={r.key}>
                    <TableCell>{i + 1}</TableCell>
                    <TableCell sx={{ minWidth: 150 }}>
                      <SelectField size="small" value={r.component} onChange={(e) => setRule(r.key, { component: e.target.value as Component, stoneTypeId: '' })}
                        options={(Object.keys(COMPONENT_LABEL) as Component[]).map((c) => ({ value: c, label: COMPONENT_LABEL[c] }))} />
                    </TableCell>
                    <TableCell sx={{ minWidth: 150 }}>
                      {r.component === 'STONE'
                        ? <SelectField size="small" value={r.stoneTypeId} onChange={(e) => setRule(r.key, { stoneTypeId: e.target.value })} emptyLabel="All stones"
                            options={stoneTypes.map((s: any) => ({ value: s.id, label: s.name }))} />
                        : <Typography variant="body2" color="text.disabled" sx={{ px: 1 }}>—</Typography>}
                    </TableCell>
                    <TableCell sx={{ minWidth: 140 }}>
                      <SelectField size="small" value={r.categoryId} onChange={(e) => setRule(r.key, { categoryId: e.target.value })} emptyLabel="Any"
                        options={categories.map((c: any) => ({ value: c.id, label: c.name }))} />
                    </TableCell>
                    <TableCell sx={{ minWidth: 100 }}>
                      <SelectField size="small" value={r.karat} onChange={(e) => setRule(r.key, { karat: e.target.value })} emptyLabel="Any"
                        options={karats.map((k: any) => ({ value: k.code, label: k.code }))} />
                    </TableCell>
                    <TableCell sx={{ minWidth: 120 }}>
                      <SelectField size="small" value={r.mode} onChange={(e) => setRule(r.key, { mode: e.target.value as Mode })}
                        options={(Object.keys(MODE_LABEL) as Mode[]).map((m) => ({ value: m, label: MODE_LABEL[m] }))} />
                    </TableCell>
                    <TableCell sx={{ minWidth: 120 }}>
                      <NumberField size="small" value={r.value} onChange={(e) => setRule(r.key, { value: e.target.value })}
                        InputProps={{ endAdornment: <Typography variant="caption" sx={{ ml: 0.5, whiteSpace: 'nowrap' }}>{valueUnit(r.component, r.mode)}</Typography> }} />
                    </TableCell>
                    <TableCell>
                      <IconButton size="small" aria-label="Remove rule" onClick={() => setForm((f) => ({ ...f, rules: f.rules.filter((x) => x.key !== r.key) }))}><DeleteIcon fontSize="small" /></IconButton>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Box>
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="contained" onClick={submit} disabled={save.isPending}>{offerId ? 'Save changes' : 'Create offer'}</Button>
      </DialogActions>
    </Dialog>
  );
}
