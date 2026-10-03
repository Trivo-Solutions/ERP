import { useState, useEffect, useRef, Fragment } from 'react';
import {
  Box, Card, Table, TableHead, TableBody, TableRow, TableCell, Typography, Button,
  Grid, MenuItem, TextField, Chip, Dialog, DialogTitle, DialogContent, DialogActions,
  Drawer, Stack, Divider, IconButton, Alert, CircularProgress,
} from '@mui/material';
import { Add, Close, CheckCircle, Cancel, Send, Delete as DeleteIcon } from '@mui/icons-material';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm, Controller, useFieldArray } from 'react-hook-form';
import { useSnackbar } from 'notistack';
import { apiGet, apiPost, apiDelete } from '../../api/client';
import { PageHeader } from '../../components/common/PageHeader';
import { StatusChip } from '../../components/common/StatusChip';
import { useAuthStore } from '../../store/auth.store';
import { SelectField } from '../../components/fields/SelectField';
import { computeMakingAmount } from '../../utils/estimateCalc';
import { AddSupplierDialog } from '../../components/common/AddSupplierDialog';

const PO_APPROVAL_THRESHOLD = 500000;

// Only a PO that has received nothing can go (the server enforces this too and answers 409 otherwise).
const DELETABLE_PO_STATUSES = ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'CANCELLED'];

function fmt(n: number) {
  return '₹' + n.toLocaleString('en-IN', { maximumFractionDigits: 2 });
}

// ─── Comment Dialog ───────────────────────────────────────────────────────────

function CommentDialog({ open, title, onConfirm, onClose, required = false }: {
  open: boolean; title: string; onConfirm: (c: string) => void; onClose: () => void; required?: boolean;
}) {
  const [comment, setComment] = useState('');
  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle fontWeight={700}>{title}</DialogTitle>
      <DialogContent>
        <TextField fullWidth multiline rows={3} label={required ? 'Comments (required)' : 'Comments (optional)'}
          value={comment} onChange={(e) => setComment(e.target.value)} sx={{ mt: 1 }} />
      </DialogContent>
      <DialogActions sx={{ p: 2 }}>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="contained" disabled={required && !comment.trim()}
          onClick={() => { onConfirm(comment); setComment(''); }}>Confirm</Button>
      </DialogActions>
    </Dialog>
  );
}

// ─── PO Approval Drawer ───────────────────────────────────────────────────────

function POApprovalDrawer({ poId, onClose }: { poId: string; onClose: () => void }) {
  const { enqueueSnackbar } = useSnackbar();
  const qc = useQueryClient();
  const hasPermission = useAuthStore((s) => s.hasPermission);
  const [commentDialog, setCommentDialog] = useState<null | 'approve' | 'reject'>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['po-detail', poId],
    queryFn: () => apiGet<any>(`/procurement/orders/${poId}`),
    enabled: !!poId,
  });
  const po = (data as any)?.data ?? (data as any);

  const mutate = (url: string, body: object = {}) =>
    apiPost(url, body).then(() => {
      qc.invalidateQueries({ queryKey: ['purchase-orders'] });
      qc.invalidateQueries({ queryKey: ['po-detail', poId] });
    });

  const submitMutation = useMutation({
    mutationFn: () => mutate(`/procurement/orders/${poId}/submit`),
    onSuccess: () => enqueueSnackbar('PO submitted for approval', { variant: 'success' }),
    onError: (e: any) => enqueueSnackbar(e.response?.data?.error ?? 'Failed', { variant: 'error' }),
  });

  const approveMutation = useMutation({
    mutationFn: (comments: string) => mutate(`/procurement/orders/${poId}/approve`, { comments }),
    onSuccess: () => { setCommentDialog(null); enqueueSnackbar('PO approved', { variant: 'success' }); },
    onError: (e: any) => enqueueSnackbar(e.response?.data?.error ?? 'Failed', { variant: 'error' }),
  });

  const rejectMutation = useMutation({
    mutationFn: (comments: string) => mutate(`/procurement/orders/${poId}/reject`, { comments }),
    onSuccess: () => { setCommentDialog(null); enqueueSnackbar('PO rejected', { variant: 'success' }); },
    onError: (e: any) => enqueueSnackbar(e.response?.data?.error ?? 'Failed', { variant: 'error' }),
  });

  const deleteMutation = useMutation({
    mutationFn: () => apiDelete(`/procurement/orders/${poId}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['purchase-orders'] });
      enqueueSnackbar('Purchase order deleted', { variant: 'success' });
      onClose();
    },
    onError: (e: any) => enqueueSnackbar(e.response?.data?.error ?? 'Failed', { variant: 'error' }),
  });
  const confirmDelete = () => {
    if (window.confirm(`Delete purchase order ${po?.poNumber}? This cannot be undone.`)) deleteMutation.mutate();
  };

  const totalAmount = Number(po?.totalAmount ?? 0);
  const taxAmount = Number(po?.taxAmount ?? 0);
  // The limit is on the value of the goods ordered (matches approvePO), not on the GST added to it.
  // J4-D2: permission-based, not role-name based — po:approve_high_value can be granted to any role
  // (including a custom delegated one) through the Role Editor, same as every other capability.
  const needsHighValueApproval = totalAmount - taxAmount > PO_APPROVAL_THRESHOLD;
  const canApprove = hasPermission('po:approve') &&
    (!needsHighValueApproval || hasPermission('po:approve_high_value'));

  return (
    <Drawer anchor="right" open={!!poId} onClose={onClose} PaperProps={{ sx: { width: 640 } }}>
      <Box sx={{ p: 3, height: '100%', overflow: 'auto' }}>
        <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 2 }}>
          <Typography variant="h6" fontWeight={700}>Purchase Order</Typography>
          <IconButton onClick={onClose}><Close /></IconButton>
        </Stack>

        {isLoading && <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}><CircularProgress /></Box>}

        {po && (
          <>
            <Grid container spacing={1.5} sx={{ mb: 2 }}>
              <Grid item xs={6}><Typography variant="caption" color="text.secondary">PO Number</Typography>
                <Typography fontWeight={700} sx={{ fontFamily: 'monospace', color: '#44C47A' }}>{po.poNumber}</Typography></Grid>
              <Grid item xs={6}><Typography variant="caption" color="text.secondary">Status</Typography>
                <Box><StatusChip status={po.status} /></Box></Grid>
              <Grid item xs={6}><Typography variant="caption" color="text.secondary">Supplier</Typography>
                <Typography>{po.supplier?.name}</Typography></Grid>
              <Grid item xs={6}><Typography variant="caption" color="text.secondary">Type</Typography>
                <Typography>{po.poType}</Typography></Grid>
              <Grid item xs={6}><Typography variant="caption" color="text.secondary">Order Date</Typography>
                <Typography>{new Date(po.orderDate).toLocaleDateString('en-IN')}</Typography></Grid>
              <Grid item xs={6}><Typography variant="caption" color="text.secondary">Total Amount{taxAmount > 0 ? ' (incl. GST)' : ''}</Typography>
                <Typography fontWeight={700} color={needsHighValueApproval ? 'warning.main' : 'inherit'}>{fmt(totalAmount)}</Typography>
                {taxAmount > 0 && <Typography variant="caption" color="text.secondary">GST {fmt(taxAmount)}</Typography>}</Grid>
            </Grid>

            {needsHighValueApproval && po.status === 'PENDING_APPROVAL' && (
              <Alert severity="warning" sx={{ mb: 2 }}>
                This PO exceeds ₹5,00,000 — approval requires the po:approve_high_value permission.
              </Alert>
            )}

            <Divider sx={{ my: 2 }} />
            <Typography variant="subtitle2" fontWeight={700} gutterBottom>Line Items</Typography>
            <Box sx={{ overflowX: 'auto' }}>
            <Table size="small" sx={{ mb: 2 }}>
              <TableHead>
                <TableRow>
                  <TableCell>Material</TableCell>
                  <TableCell>Type</TableCell>
                  <TableCell align="right">Weight</TableCell>
                  <TableCell align="right">Rate/gm</TableCell>
                  <TableCell align="right">GST</TableCell>
                  <TableCell align="right">Total</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {(po.poItems ?? []).map((item: any) => (
                  <Fragment key={item.id}>
                  <TableRow>
                    <TableCell>
                      <Typography variant="body2" fontWeight={600}>{item.materialName}</Typography>
                      <Typography variant="caption" color="text.secondary">{item.materialCode}</Typography>
                    </TableCell>
                    <TableCell><Chip label={item.materialType} size="small" /></TableCell>
                    <TableCell align="right" sx={{ fontFamily: 'monospace' }}>
                      {item.materialType === 'FINISHED_LOT' ? (
                        <>
                          {Number(item.weight).toFixed(3)} g
                          <Typography component="div" variant="caption" color="text.secondary" sx={{ fontFamily: 'monospace' }}>
                            net {Number(item.netWeight ?? 0).toFixed(3)} g
                          </Typography>
                        </>
                      ) : <>{Number(item.weight).toFixed(3)} {item.unit}</>}
                    </TableCell>
                    <TableCell align="right" sx={{ fontFamily: 'monospace' }}>₹{Number(item.ratePerUnit).toLocaleString('en-IN')}</TableCell>
                    <TableCell align="right" sx={{ fontFamily: 'monospace' }}>{Number(item.taxRate) > 0 ? `${Number((Number(item.taxRate) * 100).toFixed(2))}%` : '—'}</TableCell>
                    <TableCell align="right" sx={{ fontFamily: 'monospace', fontWeight: 700 }}>{fmt(Number(item.totalAmount))}</TableCell>
                  </TableRow>
                  {(item.categories ?? []).length > 0 && (
                    <TableRow>
                      <TableCell colSpan={6} sx={{ pt: 0, pl: 4, borderBottom: 0 }}>
                        {item.categories.map((c: any) => (
                          <Typography key={c.id} variant="caption" component="div" color="text.secondary" sx={{ fontFamily: 'monospace' }}>
                            {c.category?.name} {c.karat} — gross {Number(c.grossWeight).toFixed(3)} g · stone {Number(c.stoneWeight).toFixed(3)} g · net {Number(c.netWeight).toFixed(3)} g{c.pieces != null ? ` · ${c.pieces} pcs` : ''}
                            {c.costRate != null ? ` · cost ₹${Number(c.costRate)}/g` : ''}{c.mcRate != null ? ` · MC ₹${Number(c.mcRate)}/g` : ''}{c.vaPercent != null ? ` · VA ${Number(c.vaPercent)}%` : ''}
                          </Typography>
                        ))}
                      </TableCell>
                    </TableRow>
                  )}
                  </Fragment>
                ))}
              </TableBody>
            </Table>
            </Box>

            {(po.approvalHistory ?? []).length > 0 && (
              <>
                <Divider sx={{ my: 2 }} />
                <Typography variant="subtitle2" fontWeight={700} gutterBottom>Approval History</Typography>
                <Stack spacing={1}>
                  {po.approvalHistory.map((h: any) => (
                    <Box key={h.id} sx={{ p: 1.5, bgcolor: 'action.hover', borderRadius: 1 }}>
                      <Stack direction="row" justifyContent="space-between">
                        <Typography variant="body2" fontWeight={600}>{h.action}</Typography>
                        <Typography variant="caption" color="text.secondary">{new Date(h.createdAt).toLocaleString('en-IN')}</Typography>
                      </Stack>
                      <Typography variant="caption" color="text.secondary">by {h.performedBy?.name}</Typography>
                      {h.comments && <Typography variant="body2" sx={{ mt: 0.5, fontStyle: 'italic' }}>"{h.comments}"</Typography>}
                    </Box>
                  ))}
                </Stack>
              </>
            )}

            <Divider sx={{ my: 2 }} />
            <Stack direction="row" spacing={1}>
              {po.status === 'DRAFT' && hasPermission('po:create') && (
                <Button variant="contained" startIcon={<Send />}
                  disabled={submitMutation.isPending}
                  onClick={() => submitMutation.mutate()}>Submit for Approval</Button>
              )}
              {po.status === 'PENDING_APPROVAL' && hasPermission('po:approve') && (
                <>
                  <Button variant="contained" color="success" startIcon={<CheckCircle />}
                    disabled={!canApprove} onClick={() => setCommentDialog('approve')}>
                    {canApprove ? 'Approve' : 'Approval Restricted'}
                  </Button>
                  <Button variant="outlined" color="error" startIcon={<Cancel />}
                    onClick={() => setCommentDialog('reject')}>Reject</Button>
                </>
              )}
              {DELETABLE_PO_STATUSES.includes(po.status) && (po.grns?.length ?? 0) === 0 && hasPermission('po:create') && (
                <Button color="error" startIcon={<DeleteIcon />} sx={{ ml: 'auto' }}
                  disabled={deleteMutation.isPending} onClick={confirmDelete}>Delete</Button>
              )}
            </Stack>
          </>
        )}
      </Box>

      <CommentDialog open={commentDialog === 'approve'} title="Approve Purchase Order"
        onClose={() => setCommentDialog(null)} onConfirm={(c) => approveMutation.mutate(c)} />
      <CommentDialog open={commentDialog === 'reject'} title="Reject Purchase Order" required
        onClose={() => setCommentDialog(null)} onConfirm={(c) => rejectMutation.mutate(c)} />
    </Drawer>
  );
}

// ─── Category rows of a bag (FINISHED_LOT) line ───────────────────────────────────────────────
//
// A bag is one invoice line with one amount; what is IN it is stated category by category — gross, stone and net
// weight (enter any two, the third fills in), the karat, and optionally a piece count. Those rows become the caps
// pieces are later tagged against, so a mistake here is worth catching now: the rows are totalled against the
// bag's gross weight as you type.

const BLANK_CATEGORY = { categoryId: '', karat: '22K', grossWeight: '' as string | number, stoneWeight: '' as string | number, netWeight: '' as string | number, pieces: '' as string | number,
  costRate: '' as string | number, mcRate: '' as string | number, vaPercent: '' as string | number };

const numOrNull = (v: unknown) => (v === '' || v == null ? null : Number(v));
const round3 = (n: number) => String(Math.round(n * 1000) / 1000);

function LotCategoryRows({ control, setValue, getValues, idx, categories, karats, bagGross, bagAmount, rows }: {
  control: any; setValue: any; getValues: any; idx: number; categories: any[]; karats: any[]; bagGross: number; bagAmount: number; rows: any[];
}) {
  const { fields, append, remove } = useFieldArray({ control, name: `items.${idx}.categories` });
  const at = (j: number, k: string) => `items.${idx}.categories.${j}.${k}`;

  // Any two of gross / stone / net give the third.
  const relink = (j: number, changed: 'grossWeight' | 'stoneWeight' | 'netWeight', value: string) => {
    const cur = (k: string) => numOrNull(getValues(at(j, k)));
    const g = changed === 'grossWeight' ? numOrNull(value) : cur('grossWeight');
    const st = changed === 'stoneWeight' ? numOrNull(value) : cur('stoneWeight');
    const n = changed === 'netWeight' ? numOrNull(value) : cur('netWeight');
    if (changed === 'grossWeight') {
      if (st != null && g != null) setValue(at(j, 'netWeight'), round3(g - st));
      else if (n != null && g != null) setValue(at(j, 'stoneWeight'), round3(g - n));
    } else if (changed === 'stoneWeight') {
      if (g != null && st != null) setValue(at(j, 'netWeight'), round3(g - st));
      else if (n != null && st != null) setValue(at(j, 'grossWeight'), round3(n + st));
    } else if (g != null && n != null) setValue(at(j, 'stoneWeight'), round3(g - n));
    else if (st != null && n != null) setValue(at(j, 'grossWeight'), round3(n + st));
  };

  const total = rows.reduce((s, r) => s + Number(r?.grossWeight || 0), 0);
  const off = bagGross > 0 && Math.abs(total - bagGross) > bagGross * 0.005;
  // What the cost rates add up to, for comparison with the invoice amount — the same arithmetic a tag uses:
  // metal = net × rate; making = net × MC + metal × VA%. Information only; the amount stays the bill's.
  const anyRates = rows.some((r) => numOrNull(r?.costRate) != null);
  const implied = rows.reduce((s, r) => {
    const net = Number(r?.netWeight || 0), metal = net * Number(r?.costRate || 0);
    return s + metal + computeMakingAmount(net, metal, Number(r?.mcRate || 0), Number(r?.vaPercent || 0));
  }, 0);
  const gap = implied - bagAmount;
  const rateOff = anyRates && bagAmount > 0 && Math.abs(gap) > bagAmount * 0.01;
  // Table cells: no floating labels — the column header names the field, so every row lines up.
  const weightField = (j: number, k: 'grossWeight' | 'stoneWeight' | 'netWeight', label: string) => (
    <Controller name={at(j, k) as any} control={control}
      render={({ field }) => (
        <TextField {...field} fullWidth size="small" type="number" inputProps={{ step: 0.001, min: 0, 'aria-label': label }}
          onChange={(e) => { field.onChange(e); relink(j, k, e.target.value); }} />
      )} />
  );
  const numField = (j: number, k: string, label: string, inputProps: object) => (
    <Controller name={at(j, k) as any} control={control}
      render={({ field }) => <TextField {...field} fullWidth size="small" type="number"
        inputProps={{ ...inputProps, 'aria-label': label }} />} />
  );
  const head = { fontSize: '0.7rem', py: 0.75, px: 0.75 } as const;
  const cell = { py: 0.75, px: 0.75, borderBottom: 'none' } as const;

  return (
    <Box sx={{ mt: 1, pl: 2, borderLeft: 3, borderColor: 'primary.light' }}>
      {fields.length > 0 && <Table size="small" sx={{ tableLayout: 'fixed', minWidth: 900 }}>
        <TableHead>
          <TableRow>
            <TableCell colSpan={6} sx={head} />
            <TableCell colSpan={3} align="center" sx={{ ...head, borderBottom: 1, borderColor: 'divider' }}>Cost rates (optional)</TableCell>
            <TableCell sx={{ ...head, width: 48 }} />
          </TableRow>
          <TableRow>
            <TableCell sx={{ ...head, width: '19%' }}>Category</TableCell>
            <TableCell sx={{ ...head, width: '8%' }}>Karat</TableCell>
            <TableCell sx={{ ...head, width: '11%' }}>Gross (g)</TableCell>
            <TableCell sx={{ ...head, width: '11%' }}>Stone (g)</TableCell>
            <TableCell sx={{ ...head, width: '11%' }}>Net (g)</TableCell>
            <TableCell sx={{ ...head, width: '8%' }}>Pieces</TableCell>
            <TableCell sx={{ ...head, width: '11%' }}>Metal ₹/g</TableCell>
            <TableCell sx={{ ...head, width: '11%' }}>Making ₹/g</TableCell>
            <TableCell sx={{ ...head, width: '8%' }}>VA %</TableCell>
            <TableCell sx={head} />
          </TableRow>
        </TableHead>
        <TableBody>
          {fields.map((f, j) => (
            <TableRow key={f.id}>
              <TableCell sx={cell}>
                <Controller name={at(j, 'categoryId') as any} control={control}
                  render={({ field }) => <SelectField {...field} size="small" emptyLabel="Select…" inputProps={{ 'aria-label': 'Category' }}
                    options={categories.map((c: any) => ({ value: c.id, label: c.name }))} />} />
              </TableCell>
              <TableCell sx={cell}>
                <Controller name={at(j, 'karat') as any} control={control}
                  render={({ field }) => <SelectField {...field} size="small" inputProps={{ 'aria-label': 'Karat' }}
                    options={karats.map((k: any) => ({ value: k.code, label: k.code }))} />} />
              </TableCell>
              <TableCell sx={cell}>{weightField(j, 'grossWeight', 'Gross (g)')}</TableCell>
              <TableCell sx={cell}>{weightField(j, 'stoneWeight', 'Stone (g)')}</TableCell>
              <TableCell sx={cell}>{weightField(j, 'netWeight', 'Net (g)')}</TableCell>
              <TableCell sx={cell}>{numField(j, 'pieces', 'Pieces', { min: 1, step: 1 })}</TableCell>
              {/* Entered once here, pre-filled on every tag cut from this category (each tag can still change them). */}
              <TableCell sx={cell}>{numField(j, 'costRate', 'Metal cost ₹/g', { step: 0.01, min: 0 })}</TableCell>
              <TableCell sx={cell}>{numField(j, 'mcRate', 'Making ₹/g', { step: 0.01, min: 0 })}</TableCell>
              <TableCell sx={cell}>{numField(j, 'vaPercent', 'VA %', { step: 0.01, min: 0, max: 100 })}</TableCell>
              <TableCell sx={{ ...cell, textAlign: 'right' }}>
                <IconButton size="small" color="error" aria-label="Remove category row" onClick={() => remove(j)}><Close fontSize="small" /></IconButton>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>}
      <Stack direction="row" spacing={2} alignItems="center" sx={{ mt: 1 }}>
        <Button size="small" startIcon={<Add />} onClick={() => append({ ...BLANK_CATEGORY })}>
          {fields.length === 0 ? 'Add category breakup (optional)' : 'Add category'}
        </Button>
        {fields.length === 0 ? (
          <Typography variant="caption" color="text.secondary">
            No breakup: the bag is billed as one lump (gross weight + amount). Pieces can then be tagged from it in any category.
          </Typography>
        ) : (
          <Typography variant="caption" color={off ? 'error' : 'text.secondary'} sx={{ fontFamily: 'monospace' }}>
            Categories total {total.toFixed(3)} g{bagGross > 0 ? ` of the bag's ${bagGross.toFixed(3)} g` : ''}{off ? ' — they must add up to the bag' : ''}
          </Typography>
        )}
      </Stack>
      {anyRates && (
        <Typography variant="caption" color={rateOff ? 'warning.main' : 'text.secondary'} sx={{ display: 'block', mt: 0.5, fontFamily: 'monospace' }}>
          The cost rates work out to ₹{implied.toLocaleString('en-IN', { maximumFractionDigits: 2 })}
          {bagAmount > 0 ? ` against the invoice amount ₹${bagAmount.toLocaleString('en-IN')} (${gap >= 0 ? '+' : '−'}₹${Math.abs(gap).toLocaleString('en-IN', { maximumFractionDigits: 2 })})` : ''}
          {rateOff ? ' — check the rates or the amount' : ''}
        </Typography>
      )}
    </Box>
  );
}

// ─── Stone / pearl / bead components of a line ────────────────────────────────────────────────
//
// Vendor rate = the default; PO rate = what was agreed for THIS purchase (it is what flows on to the GRN and tags).
// The default shown is whatever the server's resolver says (GET /procurement/vendor-rates/resolve) — nothing is
// matched here. The PO rate follows the default until the buyer types their own; an untouched rate is not sent, so
// the server records it as the vendor default, and a typed one is sent as costRate (an override, vendor master untouched).

const BLANK_COMPONENT = { stoneTypeId: '', stoneGradeId: '', unit: 'CT', rate: '' as string | number, rateEdited: false };
const COMPONENT_UNITS = ['CT', 'GM', 'PC'];
const inr = (n: number) => `₹${n.toLocaleString('en-IN', { maximumFractionDigits: 4 })}`;
const gradeLabel = (g: any) => [g.shape, g.color, g.clarity, g.cut, g.quality].filter(Boolean).join(' / ') || 'Grade';

function ComponentRow({ control, setValue, idx, j, row, supplierId, asOf, stoneTypes, onRemove }: {
  control: any; setValue: any; idx: number; j: number; row: any; supplierId: string; asOf: string; stoneTypes: any[]; onRemove: () => void;
}) {
  const at = (k: string) => `items.${idx}.components.${j}.${k}`;
  const typeId: string = row?.stoneTypeId ?? '';
  const gradeId: string = row?.stoneGradeId ?? '';
  const unit: string = row?.unit ?? 'CT';

  const { data: gradeData } = useQuery({
    queryKey: ['master-stone-grades', typeId], enabled: !!typeId,
    queryFn: () => apiGet<any>('/masters/stone-grades', { stoneTypeId: typeId }),
  });
  const grades: any[] = (gradeData as any)?.data ?? gradeData ?? [];

  const ready = !!supplierId && !!typeId;
  const { data: resolved, error: resolveError, isFetching } = useQuery({
    queryKey: ['vendor-rate-resolve', supplierId, typeId, gradeId, unit, asOf], enabled: ready, retry: false,
    queryFn: () => apiGet<any>('/procurement/vendor-rates/resolve', { supplierId, stoneTypeId: typeId, stoneGradeId: gradeId || undefined, unit, asOf }),
  });
  const r = (resolved as any)?.data ?? resolved;
  const defaultRate: number | null = r?.status === 'MATCH' ? Number(r.rate.costRate) : null;
  const shown = row?.rateEdited ? row.rate : (defaultRate ?? '');
  const differs = row?.rateEdited && defaultRate != null && row.rate !== '' && Number(row.rate) !== defaultRate;

  // Changing what the component IS invalidates a rate typed for the old one.
  const resetRate = () => { setValue(at('rate'), ''); setValue(at('rateEdited'), false); };

  let defaultText: string;
  if (!supplierId) defaultText = 'Select a supplier first';
  else if (!typeId) defaultText = '—';
  else if (isFetching && !r) defaultText = '…';
  else if (resolveError) defaultText = `Could not check: ${(resolveError as any)?.response?.data?.error ?? 'error'}`;
  else if (defaultRate != null) defaultText = `${inr(defaultRate)} / ${r.unit ?? unit}`;
  else if (r?.status === 'AMBIGUOUS') defaultText = `Ambiguous (${r.candidates.map((c: any) => inr(Number(c.costRate))).join(' or ')}) — enter the PO rate`;
  else defaultText = 'Not available';

  const head = { py: 0.75, px: 0.75, borderBottom: 'none' } as const;
  return (
    <TableRow>
      <TableCell sx={head}>
        <Controller name={at('stoneTypeId') as any} control={control}
          render={({ field }) => <SelectField {...field} size="small" emptyLabel="Select…" inputProps={{ 'aria-label': 'Component' }}
            options={stoneTypes.map((t: any) => ({ value: t.id, label: t.name }))}
            onChange={(e: any) => {
              field.onChange(e);
              const t = stoneTypes.find((x: any) => x.id === e.target.value);
              setValue(at('stoneGradeId'), ''); setValue(at('unit'), t?.unit ?? 'CT'); resetRate();
            }} />} />
      </TableCell>
      <TableCell sx={head}>
        <Controller name={at('stoneGradeId') as any} control={control}
          render={({ field }) => <SelectField {...field} size="small" emptyLabel="Any quality" inputProps={{ 'aria-label': 'Grade' }}
            options={grades.map((g: any) => ({ value: g.id, label: gradeLabel(g) }))}
            onChange={(e: any) => { field.onChange(e); resetRate(); }} />} />
      </TableCell>
      <TableCell sx={head}>
        <Controller name={at('unit') as any} control={control}
          render={({ field }) => <SelectField {...field} size="small" inputProps={{ 'aria-label': 'Unit' }}
            options={Array.from(new Set([...COMPONENT_UNITS, unit])).map((u) => ({ value: u, label: u }))}
            onChange={(e: any) => { field.onChange(e); resetRate(); }} />} />
      </TableCell>
      <TableCell sx={head}>
        <Typography variant="caption" color={defaultRate != null ? 'text.primary' : 'text.secondary'} sx={{ fontFamily: 'monospace' }}>
          {defaultText}
        </Typography>
      </TableCell>
      <TableCell sx={head}>
        <TextField size="small" fullWidth type="number" value={shown}
          placeholder={defaultRate == null && ready ? 'Enter rate' : undefined}
          inputProps={{ step: 0.01, min: 0, 'aria-label': 'PO rate' }}
          helperText={differs ? `Differs from vendor default ${inr(defaultRate!)}` : undefined}
          FormHelperTextProps={{ sx: { color: 'warning.main', mx: 0 } }}
          onChange={(e) => { setValue(at('rate'), e.target.value); setValue(at('rateEdited'), true); }} />
      </TableCell>
      <TableCell sx={{ ...head, textAlign: 'right' }}>
        <IconButton size="small" color="error" aria-label="Remove component" onClick={onRemove}><Close fontSize="small" /></IconButton>
      </TableCell>
    </TableRow>
  );
}

function LineComponents({ control, setValue, idx, rows, supplierId, asOf, stoneTypes }: {
  control: any; setValue: any; idx: number; rows: any[]; supplierId: string; asOf: string; stoneTypes: any[];
}) {
  const { fields, append, remove } = useFieldArray({ control, name: `items.${idx}.components` });
  const head = { fontSize: '0.7rem', py: 0.75, px: 0.75 } as const;
  return (
    <Box sx={{ mt: 0.5, pl: 2, borderLeft: 3, borderColor: 'divider' }}>
      {fields.length > 0 && (
        <Table size="small" sx={{ tableLayout: 'fixed', minWidth: 760 }}>
          <TableHead>
            <TableRow>
              <TableCell sx={{ ...head, width: '22%' }}>Component</TableCell>
              <TableCell sx={{ ...head, width: '22%' }}>Grade</TableCell>
              <TableCell sx={{ ...head, width: '10%' }}>Unit</TableCell>
              <TableCell sx={{ ...head, width: '24%' }}>Vendor default</TableCell>
              <TableCell sx={{ ...head, width: '16%' }}>PO rate (₹)</TableCell>
              <TableCell sx={{ ...head, width: 48 }} />
            </TableRow>
          </TableHead>
          <TableBody>
            {fields.map((f, j) => (
              <ComponentRow key={f.id} control={control} setValue={setValue} idx={idx} j={j} row={rows[j]}
                supplierId={supplierId} asOf={asOf} stoneTypes={stoneTypes} onRemove={() => remove(j)} />
            ))}
          </TableBody>
        </Table>
      )}
      <Stack direction="row" spacing={2} alignItems="center">
        <Button size="small" startIcon={<Add />} sx={{ flexShrink: 0, whiteSpace: 'nowrap' }} onClick={() => append({ ...BLANK_COMPONENT })}>Add component rate</Button>
        <Typography variant="caption" color="text.secondary">
          Optional. The vendor default only pre-fills the PO rate; the PO rate is what this purchase carries to the GRN and tags. Changing it never changes the vendor's rate list, and a later vendor change never changes this PO.
        </Typography>
      </Stack>
    </Box>
  );
}

// ─── Create PO Dialog ─────────────────────────────────────────────────────────

function CreatePODialog({ open, onClose, suppliers }: { open: boolean; onClose: () => void; suppliers: any[] }) {
  const { enqueueSnackbar } = useSnackbar();
  const qc = useQueryClient();
  const [supplierOpen, setSupplierOpen] = useState(false);

  const { data: approvedPRs } = useQuery({
    queryKey: ['prs-approved'],
    queryFn: () => apiGet<any>('/procurement/requisitions', { status: 'APPROVED' }),
    enabled: open,
  });
  const prs: any[] = (approvedPRs as any)?.prs ?? [];

  const { control, handleSubmit, reset, setValue, getValues, watch } = useForm({
    defaultValues: {
      supplierId: '', poType: 'OUTRIGHT', orderDate: new Date().toISOString().split('T')[0],
      currency: 'INR', prId: '',
      items: [{ materialCode: '', materialName: '', materialType: 'METAL', quantity: 1, weight: 0, lotAmount: '' as string | number, categories: [] as Array<typeof BLANK_CATEGORY>, components: [] as Array<typeof BLANK_COMPONENT>, unit: 'GM', karat: '22K', ratePerUnit: 0, gstPercent: '' as string | number }],
    },
  });
  const { data: stoneTypeData } = useQuery({ queryKey: ['master-stone-types'], queryFn: () => apiGet<any>('/masters/stone-types'), enabled: open });
  const stoneTypeList: any[] = ((stoneTypeData as any)?.data ?? stoneTypeData ?? []).filter((t: any) => t.isActive !== false);
  const { data: catData } = useQuery({ queryKey: ['master-categories'], queryFn: () => apiGet<any>('/masters/categories'), enabled: open });
  const categoryList: any[] = (catData as any)?.data ?? catData ?? [];
  const { data: karatData } = useQuery({ queryKey: ['master-karats'], queryFn: () => apiGet<any>('/masters/karats'), enabled: open });
  const karatList: any[] = (karatData as any)?.data ?? karatData ?? [];
  const { fields, append, remove, replace } = useFieldArray({ control, name: 'items' });

  const watchedPrId = watch('prId');
  const watchedItems = watch('items');
  const watchedSupplierId = watch('supplierId');
  const watchedOrderDate = watch('orderDate');

  // A PO rate typed under one supplier must never ride along to another: on a supplier change, drop every typed
  // component rate so the new supplier's vendor default shows (and a fresh override can be entered).
  const prevSupplierId = useRef(watchedSupplierId);
  useEffect(() => {
    if (prevSupplierId.current === watchedSupplierId) return;
    prevSupplierId.current = watchedSupplierId;
    (getValues('items') ?? []).forEach((it: any, i: number) => {
      (it.components ?? []).forEach((_c: any, j: number) => {
        setValue(`items.${i}.components.${j}.rate` as any, '');
        setValue(`items.${i}.components.${j}.rateEdited` as any, false);
      });
    });
  }, [watchedSupplierId, getValues, setValue]);

  const { data: prDetail } = useQuery({
    queryKey: ['pr-detail-for-po', watchedPrId],
    queryFn: () => apiGet<any>(`/procurement/requisitions/${watchedPrId}`),
    enabled: !!watchedPrId,
  });

  const onPRSelect = (prId: string) => {
    setValue('prId', prId);
    if (!prId) return;
    const pr = (prDetail as any)?.data ?? (prDetail as any);
    if (pr?.items) {
      replace(pr.items.map((i: any) => ({
        materialCode: i.materialCode, materialName: i.materialName,
        materialType: i.materialType, quantity: Number(i.quantity),
        weight: Number(i.weight), unit: i.unit,
        karat: i.karat ?? '', ratePerUnit: Number(i.estimatedRate),
      })));
    }
  };

  const mutation = useMutation({
    mutationFn: (data: any) => {
      const { prId: _prId, ...rest } = data;
      return apiPost('/procurement/orders', {
        ...rest, orderDate: new Date(rest.orderDate),
        // GST % as typed off the supplier's bill -> the fraction the API stores; blank = let the server
        // apply the HSN rate for a GST-registered supplier (0 for an unregistered one).
        items: rest.items.map(({ gstPercent, lotAmount, categories, components, ...i }: any) => ({
          ...i, ...(gstPercent !== '' && gstPercent != null && { taxRate: Number(gstPercent) / 100 }),
          // A component's rate is sent only when the buyer typed one (an override); left alone, the server applies the
          // vendor default itself. Rows with no component chosen are dropped.
          ...((components ?? []).some((c: any) => c.stoneTypeId) && {
            components: (components as any[]).filter((c) => c.stoneTypeId).map((c) => ({
              stoneTypeId: c.stoneTypeId, unit: c.unit,
              ...(c.stoneGradeId && { stoneGradeId: c.stoneGradeId }),
              ...(c.rateEdited && c.rate !== '' && { costRate: Number(c.rate) }),
            })),
          }),
          // The bag's amount and category rows only mean something on a bag line; blank strings must not reach the API.
          // Of gross/stone/net only what was entered is sent — the server works out the third.
          ...(i.materialType === 'FINISHED_LOT' && {
            lotAmount: Number(lotAmount), quantity: 1, weight: Number(i.weight),
            // The breakup is optional: a row left entirely blank is not a row.
            categories: (categories ?? []).filter((c: any) => c.categoryId || numOrNull(c.grossWeight) != null || numOrNull(c.netWeight) != null).map((c: any) => ({
              categoryId: c.categoryId, karat: c.karat, grossWeight: Number(c.grossWeight),
              ...(numOrNull(c.costRate) != null && { costRate: Number(c.costRate) }),
              ...(numOrNull(c.mcRate) != null && { mcRate: Number(c.mcRate) }),
              ...(numOrNull(c.vaPercent) != null && { vaPercent: Number(c.vaPercent) }),
              ...(numOrNull(c.stoneWeight) != null && { stoneWeight: Number(c.stoneWeight) }),
              ...(numOrNull(c.netWeight) != null && { netWeight: Number(c.netWeight) }),
              ...(numOrNull(c.pieces) != null && { pieces: Number(c.pieces) }),
            })),
          }),
        })),
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['purchase-orders'] });
      onClose();
      reset();
      enqueueSnackbar('Purchase Order created', { variant: 'success' });
    },
    onError: (err: any) => enqueueSnackbar(err.response?.data?.error ?? 'Failed', { variant: 'error' }),
  });

  const handleClose = () => { onClose(); reset(); };

  return (
    <>
    <Dialog open={open} onClose={handleClose} maxWidth="xl" fullWidth>
      <form onSubmit={handleSubmit((d) => mutation.mutate(d))}>
        <DialogTitle fontWeight={700}>Create Purchase Order</DialogTitle>
        <DialogContent sx={{ pt: 4 }}>
          <Grid container spacing={3} sx={{ mb: 3 }}>
            {prs.length > 0 && (
              <Grid item xs={12}>
                <Controller name="prId" control={control}
                  render={({ field }) => (
                    <TextField {...field} select fullWidth label="From Approved Requisition (optional)"
                      onChange={(e) => onPRSelect(e.target.value)}>
                      <MenuItem value="">None — manual entry</MenuItem>
                      {prs.map((pr: any) => <MenuItem key={pr.id} value={pr.id}>{pr.prNumber} — {pr.department} ({fmt(Number(pr.totalEstimatedAmount))})</MenuItem>)}
                    </TextField>
                  )} />
              </Grid>
            )}
            <Grid item xs={6}>
              <Box sx={{ display: 'flex', gap: 1, alignItems: 'flex-start' }}>
                <Controller name="supplierId" control={control} rules={{ required: true }}
                  render={({ field, fieldState }) => (
                    <SelectField {...field} label="Supplier" error={!!fieldState.error} emptyLabel="Select supplier"
                      options={suppliers.map((s: any) => ({ value: s.id, label: `${s.supplierCode} — ${s.name}` }))} />
                  )} />
                {/* New supplier without leaving this PO: a dialog over it, so nothing already typed here is lost. */}
                <IconButton color="primary" title="Add new supplier" aria-label="Add new supplier"
                  onClick={() => setSupplierOpen(true)} sx={{ mt: 0.5 }}>
                  <Add />
                </IconButton>
              </Box>
            </Grid>
            <Grid item xs={3}>
              <Controller name="poType" control={control}
                render={({ field }) => (
                  <TextField {...field} select fullWidth label="PO Type">
                    <MenuItem value="OUTRIGHT">Outright Purchase</MenuItem>
                    <MenuItem value="CONSIGNMENT">Consignment/Memo-In</MenuItem>
                    <MenuItem value="CUSTOMER_SUPPLIED">Customer Supplied</MenuItem>
                  </TextField>
                )} />
            </Grid>
            <Grid item xs={3}>
              <Controller name="orderDate" control={control}
                render={({ field }) => <TextField {...field} fullWidth label="Order Date" type="date" InputLabelProps={{ shrink: true }} />} />
            </Grid>
          </Grid>

          <Divider sx={{ mb: 2 }} />
          <Typography variant="subtitle2" fontWeight={700} sx={{ mb: 1 }}>Line Items</Typography>
          <Box sx={{ overflowX: 'auto' }}>
          <Table size="small" sx={{ tableLayout: 'fixed', minWidth: 900 }}>
            <TableHead>
              <TableRow>
                <TableCell sx={{ width: '11%' }}>Code</TableCell>
                <TableCell sx={{ width: '22%' }}>Material Name</TableCell>
                <TableCell sx={{ width: '22%' }}>Type</TableCell>
                <TableCell sx={{ width: '13%' }}>Weight (g)</TableCell>
                <TableCell sx={{ width: '9%' }}>GST %</TableCell>
                <TableCell sx={{ width: '16%' }}>Rate / Amount (₹)</TableCell>
                <TableCell sx={{ width: 56 }} />
              </TableRow>
            </TableHead>
            {fields.map((field, idx) => {
              const type = watchedItems?.[idx]?.materialType;
              const isLot = type === 'FINISHED_LOT';
              const cell = { py: 1, px: 0.75, borderBottom: 'none' } as const;
              return (
                <TableBody key={field.id}>
                  <TableRow>
                    <TableCell sx={cell}>
                      <Controller name={`items.${idx}.materialCode`} control={control}
                        render={({ field }) => <TextField {...field} fullWidth size="small" inputProps={{ 'aria-label': 'Code' }} />} />
                    </TableCell>
                    <TableCell sx={cell}>
                      <Controller name={`items.${idx}.materialName`} control={control}
                        render={({ field }) => <TextField {...field} fullWidth size="small" inputProps={{ 'aria-label': 'Material Name' }} />} />
                    </TableCell>
                    <TableCell sx={cell}>
                      <Controller name={`items.${idx}.materialType`} control={control}
                        render={({ field }) => (
                          <SelectField {...field} size="small" inputProps={{ 'aria-label': 'Type' }}
                            onChange={(e) => {
                              field.onChange(e);
                              // A finished piece is always one piece: qty 1, unit PC (the server rejects anything else).
                              if (e.target.value === 'FINISHED_GOODS') {
                                setValue(`items.${idx}.quantity`, 1);
                                setValue(`items.${idx}.unit`, 'PC');
                              }
                              // A bag is one unit; what is in it is entered category by category underneath.
                              if (e.target.value === 'FINISHED_LOT') {
                                setValue(`items.${idx}.quantity`, 1);
                                setValue(`items.${idx}.unit`, 'BAG');
                              }
                            }}
                            options={[
                              ...['METAL', 'DIAMOND', 'STONE', 'FINDING', 'CONSUMABLE'].map((t) => ({ value: t, label: t })),
                              { value: 'FINISHED_GOODS', label: 'FINISHED PIECE (ready to sell)' },
                              { value: 'FINISHED_LOT', label: 'FINISHED LOT (bag of pieces)' },
                            ]} />
                        )} />
                    </TableCell>
                    <TableCell sx={cell}>
                      <Controller name={`items.${idx}.weight`} control={control}
                        render={({ field }) => <TextField {...field} fullWidth size="small" type="number" placeholder={isLot ? 'Bag gross' : undefined}
                          inputProps={{ step: 0.001, 'aria-label': isLot ? 'Gross weight (g)' : 'Weight (g)' }} />} />
                    </TableCell>
                    <TableCell sx={cell}>
                      <Controller name={`items.${idx}.gstPercent`} control={control}
                        render={({ field }) => <TextField {...field} fullWidth size="small" type="number" placeholder="auto"
                          inputProps={{ step: 0.01, min: 0, 'aria-label': 'GST %' }} />} />
                    </TableCell>
                    <TableCell sx={cell}>
                      {isLot ? (
                        <Controller name={`items.${idx}.lotAmount`} control={control}
                          render={({ field }) => <TextField {...field} fullWidth size="small" type="number" placeholder="Lot amount"
                            inputProps={{ 'aria-label': 'Lot Amount (₹)', title: "The bag's total amount on the supplier's invoice, before GST" }} />} />
                      ) : (
                        <Controller name={`items.${idx}.ratePerUnit`} control={control}
                          render={({ field }) => <TextField {...field} fullWidth size="small" type="number"
                            placeholder={type === 'FINISHED_GOODS' ? 'Piece price' : 'Rate/gm'}
                            inputProps={{ 'aria-label': type === 'FINISHED_GOODS' ? 'Piece Price (₹)' : 'Rate/gm (₹)' }} />} />
                      )}
                    </TableCell>
                    <TableCell sx={{ ...cell, textAlign: 'right' }}>
                      <IconButton size="small" color="error" onClick={() => remove(idx)}><Close fontSize="small" /></IconButton>
                    </TableCell>
                  </TableRow>
                  <TableRow>
                    <TableCell colSpan={7} sx={{ pt: 0, pb: isLot ? 0 : 1, px: 0.75, borderBottom: isLot ? 'none' : undefined }}>
                      <Box sx={{ overflowX: 'auto' }}>
                        <LineComponents control={control} setValue={setValue} idx={idx} rows={(watchedItems?.[idx] as any)?.components ?? []}
                          supplierId={watchedSupplierId} asOf={watchedOrderDate} stoneTypes={stoneTypeList} />
                      </Box>
                    </TableCell>
                  </TableRow>
                  {isLot && (
                    <TableRow>
                      <TableCell colSpan={7} sx={{ pt: 0, pb: 2, px: 0.75 }}>
                        <Box sx={{ overflowX: 'auto' }}>
                          <LotCategoryRows control={control} setValue={setValue} getValues={getValues} idx={idx}
                            categories={categoryList} karats={karatList} bagGross={Number(watchedItems?.[idx]?.weight || 0)}
                            bagAmount={Number((watchedItems?.[idx] as any)?.lotAmount || 0)}
                            rows={(watchedItems?.[idx] as any)?.categories ?? []} />
                        </Box>
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              );
            })}
          </Table>
          </Box>
          <Button size="small" startIcon={<Add />} sx={{ mt: 1 }}
            onClick={() => append({ materialCode: '', materialName: '', materialType: 'METAL', quantity: 1, weight: 0, lotAmount: '', categories: [], components: [], unit: 'GM', karat: '22K', ratePerUnit: 0, gstPercent: '' })}>
            Add Line Item
          </Button>
        </DialogContent>
        <DialogActions sx={{ p: 2.5 }}>
          <Button onClick={handleClose}>Cancel</Button>
          <Button type="submit" variant="contained" disabled={mutation.isPending}>Create PO</Button>
        </DialogActions>
      </form>
    </Dialog>
    {/* A sibling of the PO dialog (not inside its <form>); on save the new supplier is selected here. */}
    <AddSupplierDialog open={supplierOpen} onClose={() => setSupplierOpen(false)}
      onCreated={(sup) => setValue('supplierId', sup.id, { shouldValidate: true, shouldDirty: true })} />
    </>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export function PurchaseOrders() {
  const { enqueueSnackbar } = useSnackbar();
  const qc = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [statusFilter, setStatusFilter] = useState('');
  const [selectedPOId, setSelectedPOId] = useState('');
  const hasPermission = useAuthStore((s) => s.hasPermission);
  const deletePO = (po: any) => {
    if (!window.confirm(`Delete purchase order ${po.poNumber}? This cannot be undone.`)) return;
    apiDelete(`/procurement/orders/${po.id}`)
      .then(() => { qc.invalidateQueries({ queryKey: ['purchase-orders'] }); enqueueSnackbar('Purchase order deleted', { variant: 'success' }); })
      .catch((e: any) => enqueueSnackbar(e.response?.data?.error ?? 'Failed', { variant: 'error' }));
  };

  const { data, isLoading } = useQuery({
    queryKey: ['purchase-orders', statusFilter],
    queryFn: () => apiGet<any>('/procurement/orders', { status: statusFilter || undefined }),
  });

  const { data: suppliers } = useQuery({
    queryKey: ['suppliers'],
    queryFn: () => apiGet<any[]>('/procurement/suppliers'),
  });

  const pos = (data as any)?.pos ?? [];
  const ALL_STATUSES = ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'CONFIRMED', 'PARTIAL', 'COMPLETED', 'CANCELLED', 'REJECTED'];

  return (
    <Box>
      <PageHeader title="Purchase Orders" />

      <Card sx={{ mb: 2, p: 1.5 }}>
        <Grid container spacing={2} alignItems="center">
          <Grid item xs={4}>
            <TextField select fullWidth size="small" label="Status" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
              <MenuItem value="">All</MenuItem>
              {ALL_STATUSES.map((s) => <MenuItem key={s} value={s}>{s}</MenuItem>)}
            </TextField>
          </Grid>
          <Grid item><Typography variant="caption" color="text.secondary">{(data as any)?.total ?? 0} orders</Typography></Grid>
          <Grid item sx={{ ml: 'auto', alignSelf: 'center' }}>
            {hasPermission('po:create') && (
              <Button variant="contained" size="small" startIcon={<Add />} onClick={() => setCreateOpen(true)}>New PO</Button>
            )}
          </Grid>
        </Grid>
      </Card>

      <Card>
        <Box sx={{ overflowX: 'auto' }}>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>PO Number</TableCell>
              <TableCell>Supplier</TableCell>
              <TableCell>Type</TableCell>
              <TableCell>Order Date</TableCell>
              <TableCell align="right">Total (₹)</TableCell>
              <TableCell>GRNs</TableCell>
              <TableCell>Status</TableCell>
              <TableCell />
            </TableRow>
          </TableHead>
          <TableBody>
            {isLoading ? (
              <TableRow><TableCell colSpan={8} align="center" sx={{ py: 4 }}>Loading...</TableCell></TableRow>
            ) : pos.map((po: any) => (
              <TableRow key={po.id} hover sx={{ cursor: 'pointer' }} onClick={() => setSelectedPOId(po.id)}>
                <TableCell sx={{ fontFamily: 'monospace', fontSize: 12, fontWeight: 700, color: '#44C47A' }}>{po.poNumber}</TableCell>
                <TableCell>{po.supplier?.name}</TableCell>
                <TableCell><Chip label={po.poType} size="small" /></TableCell>
                <TableCell sx={{ fontSize: 12 }}>{new Date(po.orderDate).toLocaleDateString('en-IN')}</TableCell>
                <TableCell align="right" sx={{ fontFamily: 'monospace' }}>{fmt(Number(po.totalAmount))}</TableCell>
                <TableCell align="center">{po._count?.grns ?? 0}</TableCell>
                <TableCell><StatusChip status={po.status} /></TableCell>
                <TableCell align="right" sx={{ py: 0 }}>
                  {DELETABLE_PO_STATUSES.includes(po.status) && !(po._count?.grns > 0) && hasPermission('po:create') && (
                    <IconButton size="small" color="error" aria-label={`Delete ${po.poNumber}`}
                      onClick={(e) => { e.stopPropagation(); deletePO(po); }}>
                      <DeleteIcon fontSize="small" />
                    </IconButton>
                  )}
                </TableCell>
              </TableRow>
            ))}
            {!isLoading && pos.length === 0 && (
              <TableRow><TableCell colSpan={8} align="center" sx={{ py: 4 }}>No purchase orders</TableCell></TableRow>
            )}
          </TableBody>
        </Table>
        </Box>
      </Card>

      <CreatePODialog open={createOpen} onClose={() => setCreateOpen(false)} suppliers={(suppliers as any) ?? []} />
      {selectedPOId && <POApprovalDrawer poId={selectedPOId} onClose={() => setSelectedPOId('')} />}
    </Box>
  );
}
