import { Fragment, useMemo, useState } from 'react';
import {
  Box, Card, Table, TableHead, TableBody, TableRow, TableCell, Checkbox, IconButton,
  TextField, Grid, Typography, Alert, FormControlLabel, Button as MuiButton,
  Dialog, DialogTitle, DialogContent, DialogActions,
} from '@mui/material';
import { Add, DeleteOutline, ExpandMore, ChevronRight, UnfoldMore, UnfoldLess } from '@mui/icons-material';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useSnackbar } from 'notistack';
import { apiGet, apiPost, apiPatch, apiDelete } from '../../api/client';
import { PageHeader } from '../../components/common/PageHeader';
import { SelectField } from '../../components/fields/SelectField';
import { useAuthStore } from '../../store/auth.store';

export interface RoleRow { id: string; name: string; displayName: string; permissions: string[]; _count?: { memberships: number } }
interface PermissionCapability { action: string; permission: string }
interface PermissionCatalogItem { key: string; label: string; capabilities: PermissionCapability[] }
interface PermissionCatalogGroup { label: string; items: PermissionCatalogItem[] }

// The reference layout asks for a uniform View/Add/Edit/Delete/Export grid (one column per action,
// matching most jewellery-ERP role screens) — but this app's real permission strings aren't a
// uniform CRUD set per feature (see permissionCatalog.ts: GRN is Create/Verify, Karigar is
// Issue/Return, ...). Rather than inventing permissions nothing enforces just to fill a cell, only
// actions that map cleanly onto one of these five columns get one; everything else (Manage, Adjust,
// Approve, Verify, Issue, Return, Post, Transfer, Configure, Estimate, ...) is still fully grantable,
// just in the "Other" column, labelled with its own real action name. Delete stays disabled on every
// row on purpose: this app never hard-deletes a business record (tag, invoice, memo, ...) — only
// status-changes it — so no permission string for it exists anywhere to grant.
const STANDARD_COLUMNS = ['View', 'Add', 'Edit', 'Delete', 'Export'] as const;
type StandardColumn = typeof STANDARD_COLUMNS[number];
const ACTION_TO_COLUMN: Partial<Record<string, StandardColumn>> = {
  View: 'View', Create: 'Add', Edit: 'Edit', Update: 'Edit', Export: 'Export', Delete: 'Delete',
};

function classifyItem(item: PermissionCatalogItem) {
  const standard: Partial<Record<StandardColumn, PermissionCapability>> = {};
  const other: PermissionCapability[] = [];
  for (const c of item.capabilities) {
    const col = ACTION_TO_COLUMN[c.action];
    if (col && !standard[col]) standard[col] = c; else other.push(c);
  }
  return { standard, other };
}

const emptyDraft = () => ({ name: '', displayName: '', fullAccess: false, permissions: new Set<string>() });

/**
 * Role Rights — one screen, like the reference tool: pick a role from the top dropdown and its
 * grid loads below; "+ New Role" clears the draft instead of navigating to a separate page. No
 * route param — switching roles is just a state change, so it's instant and never loses your
 * place if you're mid-edit on the grid below.
 */
export function RoleEditorPage() {
  const { enqueueSnackbar } = useSnackbar();
  const qc = useQueryClient();
  const hasPermission = useAuthStore((s) => s.hasPermission);

  const { data: catalog } = useQuery({
    queryKey: ['permission-catalog'], queryFn: () => apiGet<PermissionCatalogGroup[]>('/settings/permission-catalog'),
  });
  const { data: roles } = useQuery({ queryKey: ['roles'], queryFn: () => apiGet<RoleRow[]>('/settings/roles') });

  const [selectedRoleId, setSelectedRoleId] = useState('');
  const [draft, setDraft] = useState(emptyDraft());
  const [copyFrom, setCopyFrom] = useState('');
  // Groups start COLLAPSED (opened tracks which are expanded, not which are hidden) — with ~15
  // groups and 40+ items each carrying several checkboxes, mounting every row by default made the
  // initial render (and, worse, every role switch — nearly every checkbox's checked state changes
  // at once) visibly heavy. Collapsed items render nothing at all, so both the first paint and a
  // role switch normally only have to touch the ~15 lightweight group header rows.
  const [opened, setOpened] = useState<Set<string>>(new Set());

  const selectedRole = useMemo(() => roles?.find((r) => r.id === selectedRoleId), [roles, selectedRoleId]);
  const isSuperAdmin = selectedRole?.name === 'SUPER_ADMIN';
  const isNew = !selectedRoleId;

  const selectRole = (roleId: string) => {
    setSelectedRoleId(roleId);
    const r = roles?.find((x) => x.id === roleId);
    setDraft({
      name: r?.name ?? '', displayName: r?.displayName ?? '',
      fullAccess: r?.permissions.includes('*') ?? false,
      permissions: new Set(r?.permissions.filter((p) => p !== '*') ?? []),
    });
    setCopyFrom('');
  };

  const togglePermission = (permission: string) => setDraft((prev) => {
    const permissions = new Set(prev.permissions);
    if (permissions.has(permission)) permissions.delete(permission); else permissions.add(permission);
    return { ...prev, permissions };
  });

  const setMany = (perms: string[], checked: boolean) => setDraft((prev) => {
    const permissions = new Set(prev.permissions);
    for (const p of perms) checked ? permissions.add(p) : permissions.delete(p);
    return { ...prev, permissions };
  });

  const applyCopyFrom = () => {
    const source = roles?.find((r) => r.id === copyFrom);
    if (!source) return;
    setDraft((prev) => ({
      ...prev,
      fullAccess: source.permissions.includes('*'),
      permissions: new Set(source.permissions.filter((p) => p !== '*')),
    }));
  };

  const toggleOpen = (label: string) => setOpened((prev) => {
    const next = new Set(prev);
    if (next.has(label)) next.delete(label); else next.add(label);
    return next;
  });

  const mutation = useMutation({
    mutationFn: () => {
      const permissionList = draft.fullAccess ? ['*'] : Array.from(draft.permissions);
      return isNew
        ? apiPost<RoleRow>('/settings/roles', { name: draft.name, displayName: draft.displayName, permissions: permissionList })
        : apiPatch<RoleRow>(`/settings/roles/${selectedRoleId}`, { displayName: draft.displayName, permissions: permissionList });
    },
    onSuccess: (saved) => {
      qc.invalidateQueries({ queryKey: ['roles'] });
      enqueueSnackbar(isNew ? 'Role created' : 'Role updated', { variant: 'success' });
      setSelectedRoleId(saved.id);
      setDraft((prev) => ({ ...prev, name: saved.name, displayName: saved.displayName }));
    },
    onError: (e: any) => enqueueSnackbar(e.response?.data?.error ?? 'Failed to save role', { variant: 'error' }),
  });

  const [confirmDelete, setConfirmDelete] = useState(false);
  const deleteMutation = useMutation({
    mutationFn: () => apiDelete(`/settings/roles/${selectedRoleId}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['roles'] });
      enqueueSnackbar('Role deleted', { variant: 'success' });
      setConfirmDelete(false);
      selectRole('');
    },
    onError: (e: any) => {
      setConfirmDelete(false);
      enqueueSnackbar(e.response?.data?.error ?? 'Failed to delete role', { variant: 'error' });
    },
  });

  const canSave = hasPermission(isNew ? 'role:create' : 'role:edit');
  const canDelete = hasPermission('role:delete');
  const roleOptions = useMemo(() => (roles ?? []).map((r) => ({ value: r.id, label: r.displayName })), [roles]);
  const copyFromOptions = useMemo(
    () => (roles ?? []).filter((r) => r.id !== selectedRoleId).map((r) => ({ value: r.id, label: r.displayName })),
    [roles, selectedRoleId],
  );

  return (
    <Box>
      <PageHeader title="Roles & Permissions" />

      <Card sx={{ p: 2, mb: 2 }}>
        <Grid container spacing={2} alignItems="center" wrap="wrap">
          <Grid item sx={{ width: 220 }}>
            <SelectField
              label="Role Name" emptyLabel="— New Role —" fullWidth
              options={roleOptions} value={selectedRoleId}
              onChange={(e) => selectRole(e.target.value)}
            />
          </Grid>
          <Grid item xs="auto">
            <MuiButton startIcon={<Add />} onClick={() => selectRole('')} disabled={isNew}>New Role</MuiButton>
          </Grid>
          <Grid item sx={{ width: 170 }}>
            <TextField
              fullWidth label="Role Code" value={draft.name} size="small"
              onChange={(e) => setDraft((prev) => ({ ...prev, name: e.target.value.toUpperCase() }))}
              disabled={!isNew} placeholder={isNew ? 'e.g. CASHIER' : undefined}
            />
          </Grid>
          <Grid item sx={{ width: 220 }}>
            <TextField
              fullWidth label="Display Name" value={draft.displayName} size="small"
              onChange={(e) => setDraft((prev) => ({ ...prev, displayName: e.target.value }))}
            />
          </Grid>
          {!isSuperAdmin && (
            <Grid item xs="auto" title="Super Admin equivalent — grants every permission, including future ones">
              <FormControlLabel
                control={<Checkbox checked={draft.fullAccess} onChange={(e) => setDraft((prev) => ({ ...prev, fullAccess: e.target.checked }))} />}
                label="Full access"
              />
            </Grid>
          )}
          {selectedRole?._count && (
            <Grid item xs="auto">
              <Typography variant="body2" color="text.secondary" noWrap>{selectedRole._count.memberships} user(s)</Typography>
            </Grid>
          )}
          <Grid item xs sx={{ display: 'flex', justifyContent: 'flex-end', gap: 1 }}>
            {!isNew && !isSuperAdmin && canDelete && (
              <MuiButton color="error" startIcon={<DeleteOutline />} onClick={() => setConfirmDelete(true)}>
                Delete
              </MuiButton>
            )}
            {canSave && (
              <MuiButton
                variant="contained" disabled={mutation.isPending || !draft.displayName || (isNew && !draft.name)}
                onClick={() => mutation.mutate()}
              >
                Save
              </MuiButton>
            )}
          </Grid>
        </Grid>
        {isNew && (
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
            Role Code e.g. CASHIER — cannot be changed later
          </Typography>
        )}
      </Card>

      <Dialog open={confirmDelete} onClose={() => setConfirmDelete(false)} maxWidth="xs" fullWidth>
        <DialogTitle fontWeight={700}>Delete Role?</DialogTitle>
        <DialogContent>
          <Typography variant="body2">
            Delete <strong>{selectedRole?.displayName}</strong>? This can't be undone. It's blocked if any
            member or pending invitation still holds this role — reassign them first.
          </Typography>
        </DialogContent>
        <DialogActions sx={{ p: 2.5 }}>
          <MuiButton onClick={() => setConfirmDelete(false)}>Cancel</MuiButton>
          <MuiButton color="error" variant="contained" disabled={deleteMutation.isPending} onClick={() => deleteMutation.mutate()}>
            Delete
          </MuiButton>
        </DialogActions>
      </Dialog>

      {isSuperAdmin && (
        <Alert severity="info" sx={{ mb: 2 }}>
          Super Administrator always has full access — its permissions can't be changed here. You can still rename it.
        </Alert>
      )}

      {!draft.fullAccess && !isSuperAdmin && (
        <Card sx={{ mb: 2 }}>
          <Box sx={{ display: 'flex', justifyContent: 'flex-end', p: 1 }}>
            <MuiButton
              size="small" startIcon={opened.size ? <UnfoldLess /> : <UnfoldMore />}
              onClick={() => setOpened(opened.size ? new Set() : new Set((catalog ?? []).map((g) => g.label)))}
            >
              {opened.size ? 'Collapse All' : 'Expand All'}
            </MuiButton>
          </Box>
          {/* Bounded height + its own scroll region (same convention as DataTable.tsx's maxHeight) —
              scrolling a long, heavy-with-checkboxes table is much smoother confined to a fixed box
              than left to the full page, which has to repaint everything above it too. */}
          <Box sx={{ overflowX: 'auto', overflowY: 'auto', maxHeight: '65vh' }}>
            <Table size="small" stickyHeader sx={{ '& .MuiTableCell-root': { whiteSpace: 'nowrap' } }}>
              <TableHead>
                <TableRow sx={{ '& th': { fontWeight: 700, bgcolor: 'background.paper' } }}>
                  <TableCell>Menu</TableCell>
                  {STANDARD_COLUMNS.map((c) => <TableCell key={c} align="center">{c}</TableCell>)}
                  <TableCell>Other</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {(catalog ?? []).map((group) => {
                  const groupItems = group.items.map((item) => ({ item, ...classifyItem(item) }));
                  const isOpen = opened.has(group.label);
                  return (
                    <Fragment key={group.label}>
                      <TableRow sx={{ bgcolor: '#fdf6e3' }}>
                        <TableCell>
                          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                            <IconButton size="small" onClick={() => toggleOpen(group.label)}>
                              {isOpen ? <ExpandMore fontSize="small" /> : <ChevronRight fontSize="small" />}
                            </IconButton>
                            <Typography fontWeight={700} fontSize={13}>{group.label}</Typography>
                          </Box>
                        </TableCell>
                        {STANDARD_COLUMNS.map((col) => {
                          const perms = groupItems.map((g) => g.standard[col]?.permission).filter((p): p is string => !!p);
                          if (perms.length === 0) {
                            return <TableCell key={col} align="center"><Checkbox size="small" disableRipple disabled /></TableCell>;
                          }
                          const grantedCount = perms.filter((p) => draft.permissions.has(p)).length;
                          return (
                            <TableCell key={col} align="center">
                              <Checkbox
                                size="small" disableRipple
                                checked={grantedCount === perms.length}
                                indeterminate={grantedCount > 0 && grantedCount < perms.length}
                                onChange={(e) => setMany(perms, e.target.checked)}
                              />
                            </TableCell>
                          );
                        })}
                        <TableCell />
                      </TableRow>
                      {isOpen && groupItems.map(({ item, standard, other }) => (
                        <TableRow key={item.key} hover>
                          <TableCell sx={{ pl: 5 }}>{item.label}</TableCell>
                          {STANDARD_COLUMNS.map((col) => {
                            const capability = standard[col];
                            if (!capability) {
                              // A native `title` instead of MUI's Tooltip — with ~150+ disabled
                              // cells in this grid, a Popper-backed tooltip on every one of them
                              // is enough live mouseenter/mouseleave listeners to visibly jank
                              // scrolling as rows pass under a stationary cursor. `title` costs
                              // nothing (the browser handles it, no JS, no extra DOM).
                              return (
                                <TableCell key={col} align="center">
                                  <span title="Not separately enforced for this feature — no matching permission exists in the app yet">
                                    <Checkbox size="small" disableRipple disabled />
                                  </span>
                                </TableCell>
                              );
                            }
                            return (
                              <TableCell key={col} align="center">
                                <Checkbox
                                  size="small" disableRipple
                                  checked={draft.permissions.has(capability.permission)}
                                  onChange={() => togglePermission(capability.permission)}
                                />
                              </TableCell>
                            );
                          })}
                          <TableCell>
                            <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
                              {other.map((c) => (
                                <FormControlLabel
                                  key={c.permission}
                                  sx={{ mr: 1 }}
                                  control={
                                    <Checkbox
                                      size="small" disableRipple
                                      checked={draft.permissions.has(c.permission)}
                                      onChange={() => togglePermission(c.permission)}
                                    />
                                  }
                                  label={<Typography fontSize={12.5}>{c.action}</Typography>}
                                />
                              ))}
                            </Box>
                          </TableCell>
                        </TableRow>
                      ))}
                    </Fragment>
                  );
                })}
              </TableBody>
            </Table>
          </Box>
        </Card>
      )}

      {!isSuperAdmin && (
        <Card sx={{ p: 2 }}>
          <Grid container spacing={2} alignItems="center">
            <Grid item xs={12} sm={4}>
              <SelectField
                label="Copy From Role Name" emptyLabel="(none)" options={copyFromOptions}
                value={copyFrom} onChange={(e) => setCopyFrom(e.target.value)}
              />
            </Grid>
            <Grid item xs="auto">
              <MuiButton variant="outlined" disabled={!copyFrom} onClick={applyCopyFrom}>Copy</MuiButton>
            </Grid>
          </Grid>
        </Card>
      )}
    </Box>
  );
}
