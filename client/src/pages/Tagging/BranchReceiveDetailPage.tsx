import { useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  Box, Card, Typography, Button, Stack, TextField, Tabs, Tab, Table, TableHead, TableBody, TableRow,
  TableCell, TableFooter, Checkbox, Chip, Divider, CircularProgress, Alert,
  Dialog, DialogTitle, DialogContent, DialogContentText, DialogActions,
} from '@mui/material';
import { ArrowBack } from '@mui/icons-material';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useSnackbar } from 'notistack';
import { apiGet, apiPost } from '../../api/client';
import { PageHeader } from '../../components/common/PageHeader';
import { StatusChip } from '../../components/common/StatusChip';

// Receiving a dispatched transfer: same two-tab layout and item table as the sending page, but the
// pieces are checked off as they are physically verified and only the verified ones are taken in.
// Whatever is not verified stays in transit and the transfer is "Partly Received" until the rest arrive.

const num = (v: unknown) => Number(v ?? 0) || 0;
const fmtWt = (v: number) => v.toFixed(3);
const fmtMoney = (v: number) => v.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtDate = (v?: string) => (v ? new Date(v).toLocaleDateString('en-IN') : '—');

const labelSx = { fontSize: 12, color: 'text.secondary' };
const cellSx = { py: 0.5, whiteSpace: 'nowrap' } as const;
const mono = { fontFamily: 'monospace' } as const;

const sumWt = (rows: any[], k: string) => rows.reduce((a, i) => a + num(i.tag?.[k]), 0);

export function BranchReceiveDetailPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { enqueueSnackbar } = useSnackbar();

  const [activeTab, setActiveTab] = useState(1); // land on the items — that is the work here
  const [verified, setVerified] = useState<Set<string>>(new Set()); // tag ids ticked off
  const [scan, setScan] = useState('');
  const [confirmOpen, setConfirmOpen] = useState(false);
  const scanRef = useRef<HTMLInputElement>(null);

  const { data, isLoading, error } = useQuery({
    queryKey: ['branch-transfer', id],
    queryFn: () => apiGet<any>(`/tagging/transfers/${id}`),
    enabled: !!id,
  });
  const tr = (data as any)?.data ?? data;
  const items: any[] = tr?.items ?? [];
  const pending = items.filter((i) => !i.receivedAt);
  const received = items.filter((i) => i.receivedAt);
  const canReceive = tr && (tr.status === 'DISPATCHED' || tr.status === 'PARTIALLY_RECEIVED');
  const verifiedItems = pending.filter((i) => verified.has(i.tagId));
  const unverifiedCount = pending.length - verifiedItems.length;
  const allVerified = pending.length > 0 && unverifiedCount === 0;

  const categoryRows = useMemo(() => {
    const map = new Map<string, { name: string; sent: number; received: number }>();
    for (const i of items) {
      const name = i.tag?.category?.name ?? 'Uncategorised';
      const r = map.get(name) ?? { name, sent: 0, received: 0 };
      r.sent += 1;
      if (i.receivedAt) r.received += 1;
      map.set(name, r);
    }
    return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [items]);

  const toggle = (tagId: string) => setVerified((prev) => {
    const next = new Set(prev);
    if (next.has(tagId)) next.delete(tagId); else next.add(tagId);
    return next;
  });
  const toggleAll = () => setVerified(allVerified ? new Set() : new Set(pending.map((i) => i.tagId)));

  // Scan (or type) a tag number / HUID and press Enter: ticks that piece off.
  const handleScan = () => {
    const q = scan.trim().toLowerCase();
    if (!q) return;
    setScan('');
    const hit = items.find((i) => i.tag?.tagNumber?.toLowerCase() === q || (i.tag?.huid && i.tag.huid.toLowerCase() === q));
    if (!hit) return void enqueueSnackbar(`${scan.trim()} is not on this transfer`, { variant: 'error' });
    if (hit.receivedAt) return void enqueueSnackbar(`${hit.tag.tagNumber} was already received`, { variant: 'info' });
    if (verified.has(hit.tagId)) return void enqueueSnackbar(`${hit.tag.tagNumber} is already verified`, { variant: 'info' });
    toggle(hit.tagId);
  };

  const mutation = useMutation({
    mutationFn: () => apiPost<any>(`/tagging/transfers/${id}/receive`, { tagIds: verifiedItems.map((i) => i.tagId) }),
    onSuccess: (res: any) => {
      const status = (res?.data ?? res)?.status;
      qc.invalidateQueries({ queryKey: ['branch-transfers'] });
      qc.invalidateQueries({ queryKey: ['branch-transfer', id] });
      qc.invalidateQueries({ queryKey: ['tags'] });
      setVerified(new Set());
      setConfirmOpen(false);
      if (status === 'RECEIVED') {
        enqueueSnackbar('Transfer fully received', { variant: 'success' });
        navigate('/tagging/receives');
      } else {
        enqueueSnackbar('Verified items received — the rest are still in transit', { variant: 'success' });
      }
    },
    onError: (e: any) => { setConfirmOpen(false); enqueueSnackbar(e.response?.data?.error ?? 'Failed', { variant: 'error' }); },
  });

  const startReceive = () => (unverifiedCount > 0 ? setConfirmOpen(true) : mutation.mutate());
  const back = () => navigate('/tagging/receives');

  if (isLoading) return <Box sx={{ display: 'flex', justifyContent: 'center', py: 8 }}><CircularProgress /></Box>;
  if (error || !tr) {
    return (
      <Box>
        <PageHeader title="Receive Transfer" />
        <Alert severity="error" action={<Button color="inherit" size="small" onClick={back}>Back</Button>}>Transfer not found</Alert>
      </Box>
    );
  }

  const readOnly = (label: string, value: string) => (
    <TextField label={label} value={value} size="small" InputProps={{ readOnly: true }} InputLabelProps={{ shrink: true }} />
  );

  return (
    <Box>
      <PageHeader title={`Receive ${tr.transferNumber}`} />

      <Card sx={{ p: 0 }}>
        <Stack direction="row" justifyContent="space-between" alignItems="center"
          sx={{ px: 2, py: 1, bgcolor: 'action.hover', borderBottom: 1, borderColor: 'divider' }}>
          <Typography variant="body2" fontWeight={700}>
            Name : <Box component="span" fontWeight={500}>{tr.fromBranch?.name} → {tr.toBranch?.name}</Box>
          </Typography>
          <Stack direction="row" spacing={1.5} alignItems="center">
            <StatusChip status={tr.status} />
            <Typography variant="body2" fontWeight={700}>
              No : <Box component="span" fontWeight={500} sx={mono}>{tr.transferNumber}</Box>
            </Typography>
          </Stack>
        </Stack>

        <Box sx={{ display: 'flex', minHeight: 520 }}>
          <Box sx={{ width: 200, flexShrink: 0, borderRight: 1, borderColor: 'divider', display: 'flex', flexDirection: 'column' }}>
            <Tabs orientation="vertical" value={activeTab} onChange={(_, v) => setActiveTab(v)}
              sx={{ '& .MuiTab-root': { alignItems: 'flex-start', textAlign: 'left', textTransform: 'none', fontWeight: 600 } }}>
              <Tab label="Jewelry Detail" />
              <Tab label={`Items Detail (${received.length}/${items.length})`} />
            </Tabs>
            <Box sx={{ mt: 'auto', p: 1.5 }}>
              <Button fullWidth size="small" variant="outlined" startIcon={<ArrowBack />} onClick={back}>
                Back to Receives
              </Button>
            </Box>
          </Box>

          <Box sx={{ flex: 1, minWidth: 0, p: 2, display: 'flex', flexDirection: 'column' }}>
            {/* ── Tab 1: Jewelry Detail (read-only) ── */}
            {activeTab === 0 && (
              <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', lg: 'minmax(0, 1.2fr) minmax(0, 1fr)' }, gap: 3, alignItems: 'start' }}>
                <Stack spacing={2}>
                  <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 1.5 }}>
                    {readOnly('Transaction Date', fmtDate(tr.createdAt))}
                    {readOnly('Transaction No', tr.transferNumber)}
                    {readOnly('From Branch', tr.fromBranch?.name ?? '')}
                    {readOnly('To Branch', tr.toBranch?.name ?? '')}
                    {readOnly('Requested By', tr.requestedBy?.name ?? '')}
                    {readOnly('Approved By', tr.approvedBy?.name ?? '—')}
                    {readOnly('Dispatched', fmtDate(tr.dispatchedAt))}
                    {readOnly('Received', fmtDate(tr.receivedAt))}
                    <TextField label="Remarks" value={tr.notes ?? ''} multiline minRows={2} size="small"
                      InputProps={{ readOnly: true }} InputLabelProps={{ shrink: true }} sx={{ gridColumn: '1 / -1' }} />
                  </Box>

                  <Box>
                    <Typography sx={{ fontWeight: 700, color: 'primary.main', mb: 0.5 }}>Category Overview</Typography>
                    <Box sx={{ border: 1, borderColor: 'divider', overflowX: 'auto' }}>
                      <Table size="small">
                        <TableHead>
                          <TableRow>
                            <TableCell>Category</TableCell>
                            <TableCell align="right">Sent</TableCell>
                            <TableCell align="right">Received</TableCell>
                            <TableCell align="right">Remaining</TableCell>
                          </TableRow>
                        </TableHead>
                        <TableBody>
                          {categoryRows.map((r) => (
                            <TableRow key={r.name}>
                              <TableCell sx={cellSx}>{r.name}</TableCell>
                              <TableCell align="right" sx={cellSx}>{r.sent}</TableCell>
                              <TableCell align="right" sx={cellSx}>{r.received}</TableCell>
                              <TableCell align="right" sx={cellSx}>{r.sent - r.received}</TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </Box>
                  </Box>
                </Stack>

                <Box sx={{ border: 1, borderColor: 'divider' }}>
                  <Stack direction="row" alignItems="baseline" spacing={2} sx={{ px: 2, py: 1, bgcolor: 'action.hover' }}>
                    <Typography variant="h6" fontWeight={700}>Summary</Typography>
                    <Typography variant="body2" fontWeight={700} sx={{ px: 1, bgcolor: 'action.selected', borderRadius: 0.5 }}>
                      Gross Wt : {fmtWt(sumWt(items, 'grossWeight'))}
                    </Typography>
                  </Stack>
                  <Table size="small">
                    <TableHead>
                      <TableRow>
                        <TableCell>Caption</TableCell>
                        <TableCell align="right">Pieces</TableCell>
                        <TableCell align="right">Gross Wt</TableCell>
                        <TableCell align="right">Net Wt</TableCell>
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {[
                        { label: 'Sent', rows: items },
                        { label: 'Received', rows: received },
                        { label: 'Verified (to receive)', rows: verifiedItems },
                        { label: 'Still in transit', rows: pending },
                      ].map((r) => (
                        <TableRow key={r.label}>
                          <TableCell sx={{ fontWeight: 700, color: 'success.main' }}>{r.label}</TableCell>
                          <TableCell align="right">{r.rows.length}</TableCell>
                          <TableCell align="right" sx={mono}>{fmtWt(sumWt(r.rows, 'grossWeight'))}</TableCell>
                          <TableCell align="right" sx={mono}>{fmtWt(sumWt(r.rows, 'netWeight'))}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                  <Divider />
                  <Stack direction="row" justifyContent="space-between" sx={{ px: 2, py: 1.5 }}>
                    <Typography sx={{ fontWeight: 700, color: 'warning.main' }}>Stock Value (at selling price)</Typography>
                    <Typography sx={{ ...mono, fontWeight: 700 }}>₹{fmtMoney(sumWt(items, 'sellingPrice'))}</Typography>
                  </Stack>
                </Box>
              </Box>
            )}

            {/* ── Tab 2: Items Detail — verify and receive ── */}
            {activeTab === 1 && (
              <Box sx={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
                {canReceive ? (
                  <Stack direction="row" spacing={2} alignItems="center" sx={{ mb: 1.5 }} flexWrap="wrap" useFlexGap>
                    <TextField
                      size="small" sx={{ width: 420, maxWidth: '100%' }} autoFocus inputRef={scanRef}
                      label="Verify item" placeholder="Scan or type tag number / HUID, press Enter"
                      value={scan} onChange={(e) => setScan(e.target.value)} InputLabelProps={{ shrink: true }}
                      onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleScan(); } }} />
                    <Typography variant="body2" color="text.secondary">
                      {verifiedItems.length} of {pending.length} awaiting item{pending.length === 1 ? '' : 's'} verified
                    </Typography>
                  </Stack>
                ) : (
                  <Alert severity="info" sx={{ mb: 1.5 }}>
                    This transfer is {tr.status === 'RECEIVED' ? 'fully received' : `not ready to receive (${tr.status})`}.
                  </Alert>
                )}

                <Box sx={{ border: 1, borderColor: 'divider', overflow: 'auto', flex: 1 }}>
                  <Table size="small" stickyHeader>
                    <TableHead>
                      <TableRow>
                        {canReceive && (
                          <TableCell padding="checkbox">
                            <Checkbox size="small" checked={allVerified}
                              indeterminate={verifiedItems.length > 0 && !allVerified}
                              disabled={pending.length === 0} onChange={toggleAll}
                              inputProps={{ 'aria-label': 'Verify all' }} />
                          </TableCell>
                        )}
                        <TableCell>#</TableCell>
                        <TableCell>Tag No</TableCell>
                        <TableCell>Name</TableCell>
                        <TableCell>Category</TableCell>
                        <TableCell>Metal</TableCell>
                        <TableCell>HUID</TableCell>
                        <TableCell align="right">Gross Wt</TableCell>
                        <TableCell align="right">Stone Wt</TableCell>
                        <TableCell align="right">Net Wt</TableCell>
                        <TableCell align="right">Price</TableCell>
                        <TableCell>State</TableCell>
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {items.map((i, n) => {
                        const t = i.tag ?? {};
                        const isDone = !!i.receivedAt;
                        const isVerified = verified.has(i.tagId);
                        return (
                          <TableRow key={i.id} hover selected={isVerified}
                            sx={{ cursor: canReceive && !isDone ? 'pointer' : 'default', opacity: isDone ? 0.65 : 1 }}
                            onClick={() => { if (canReceive && !isDone) toggle(i.tagId); }}>
                            {canReceive && (
                              <TableCell padding="checkbox">
                                <Checkbox size="small" checked={isDone || isVerified} disabled={isDone}
                                  onClick={(e) => e.stopPropagation()} onChange={() => toggle(i.tagId)}
                                  inputProps={{ 'aria-label': `Verify ${t.tagNumber}` }} />
                              </TableCell>
                            )}
                            <TableCell sx={cellSx}>{n + 1}</TableCell>
                            <TableCell sx={{ ...cellSx, ...mono, fontWeight: 700 }}>{t.tagNumber}</TableCell>
                            <TableCell sx={cellSx}>{t.name}</TableCell>
                            <TableCell sx={cellSx}>{t.category?.name ?? ''}</TableCell>
                            <TableCell sx={cellSx}>{[t.metalType, t.metalKarat].filter(Boolean).join(' ')}</TableCell>
                            <TableCell sx={{ ...cellSx, ...mono }}>{t.huid ?? ''}</TableCell>
                            <TableCell align="right" sx={{ ...cellSx, ...mono }}>{fmtWt(num(t.grossWeight))}</TableCell>
                            <TableCell align="right" sx={{ ...cellSx, ...mono }}>{fmtWt(num(t.stoneWeight))}</TableCell>
                            <TableCell align="right" sx={{ ...cellSx, ...mono }}>{fmtWt(num(t.netWeight))}</TableCell>
                            <TableCell align="right" sx={{ ...cellSx, ...mono }}>{fmtMoney(num(t.sellingPrice))}</TableCell>
                            <TableCell sx={cellSx}>
                              {isDone
                                ? <Chip size="small" color="success" label={`Received ${fmtDate(i.receivedAt)}`} />
                                : isVerified
                                  ? <Chip size="small" color="info" label="Verified" />
                                  : <Chip size="small" label="In transit" />}
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                    <TableFooter>
                      <TableRow>
                        <TableCell colSpan={canReceive ? 7 : 6} sx={{ fontWeight: 700 }}>
                          {items.length} piece{items.length === 1 ? '' : 's'}
                        </TableCell>
                        <TableCell align="right" sx={{ fontWeight: 700, ...mono }}>{fmtWt(sumWt(items, 'grossWeight'))}</TableCell>
                        <TableCell align="right" sx={{ fontWeight: 700, ...mono }}>{fmtWt(sumWt(items, 'stoneWeight'))}</TableCell>
                        <TableCell align="right" sx={{ fontWeight: 700, ...mono }}>{fmtWt(sumWt(items, 'netWeight'))}</TableCell>
                        <TableCell align="right" sx={{ fontWeight: 700, ...mono }}>{fmtMoney(sumWt(items, 'sellingPrice'))}</TableCell>
                        <TableCell />
                      </TableRow>
                    </TableFooter>
                  </Table>
                </Box>
              </Box>
            )}
          </Box>
        </Box>

        <Stack direction="row" alignItems="center" justifyContent="space-between" spacing={2}
          sx={{ px: 2, py: 1, borderTop: 1, borderColor: 'divider', bgcolor: 'action.hover' }}>
          <Typography variant="body2" color="text.secondary">
            {canReceive
              ? `${verifiedItems.length} verified · Gross ${fmtWt(sumWt(verifiedItems, 'grossWeight'))} g${verifiedItems.length === 0 ? ' · verify at least one item to receive' : ''}`
              : `${received.length} of ${items.length} received`}
          </Typography>
          <Stack direction="row" spacing={1}>
            {canReceive && (
              <Button variant="contained" disabled={verifiedItems.length === 0 || mutation.isPending} onClick={startReceive}>
                Receive Verified ({verifiedItems.length})
              </Button>
            )}
            <Button variant="outlined" onClick={back}>Close</Button>
          </Stack>
        </Stack>
      </Card>

      <Dialog open={confirmOpen} onClose={() => setConfirmOpen(false)}>
        <DialogTitle>Receive only the verified items?</DialogTitle>
        <DialogContent>
          <DialogContentText>
            {verifiedItems.length} verified item{verifiedItems.length === 1 ? '' : 's'} will be taken into {tr.toBranch?.name}.
            The other {unverifiedCount} stay in transit and this transfer becomes “Partly Received” until they are verified and received.
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirmOpen(false)}>Keep verifying</Button>
          <Button variant="contained" disabled={mutation.isPending} onClick={() => mutation.mutate()}>Receive verified</Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
