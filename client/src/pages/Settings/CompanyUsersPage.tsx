import { useState } from 'react';
import {
  Box, Card, Table, TableHead, TableBody, TableRow, TableCell, Typography,
  Button, Grid, Dialog, DialogTitle, DialogContent, DialogActions,
  TextField, Chip, Switch, FormControlLabel, IconButton, FormGroup, Checkbox,
  Alert, InputAdornment, Tooltip,
} from '@mui/material';
import { Add, Edit, ContentCopy, Cancel } from '@mui/icons-material';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { useSnackbar } from 'notistack';
import { apiGet, apiPost, apiPatch, apiDelete } from '../../api/client';
import { PageHeader } from '../../components/common/PageHeader';
import { SelectField } from '../../components/fields/SelectField';
import { useTabActions } from '../../components/Layout/useTabActions';
import type { RoleRow } from './RoleEditorPage';

type Role = RoleRow;
interface Branch { id: string; name: string; branchCode?: string }
interface Member {
  id: string; username: string | null; employeeId: string | null; department: string | null;
  phone: string | null; allBranches: boolean; isActive: boolean; isDefault: boolean;
  createdAt: string; lastLoginAt: string | null;
  user: { id: string; email: string; name: string };
  role: { id: string; name: string; displayName: string };
}
interface Invitation {
  id: string; email: string; roleId: string; allBranches: boolean; branchIds: string[];
  username: string | null; employeeId: string | null; department: string | null; phone: string | null;
  status: string; expiresAt: string; createdAt: string; acceptedAt: string | null;
  role: { id: string; name: string; displayName: string };
}

const STATUS_COLOR: Record<string, 'success' | 'warning' | 'default' | 'error'> = {
  PENDING: 'warning', ACCEPTED: 'success', EXPIRED: 'default', REVOKED: 'error',
};

// Shared by the invite and edit-member dialogs: an all-branches switch plus a checkbox list of
// this company's own branches (native checkboxes are keyboard-operable by construction — see
// CLAUDE.md §10 / UI_DESIGN_GUIDE.md §1, whose native-select advice targets single-value dropdowns).
function BranchPicker({
  branches, allBranches, onAllBranchesChange, selected, onToggle,
}: {
  branches: Branch[]; allBranches: boolean; onAllBranchesChange: (v: boolean) => void;
  selected: string[]; onToggle: (branchId: string) => void;
}) {
  return (
    <Box>
      <FormControlLabel
        control={<Switch checked={allBranches} onChange={(e) => onAllBranchesChange(e.target.checked)} />}
        label="All branches"
      />
      {!allBranches && (
        <FormGroup sx={{ ml: 1, maxHeight: 160, overflowY: 'auto', border: '1px solid', borderColor: 'divider', borderRadius: 1, p: 1 }}>
          {branches.map((b) => (
            <FormControlLabel
              key={b.id}
              control={<Checkbox size="small" checked={selected.includes(b.id)} onChange={() => onToggle(b.id)} />}
              label={b.name}
            />
          ))}
          {branches.length === 0 && <Typography variant="caption" color="text.secondary">No branches yet</Typography>}
        </FormGroup>
      )}
    </Box>
  );
}

interface InviteFormData {
  email: string; roleId: string; allBranches: boolean; branchIds: string[];
  username: string; employeeId: string; department: string; phone: string;
}

function InviteDialog({
  open, roles, branches, onClose, onInvited,
}: {
  open: boolean; roles: Role[]; branches: Branch[]; onClose: () => void;
  onInvited: (result: { token: string; email: string }) => void;
}) {
  const { enqueueSnackbar } = useSnackbar();
  const { openPath } = useTabActions();
  const { register, handleSubmit, watch, setValue, reset, formState: { errors } } = useForm<InviteFormData>({
    defaultValues: {
      email: '', roleId: '', allBranches: true, branchIds: [],
      username: '', employeeId: '', department: '', phone: '',
    },
  });
  const allBranches = watch('allBranches');
  const branchIds = watch('branchIds');

  const mutation = useMutation({
    mutationFn: (data: InviteFormData) => apiPost<{ token: string; email: string }>('/auth/invitations', {
      email: data.email.trim(),
      roleId: data.roleId,
      allBranches: data.allBranches,
      branchIds: data.allBranches ? undefined : data.branchIds,
      username: data.username.trim() || undefined,
      employeeId: data.employeeId.trim() || undefined,
      department: data.department.trim() || undefined,
      phone: data.phone.trim() || undefined,
    }),
    onSuccess: (res) => {
      onInvited(res);
      reset();
    },
    onError: (e: any) => enqueueSnackbar(e.response?.data?.error ?? 'Failed to invite', { variant: 'error' }),
  });

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <form onSubmit={handleSubmit((d) => mutation.mutate(d))}>
        <DialogTitle fontWeight={700}>Invite User</DialogTitle>
        <DialogContent sx={{ pt: 2 }}>
          <Grid container spacing={2}>
            <Grid item xs={12}>
              <TextField
                fullWidth label="Email" type="email" autoFocus
                {...register('email', { required: 'Email is required' })}
                error={!!errors.email} helperText={errors.email?.message}
              />
            </Grid>
            <Grid item xs={6}>
              <Box sx={{ display: 'flex', gap: 1, alignItems: 'flex-start' }}>
                <SelectField
                  label="Role" emptyLabel="Select a role"
                  options={roles.map((r) => ({ value: r.id, label: r.displayName }))}
                  {...register('roleId', { required: 'Role is required' })}
                  error={!!errors.roleId} helperText={errors.roleId?.message}
                />
                <Button
                  size="small" sx={{ mt: 0.75, whiteSpace: 'nowrap' }}
                  onClick={() => openPath('/settings/roles', true)}
                >
                  New Role
                </Button>
              </Box>
            </Grid>
            <Grid item xs={6}>
              <TextField fullWidth label="Username (optional)" {...register('username')} />
            </Grid>
            <Grid item xs={6}>
              <TextField fullWidth label="Employee ID (optional)" {...register('employeeId')} />
            </Grid>
            <Grid item xs={6}>
              <TextField fullWidth label="Department (optional)" {...register('department')} />
            </Grid>
            <Grid item xs={12}>
              <TextField fullWidth label="Phone (optional)" {...register('phone')} />
            </Grid>
            <Grid item xs={12}>
              <BranchPicker
                branches={branches}
                allBranches={allBranches}
                onAllBranchesChange={(v) => setValue('allBranches', v)}
                selected={branchIds}
                onToggle={(id) => setValue('branchIds', branchIds.includes(id) ? branchIds.filter((x) => x !== id) : [...branchIds, id])}
              />
            </Grid>
          </Grid>
        </DialogContent>
        <DialogActions sx={{ p: 2.5 }}>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="contained" disabled={mutation.isPending}>Send Invite</Button>
        </DialogActions>
      </form>
    </Dialog>
  );
}

// Shown once, right after an invite is created — the raw token is never retrievable again (there's
// no email provider wired up yet, so the admin hands this link to the invitee themselves).
function InviteLinkDialog({ result, onClose }: { result: { token: string; email: string } | null; onClose: () => void }) {
  const { enqueueSnackbar } = useSnackbar();
  if (!result) return null;
  const link = `${window.location.origin}/accept-invitation?token=${result.token}`;
  return (
    <Dialog open maxWidth="sm" fullWidth onClose={onClose}>
      <DialogTitle fontWeight={700}>Invitation Created</DialogTitle>
      <DialogContent>
        <Alert severity="info" sx={{ mb: 2 }}>
          Share this link with <strong>{result.email}</strong> — it can only be shown once and expires in 7 days.
        </Alert>
        <TextField
          fullWidth value={link} InputProps={{
            readOnly: true,
            endAdornment: (
              <InputAdornment position="end">
                <Tooltip title="Copy link">
                  <IconButton size="small" onClick={() => {
                    navigator.clipboard.writeText(link);
                    enqueueSnackbar('Link copied', { variant: 'success' });
                  }}>
                    <ContentCopy fontSize="small" />
                  </IconButton>
                </Tooltip>
              </InputAdornment>
            ),
          }}
        />
      </DialogContent>
      <DialogActions sx={{ p: 2.5 }}>
        <Button variant="contained" onClick={onClose}>Done</Button>
      </DialogActions>
    </Dialog>
  );
}

interface EditFormData {
  roleId: string; allBranches: boolean; branchIds: string[];
  username: string; employeeId: string; department: string; phone: string; isActive: boolean;
}

function EditMemberDialog({
  open, member, roles, branches, onClose,
}: { open: boolean; member?: Member; roles: Role[]; branches: Branch[]; onClose: () => void }) {
  const { enqueueSnackbar } = useSnackbar();
  const qc = useQueryClient();

  const { data: grantedBranchIds } = useQuery({
    queryKey: ['company-user-branch-access', member?.id],
    queryFn: () => apiGet<string[]>(`/company/users/${member!.id}/branch-access`),
    enabled: open && !!member && !member.allBranches,
  });

  const { register, handleSubmit, watch, setValue, reset, formState: { errors } } = useForm<EditFormData>({
    values: member ? {
      roleId: member.role.id, allBranches: member.allBranches, branchIds: grantedBranchIds ?? [],
      username: member.username ?? '', employeeId: member.employeeId ?? '', department: member.department ?? '',
      phone: member.phone ?? '', isActive: member.isActive,
    } : undefined,
  });
  const allBranches = watch('allBranches');
  const branchIds = watch('branchIds');

  const mutation = useMutation({
    mutationFn: async (data: EditFormData) => {
      await apiPatch(`/auth/users/${member!.id}`, {
        roleId: data.roleId, allBranches: data.allBranches,
        username: data.username.trim() || null,
        employeeId: data.employeeId.trim() || null,
        department: data.department.trim() || null,
        phone: data.phone.trim() || null,
        isActive: data.isActive,
      });
      if (!data.allBranches) {
        const before = new Set(grantedBranchIds ?? []);
        const after = new Set(data.branchIds);
        const toGrant = data.branchIds.filter((id) => !before.has(id));
        const toRevoke = (grantedBranchIds ?? []).filter((id) => !after.has(id));
        await Promise.all([
          ...toGrant.map((branchId) => apiPost(`/company/users/${member!.id}/branch-access`, { branchId })),
          ...toRevoke.map((branchId) => apiDelete(`/company/users/${member!.id}/branch-access/${branchId}`)),
        ]);
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['company-users'] });
      qc.invalidateQueries({ queryKey: ['company-user-branch-access', member!.id] });
      enqueueSnackbar('Member updated', { variant: 'success' });
      onClose();
    },
    onError: (e: any) => enqueueSnackbar(e.response?.data?.error ?? 'Failed to update', { variant: 'error' }),
  });

  if (!member) return null;

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <form onSubmit={handleSubmit((d) => mutation.mutate(d))}>
        <DialogTitle fontWeight={700}>Edit {member.user.name}</DialogTitle>
        <DialogContent sx={{ pt: 2 }}>
          <Grid container spacing={2}>
            <Grid item xs={12}>
              <TextField fullWidth label="Email" value={member.user.email} disabled />
            </Grid>
            <Grid item xs={6}>
              <SelectField
                label="Role"
                options={roles.map((r) => ({ value: r.id, label: r.displayName }))}
                {...register('roleId', { required: true })}
                error={!!errors.roleId}
              />
            </Grid>
            <Grid item xs={6}>
              <TextField fullWidth label="Username (optional)" {...register('username')} />
            </Grid>
            <Grid item xs={6}>
              <TextField fullWidth label="Employee ID (optional)" {...register('employeeId')} />
            </Grid>
            <Grid item xs={6}>
              <TextField fullWidth label="Department (optional)" {...register('department')} />
            </Grid>
            <Grid item xs={12}>
              <TextField fullWidth label="Phone (optional)" {...register('phone')} />
            </Grid>
            <Grid item xs={12}>
              <BranchPicker
                branches={branches}
                allBranches={allBranches}
                onAllBranchesChange={(v) => setValue('allBranches', v)}
                selected={branchIds}
                onToggle={(id) => setValue('branchIds', branchIds.includes(id) ? branchIds.filter((x) => x !== id) : [...branchIds, id])}
              />
            </Grid>
            <Grid item xs={12}>
              <FormControlLabel
                control={
                  <Switch
                    checked={watch('isActive')}
                    disabled={member.isDefault}
                    onChange={(e) => setValue('isActive', e.target.checked)}
                  />
                }
                label={member.isDefault ? 'Active (you cannot deactivate your own account)' : 'Active'}
              />
            </Grid>
          </Grid>
        </DialogContent>
        <DialogActions sx={{ p: 2.5 }}>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="contained" disabled={mutation.isPending}>Save</Button>
        </DialogActions>
      </form>
    </Dialog>
  );
}

export function CompanyUsersPage() {
  const { enqueueSnackbar } = useSnackbar();
  const qc = useQueryClient();
  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteResult, setInviteResult] = useState<{ token: string; email: string } | null>(null);
  const [editMember, setEditMember] = useState<Member | undefined>();

  const { data: members, isLoading: loadingMembers } = useQuery({
    queryKey: ['company-users'],
    queryFn: () => apiGet<Member[]>('/auth/users'),
  });
  const { data: invitations, isLoading: loadingInvites } = useQuery({
    queryKey: ['company-invitations'],
    queryFn: () => apiGet<Invitation[]>('/auth/invitations'),
  });
  const { data: roles } = useQuery({ queryKey: ['roles'], queryFn: () => apiGet<Role[]>('/settings/roles') });
  const { data: branches } = useQuery({ queryKey: ['company-branches'], queryFn: () => apiGet<Branch[]>('/company/branches') });

  const revokeMutation = useMutation({
    mutationFn: (id: string) => apiDelete(`/auth/invitations/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['company-invitations'] });
      enqueueSnackbar('Invitation revoked', { variant: 'success' });
    },
    onError: (e: any) => enqueueSnackbar(e.response?.data?.error ?? 'Failed to revoke', { variant: 'error' }),
  });

  return (
    <Box>
      <PageHeader title="Users"
        actions={[{ label: 'Invite User', icon: <Add />, onClick: () => setInviteOpen(true) }]} />

      <Typography variant="subtitle1" fontWeight={700} sx={{ mb: 1 }}>Members</Typography>
      <Card sx={{ mb: 3 }}>
        <Box sx={{ overflowX: 'auto' }}>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Name</TableCell>
                <TableCell>Email</TableCell>
                <TableCell>Employee ID</TableCell>
                <TableCell>Role</TableCell>
                <TableCell>Branches</TableCell>
                <TableCell>Status</TableCell>
                <TableCell>Last Login</TableCell>
                <TableCell />
              </TableRow>
            </TableHead>
            <TableBody>
              {loadingMembers ? (
                <TableRow><TableCell colSpan={8} align="center" sx={{ py: 4 }}>Loading...</TableCell></TableRow>
              ) : (members ?? []).map((m) => (
                <TableRow key={m.id} hover>
                  <TableCell sx={{ fontWeight: 600 }}>{m.user.name}</TableCell>
                  <TableCell>{m.user.email}</TableCell>
                  <TableCell sx={{ fontFamily: 'monospace' }}>{m.employeeId ?? '—'}</TableCell>
                  <TableCell>{m.role.displayName}</TableCell>
                  <TableCell>
                    <Chip label={m.allBranches ? 'All' : 'Custom'} size="small" variant="outlined" />
                  </TableCell>
                  <TableCell>
                    <Chip label={m.isActive ? 'Active' : 'Inactive'} size="small" color={m.isActive ? 'success' : 'default'} />
                  </TableCell>
                  <TableCell sx={{ fontSize: 12 }}>{m.lastLoginAt ? new Date(m.lastLoginAt).toLocaleString('en-IN') : 'Never'}</TableCell>
                  <TableCell align="right">
                    <IconButton size="small" onClick={() => setEditMember(m)}>
                      <Edit fontSize="small" />
                    </IconButton>
                  </TableCell>
                </TableRow>
              ))}
              {!loadingMembers && (members ?? []).length === 0 && (
                <TableRow><TableCell colSpan={8} align="center" sx={{ py: 4 }}>No members yet</TableCell></TableRow>
              )}
            </TableBody>
          </Table>
        </Box>
      </Card>

      <Typography variant="subtitle1" fontWeight={700} sx={{ mb: 1 }}>Pending Invitations</Typography>
      <Card>
        <Box sx={{ overflowX: 'auto' }}>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Email</TableCell>
                <TableCell>Role</TableCell>
                <TableCell>Status</TableCell>
                <TableCell>Expires</TableCell>
                <TableCell />
              </TableRow>
            </TableHead>
            <TableBody>
              {loadingInvites ? (
                <TableRow><TableCell colSpan={5} align="center" sx={{ py: 4 }}>Loading...</TableCell></TableRow>
              ) : (invitations ?? []).map((inv) => (
                <TableRow key={inv.id} hover>
                  <TableCell>{inv.email}</TableCell>
                  <TableCell>{inv.role.displayName}</TableCell>
                  <TableCell>
                    <Chip label={inv.status} size="small" color={STATUS_COLOR[inv.status] ?? 'default'} />
                  </TableCell>
                  <TableCell sx={{ fontSize: 12 }}>{new Date(inv.expiresAt).toLocaleString('en-IN')}</TableCell>
                  <TableCell align="right">
                    {inv.status === 'PENDING' && (
                      <Tooltip title="Revoke invitation">
                        <IconButton size="small" onClick={() => revokeMutation.mutate(inv.id)}>
                          <Cancel fontSize="small" />
                        </IconButton>
                      </Tooltip>
                    )}
                  </TableCell>
                </TableRow>
              ))}
              {!loadingInvites && (invitations ?? []).length === 0 && (
                <TableRow><TableCell colSpan={5} align="center" sx={{ py: 4 }}>No invitations yet</TableCell></TableRow>
              )}
            </TableBody>
          </Table>
        </Box>
      </Card>

      <InviteDialog
        open={inviteOpen}
        roles={roles ?? []}
        branches={branches ?? []}
        onClose={() => setInviteOpen(false)}
        onInvited={(result) => {
          setInviteOpen(false);
          setInviteResult(result);
          qc.invalidateQueries({ queryKey: ['company-invitations'] });
        }}
      />
      <InviteLinkDialog result={inviteResult} onClose={() => setInviteResult(null)} />
      <EditMemberDialog
        open={!!editMember}
        member={editMember}
        roles={roles ?? []}
        branches={branches ?? []}
        onClose={() => setEditMember(undefined)}
      />
    </Box>
  );
}
