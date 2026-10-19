import { useState } from 'react';
import {
  Alert, Box, Button, Card, Checkbox, Chip, Dialog, DialogActions, DialogContent, DialogTitle, FormControlLabel,
  FormGroup, Grid, IconButton, InputAdornment, Switch, Table, TableBody, TableCell, TableHead, TableRow, TextField,
  Tooltip, Typography,
} from '@mui/material';
import { Add, ContentCopy, Edit, LockReset, PersonAdd, PersonRemove } from '@mui/icons-material';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSnackbar } from 'notistack';
import { apiGet, apiPatch, apiPost } from '../../api/client';
import { PageHeader } from '../../components/common/PageHeader';
import { SelectField } from '../../components/fields/SelectField';
import { PermissionGate } from '../../components/auth/PermissionGate';
import type { RoleRow } from './RoleEditorPage';

interface Branch { id: string; name: string }
export interface SalesEmployee {
  id: string; userId: string; employeeId: string | null; name: string; email: string; phone: string | null;
  designation: string | null; isActive: boolean; allBranches: boolean; branches: Branch[];
  role: { id: string; name: string; displayName: string };
  accountStatus: 'ACTIVE' | 'PASSWORD_CHANGE_PENDING' | 'DISABLED'; lastLoginAt: string | null;
}
interface FormState {
  name: string; email: string; employeeId: string; phone: string; designation: string; roleId: string;
  allBranches: boolean; branchIds: string[]; isActive: boolean;
}
const EMPTY: FormState = { name: '', email: '', employeeId: '', phone: '', designation: '', roleId: '', allBranches: false, branchIds: [], isActive: true };
const STATUS_LABEL = { ACTIVE: 'Active', PASSWORD_CHANGE_PENDING: 'Awaiting first sign-in', DISABLED: 'Disabled' } as const;
const STATUS_COLOR = { ACTIVE: 'success', PASSWORD_CHANGE_PENDING: 'warning', DISABLED: 'default' } as const;

const errorOf = (e: any, fallback: string) => e?.response?.data?.error ?? fallback;

/** Client-side mirror of the server rules, so an obviously bad form is stopped before the round trip. */
export function employeeFormErrors(f: FormState, creating: boolean): Partial<Record<keyof FormState, string>> {
  const e: Partial<Record<keyof FormState, string>> = {};
  if (f.name.trim().length < 2) e.name = 'Enter the full name';
  if (creating && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(f.email.trim())) e.email = 'Enter a valid email';
  if (!f.roleId) e.roleId = 'Select a role';
  if (!f.allBranches && f.branchIds.length === 0) e.branchIds = 'Select at least one branch, or All branches';
  return e;
}

// Shown once after create / password issue. The server never returns it again.
function PasswordDialog({ result, onClose }: { result: { name: string; email: string; password: string } | null; onClose: () => void }) {
  const { enqueueSnackbar } = useSnackbar();
  if (!result) return null;
  return (
    <Dialog open maxWidth="sm" fullWidth>
      <DialogTitle fontWeight={700}>Temporary password</DialogTitle>
      <DialogContent>
        <Alert severity="warning" sx={{ mb: 2 }}>
          Give this to <strong>{result.name}</strong> ({result.email}) now - it is shown only once and cannot be looked up later.
          They will be asked to choose their own password at first sign-in.
        </Alert>
        <TextField fullWidth value={result.password} InputProps={{
          readOnly: true, sx: { fontFamily: 'monospace' },
          endAdornment: (
            <InputAdornment position="end">
              <Tooltip title="Copy"><IconButton size="small" onClick={() => { navigator.clipboard.writeText(result.password); enqueueSnackbar('Copied', { variant: 'success' }); }}><ContentCopy fontSize="small" /></IconButton></Tooltip>
            </InputAdornment>
          ),
        }} />
      </DialogContent>
      <DialogActions sx={{ p: 2.5 }}><Button variant="contained" onClick={onClose}>Done</Button></DialogActions>
    </Dialog>
  );
}

function EmployeeDialog({ employee, creating, roles, branches, onClose, onCreated }: {
  employee?: SalesEmployee; creating: boolean; roles: RoleRow[]; branches: Branch[];
  onClose: () => void; onCreated: (r: { name: string; email: string; password: string }) => void;
}) {
  const { enqueueSnackbar } = useSnackbar();
  const qc = useQueryClient();
  const [f, setF] = useState<FormState>(employee ? {
    name: employee.name, email: employee.email, employeeId: employee.employeeId ?? '', phone: employee.phone ?? '',
    designation: employee.designation ?? '', roleId: employee.role.id, allBranches: employee.allBranches,
    branchIds: employee.branches.map((b) => b.id), isActive: employee.isActive,
  } : EMPTY);
  const [touched, setTouched] = useState(false);
  const errors = employeeFormErrors(f, creating);
  const set = (p: Partial<FormState>) => setF((x) => ({ ...x, ...p }));

  const save = useMutation({
    mutationFn: async () => {
      const common = {
        name: f.name.trim(), employeeId: f.employeeId.trim() || null, phone: f.phone.trim() || null,
        designation: f.designation.trim() || null, roleId: f.roleId, allBranches: f.allBranches,
        branchIds: f.allBranches ? [] : f.branchIds,
      };
      if (creating) return apiPost<{ employee: SalesEmployee; temporaryPassword: string }>('/sales-employees', { ...common, email: f.email.trim() });
      return apiPatch<SalesEmployee>(`/sales-employees/${employee!.id}`, { ...common, isActive: f.isActive });
    },
    onSuccess: (res: any) => {
      qc.invalidateQueries({ queryKey: ['sales-employees'] });
      qc.invalidateQueries({ queryKey: ['sales-staff'] });
      enqueueSnackbar(creating ? 'Sales employee created' : 'Sales employee updated', { variant: 'success' });
      if (creating) onCreated({ name: res.employee.name, email: res.employee.email, password: res.temporaryPassword });
      onClose();
    },
    onError: (e) => enqueueSnackbar(errorOf(e, 'Could not save'), { variant: 'error' }),
  });

  return (
    <Dialog open onClose={onClose} maxWidth="sm" fullWidth>
      <form onSubmit={(e) => { e.preventDefault(); setTouched(true); if (Object.keys(errors).length === 0) save.mutate(); }} noValidate>
        <DialogTitle fontWeight={700}>{creating ? 'New Sales Employee' : `Edit ${employee!.name}`}</DialogTitle>
        <DialogContent sx={{ pt: 2 }}>
          <Grid container spacing={2} sx={{ mt: 0 }}>
            <Grid item xs={12} sm={6}>
              <TextField fullWidth size="small" required autoFocus label="Full name" value={f.name} onChange={(e) => set({ name: e.target.value })}
                error={touched && !!errors.name} helperText={touched ? errors.name : undefined} />
            </Grid>
            <Grid item xs={12} sm={6}>
              <TextField fullWidth size="small" label="Employee code" value={f.employeeId} onChange={(e) => set({ employeeId: e.target.value })} />
            </Grid>
            <Grid item xs={12} sm={6}>
              <TextField fullWidth size="small" required={creating} disabled={!creating} type="email" label="Email (sign-in)" value={f.email}
                onChange={(e) => set({ email: e.target.value })} error={touched && !!errors.email} helperText={touched ? errors.email : undefined} />
            </Grid>
            <Grid item xs={12} sm={6}>
              <TextField fullWidth size="small" label="Mobile" value={f.phone} onChange={(e) => set({ phone: e.target.value })} />
            </Grid>
            <Grid item xs={12} sm={6}>
              <TextField fullWidth size="small" label="Designation" value={f.designation} onChange={(e) => set({ designation: e.target.value })} />
            </Grid>
            <Grid item xs={12} sm={6}>
              <SelectField size="small" required label="Role" emptyLabel="Select a role" value={f.roleId} onChange={(e: any) => set({ roleId: e.target.value })}
                options={roles.map((r) => ({ value: r.id, label: r.displayName }))} error={touched && !!errors.roleId} helperText={touched ? errors.roleId : undefined} />
            </Grid>
            <Grid item xs={12}>
              <FormControlLabel control={<Switch checked={f.allBranches} onChange={(e) => set({ allBranches: e.target.checked })} />} label="All branches" />
              {!f.allBranches && (
                <FormGroup sx={{ ml: 1, maxHeight: 160, overflowY: 'auto', border: '1px solid', borderColor: touched && errors.branchIds ? 'error.main' : 'divider', borderRadius: 1, p: 1 }}>
                  {branches.map((b) => (
                    <FormControlLabel key={b.id} label={b.name} control={<Checkbox size="small" checked={f.branchIds.includes(b.id)}
                      onChange={() => set({ branchIds: f.branchIds.includes(b.id) ? f.branchIds.filter((x) => x !== b.id) : [...f.branchIds, b.id] })} />} />
                  ))}
                </FormGroup>
              )}
              {touched && errors.branchIds && <Typography variant="caption" color="error">{errors.branchIds}</Typography>}
            </Grid>
            {!creating && (
              <Grid item xs={12}>
                <FormControlLabel control={<Switch checked={f.isActive} onChange={(e) => set({ isActive: e.target.checked })} />} label="Active (can be chosen on new bills)" />
              </Grid>
            )}
            {creating && (
              <Grid item xs={12}>
                <Alert severity="info">A temporary password is generated for the new login and shown once after saving. They must change it at first sign-in.</Alert>
              </Grid>
            )}
          </Grid>
        </DialogContent>
        <DialogActions sx={{ p: 2.5 }}>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="contained" disabled={save.isPending}>{creating ? 'Create' : 'Save'}</Button>
        </DialogActions>
      </form>
    </Dialog>
  );
}

interface Markable { id: string; name: string; email: string; employeeId: string | null; role: string }

// Marks someone who is ALREADY a member of this company - no new login is created and nothing about their account changes.
function ExistingMemberDialog({ onClose }: { onClose: () => void }) {
  const { enqueueSnackbar } = useSnackbar();
  const qc = useQueryClient();
  const [memberId, setMemberId] = useState('');
  const [designation, setDesignation] = useState('');
  const { data: members } = useQuery({ queryKey: ['sales-employee-members'], queryFn: () => apiGet<Markable[]>('/sales-employees/members') });
  const mark = useMutation({
    mutationFn: () => apiPost('/sales-employees/existing', { companyUserId: memberId, designation: designation.trim() || null }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['sales-employees'] }); qc.invalidateQueries({ queryKey: ['sales-employee-members'] });
      enqueueSnackbar('Added to sales employees', { variant: 'success' }); onClose();
    },
    onError: (e) => enqueueSnackbar(errorOf(e, 'Could not add this member'), { variant: 'error' }),
  });
  return (
    <Dialog open onClose={onClose} maxWidth="xs" fullWidth>
      <form onSubmit={(e) => { e.preventDefault(); if (memberId) mark.mutate(); }}>
        <DialogTitle fontWeight={700}>Add existing member</DialogTitle>
        <DialogContent sx={{ pt: 2 }}>
          <Alert severity="info" sx={{ mb: 2 }}>The person keeps their current login, role and branches. Only the sales-employee designation is added.</Alert>
          <SelectField size="small" required autoFocus label="Member" emptyLabel="Select a member" value={memberId} onChange={(e: any) => setMemberId(e.target.value)}
            options={(members ?? []).map((m) => ({ value: m.id, label: `${m.name} (${m.email})` }))} />
          <TextField sx={{ mt: 2 }} fullWidth size="small" label="Designation" value={designation} onChange={(e) => setDesignation(e.target.value)} />
        </DialogContent>
        <DialogActions sx={{ p: 2.5 }}>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="contained" disabled={!memberId || mark.isPending}>Add</Button>
        </DialogActions>
      </form>
    </Dialog>
  );
}

export function SalesEmployeesPage() {
  const { enqueueSnackbar } = useSnackbar();
  const qc = useQueryClient();
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<'all' | 'active' | 'inactive'>('active');
  const [dialog, setDialog] = useState<{ employee?: SalesEmployee } | null>(null);
  const [addExisting, setAddExisting] = useState(false);
  const [issued, setIssued] = useState<{ name: string; email: string; password: string } | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['sales-employees', search, status],
    queryFn: () => apiGet<SalesEmployee[]>('/sales-employees', { ...(search.trim() && { search: search.trim() }), status }),
    placeholderData: keepPreviousData, // keep the rows on screen while a new search / filter loads (no "Loading..." flash per keystroke)
  });
  const { data: roles } = useQuery({ queryKey: ['roles'], queryFn: () => apiGet<RoleRow[]>('/settings/roles') });
  const { data: branches } = useQuery({ queryKey: ['company-branches'], queryFn: () => apiGet<Branch[]>('/company/branches') });

  const reissue = useMutation({
    mutationFn: (e: SalesEmployee) => apiPost<{ temporaryPassword: string }>(`/sales-employees/${e.id}/temporary-password`).then((r) => ({ e, r })),
    onSuccess: ({ e, r }) => { qc.invalidateQueries({ queryKey: ['sales-employees'] }); setIssued({ name: e.name, email: e.email, password: r.temporaryPassword }); },
    onError: (e) => enqueueSnackbar(errorOf(e, 'Could not issue a password'), { variant: 'error' }),
  });

  const unmark = useMutation({
    mutationFn: (e: SalesEmployee) => apiPost(`/sales-employees/${e.id}/unmark`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['sales-employees'] }); qc.invalidateQueries({ queryKey: ['sales-employee-members'] });
      enqueueSnackbar('Removed from sales employees. Their login is unchanged.', { variant: 'success' });
    },
    onError: (e) => enqueueSnackbar(errorOf(e, 'Could not remove'), { variant: 'error' }),
  });

  return (
    <Box>
      <PageHeader title="Sales Employees" actions={[
        { label: 'New Sales Employee', icon: <Add />, onClick: () => setDialog({}) },
        { label: 'Add Existing Member', icon: <PersonAdd />, onClick: () => setAddExisting(true) },
      ]} />
      <Box sx={{ display: 'flex', gap: 2, mb: 2, flexWrap: 'wrap' }}>
        <TextField size="small" label="Search name, code, mobile, email" value={search} onChange={(e) => setSearch(e.target.value)} sx={{ minWidth: 280 }} />
        <SelectField size="small" label="Status" value={status} onChange={(e: any) => setStatus(e.target.value)}
          options={[{ value: 'active', label: 'Active' }, { value: 'inactive', label: 'Inactive' }, { value: 'all', label: 'All' }]} />
      </Box>
      <Card>
        <Box sx={{ overflowX: 'auto' }}>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Code</TableCell><TableCell>Name</TableCell><TableCell>Designation</TableCell><TableCell>Mobile</TableCell>
                <TableCell>Role</TableCell><TableCell>Branches</TableCell><TableCell>Account</TableCell><TableCell />
              </TableRow>
            </TableHead>
            <TableBody>
              {isLoading ? <TableRow><TableCell colSpan={8} align="center" sx={{ py: 4 }}>Loading...</TableCell></TableRow>
                : (data ?? []).map((e) => (
                  <TableRow key={e.id} hover>
                    <TableCell sx={{ fontFamily: 'monospace' }}>{e.employeeId ?? '-'}</TableCell>
                    <TableCell sx={{ fontWeight: 600 }}>{e.name}<Typography variant="caption" display="block" color="text.secondary">{e.email}</Typography></TableCell>
                    <TableCell>{e.designation ?? '-'}</TableCell>
                    <TableCell>{e.phone ?? '-'}</TableCell>
                    <TableCell>{e.role.displayName}</TableCell>
                    <TableCell>{e.allBranches ? 'All branches' : e.branches.map((b) => b.name).join(', ') || '-'}</TableCell>
                    <TableCell><Chip size="small" label={STATUS_LABEL[e.accountStatus]} color={STATUS_COLOR[e.accountStatus]} /></TableCell>
                    <TableCell align="right">
                      <IconButton size="small" title="Edit" onClick={() => setDialog({ employee: e })}><Edit fontSize="small" /></IconButton>
                      <PermissionGate permission="user:manage">
                        <IconButton size="small" title="Issue new temporary password" disabled={reissue.isPending}
                          onClick={() => { if (window.confirm(`Issue a new temporary password for ${e.name}? Their current password stops working.`)) reissue.mutate(e); }}>
                          <LockReset fontSize="small" />
                        </IconButton>
                        <IconButton size="small" title="Remove from sales employees (keeps the login)" disabled={unmark.isPending}
                          onClick={() => { if (window.confirm(`Remove ${e.name} from sales employees? Their login is not deleted.`)) unmark.mutate(e); }}>
                          <PersonRemove fontSize="small" />
                        </IconButton>
                      </PermissionGate>
                    </TableCell>
                  </TableRow>
                ))}
              {!isLoading && (data ?? []).length === 0 && <TableRow><TableCell colSpan={8} align="center" sx={{ py: 4 }}>No sales employees found</TableCell></TableRow>}
            </TableBody>
          </Table>
        </Box>
      </Card>
      {dialog && (
        <EmployeeDialog employee={dialog.employee} creating={!dialog.employee} roles={roles ?? []} branches={branches ?? []}
          onClose={() => setDialog(null)} onCreated={setIssued} />
      )}
      {addExisting && <ExistingMemberDialog onClose={() => setAddExisting(false)} />}
      <PasswordDialog result={issued} onClose={() => setIssued(null)} />
    </Box>
  );
}
