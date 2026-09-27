import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Box, Card, Typography, Button, Stack, TextField, Tabs, Tab, Autocomplete, IconButton,
  Table, TableHead, TableBody, TableRow, TableCell, TableFooter, Divider,
} from '@mui/material';
import { Delete, ArrowBack } from '@mui/icons-material';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useSnackbar } from 'notistack';
import { apiGet, apiPost } from '../../api/client';
import { PageHeader } from '../../components/common/PageHeader';
import { SelectField } from '../../components/fields/SelectField';

// A new branch transfer as a full page (was a dialog on BranchTransfersPage). Two tabs, laid out
// after the reference screens: "Jewelry Detail" (who → who, remarks, category overview, summary)
// and "Items Detail" (the tag grid). No "Term Detail" tab — a transfer is internal stock movement,
// with no payment terms to capture (confirmed with the user).

const num = (v: unknown) => Number(v ?? 0) || 0;
const fmtWt = (v: number) => v.toFixed(3);
const fmtMoney = (v: number) => v.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const labelSx = { fontSize: 12, color: 'text.secondary' };
const cellSx = { py: 0.5, whiteSpace: 'nowrap' } as const;

export function NewBranchTransferPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { enqueueSnackbar } = useSnackbar();

  const [activeTab, setActiveTab] = useState(0);
  const [fromBranchId, setFromBranchId] = useState('');
  const [toBranchId, setToBranchId] = useState('');
  const [notes, setNotes] = useState('');
  const [tags, setTags] = useState<any[]>([]);
  const [tagSearch, setTagSearch] = useState('');

  const today = useMemo(() => new Date().toLocaleDateString('en-IN'), []);

  const { data: branchData } = useQuery({
    queryKey: ['branches'],
    queryFn: () => apiGet<any>('/tagging/branches'),
  });
  const branches: any[] = (branchData as any)?.data ?? branchData ?? [];
  const branchName = (id: string) => branches.find((b) => b.id === id)?.name ?? '';

  const { data: tagResults } = useQuery({
    queryKey: ['tag-search', tagSearch, fromBranchId],
    queryFn: () => apiGet<any>('/tagging/tags/search', { q: tagSearch, branchId: fromBranchId, status: 'IN_STOCK' }),
    enabled: tagSearch.length >= 1 && !!fromBranchId,
  });
  const searchOptions: any[] = ((tagResults as any)?.data ?? tagResults ?? [])
    .filter((o: any) => !tags.some((t) => t.id === o.id));

  const totals = useMemo(() => tags.reduce((acc, t) => ({
    pieces: acc.pieces + 1,
    gross: acc.gross + num(t.grossWeight),
    stone: acc.stone + num(t.stoneWeight),
    net: acc.net + num(t.netWeight),
    value: acc.value + num(t.sellingPrice),
  }), { pieces: 0, gross: 0, stone: 0, net: 0, value: 0 }), [tags]);

  // Category overview — same grouping the reference shows, computed from the picked tags.
  const categoryRows = useMemo(() => {
    const map = new Map<string, { name: string; qty: number; gross: number }>();
    for (const t of tags) {
      const name = t.category?.name ?? 'Uncategorised';
      const row = map.get(name) ?? { name, qty: 0, gross: 0 };
      row.qty += 1;
      row.gross += num(t.grossWeight);
      map.set(name, row);
    }
    return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [tags]);

  const mutation = useMutation({
    mutationFn: () => apiPost<any>('/tagging/transfers', {
      fromBranchId, toBranchId, notes: notes.trim() || undefined, tagIds: tags.map((t) => t.id),
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['branch-transfers'] });
      enqueueSnackbar('Transfer created', { variant: 'success' });
      navigate('/tagging/transfers');
    },
    onError: (e: any) => enqueueSnackbar(e.response?.data?.error ?? 'Failed', { variant: 'error' }),
  });

  const changeFrom = (id: string) => {
    if (id === fromBranchId) return;
    setFromBranchId(id);
    if (id === toBranchId) setToBranchId('');
    // Picked tags belong to the old source branch — they can't ride along.
    if (tags.length) {
      setTags([]);
      enqueueSnackbar('Source branch changed — item list cleared', { variant: 'info' });
    }
  };

  const canSave = !!fromBranchId && !!toBranchId && fromBranchId !== toBranchId && tags.length > 0;
  const branchOptions = (exclude?: string) => branches
    .filter((b) => b.id !== exclude)
    .map((b) => ({ value: b.id, label: b.name }));

  const cancel = () => navigate('/tagging/transfers');

  return (
    <Box>
      <PageHeader title="New Branch Transfer" />

      <Card sx={{ p: 0 }}>
        {/* Header strip: who → who, and the number the server assigns on save */}
        <Stack direction="row" justifyContent="space-between" sx={{ px: 2, py: 1, bgcolor: 'action.hover', borderBottom: 1, borderColor: 'divider' }}>
          <Typography variant="body2" fontWeight={700}>
            Name : <Box component="span" fontWeight={500}>
              {fromBranchId || toBranchId ? `${branchName(fromBranchId) || '—'} → ${branchName(toBranchId) || '—'}` : '—'}
            </Box>
          </Typography>
          <Typography variant="body2" fontWeight={700}>
            No : <Box component="span" fontWeight={500} color="text.secondary">Assigned on save</Box>
          </Typography>
        </Stack>

        <Box sx={{ display: 'flex', minHeight: 520 }}>
          {/* Vertical tabs, as in the reference */}
          <Box sx={{ width: 200, flexShrink: 0, borderRight: 1, borderColor: 'divider', display: 'flex', flexDirection: 'column' }}>
            <Tabs orientation="vertical" value={activeTab} onChange={(_, v) => setActiveTab(v)}
              sx={{ '& .MuiTab-root': { alignItems: 'flex-start', textAlign: 'left', textTransform: 'none', fontWeight: 600 } }}>
              <Tab label="Jewelry Detail" />
              <Tab label={`Items Detail${tags.length ? ` (${tags.length})` : ''}`} />
            </Tabs>
            <Box sx={{ mt: 'auto', p: 1.5 }}>
              <Button fullWidth size="small" variant="outlined" startIcon={<ArrowBack />} onClick={cancel}>
                Back to Transfers
              </Button>
            </Box>
          </Box>

          <Box sx={{ flex: 1, minWidth: 0, p: 2, display: 'flex', flexDirection: 'column' }}>
            {/* ── Tab 1: Jewelry Detail ── */}
            {activeTab === 0 && (
              <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', lg: 'minmax(0, 1.2fr) minmax(0, 1fr)' }, gap: 3, alignItems: 'start' }}>
                <Stack spacing={2}>
                  <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 1.5 }}>
                    <TextField label="Transaction Date" value={today} size="small" InputProps={{ readOnly: true }}
                      InputLabelProps={{ shrink: true }} />
                    <TextField label="Transaction No" value="Assigned on save" size="small" InputProps={{ readOnly: true }}
                      InputLabelProps={{ shrink: true }} />
                    <SelectField size="small" label="From Branch *" value={fromBranchId} autoFocus
                      emptyLabel="Select branch…" options={branchOptions()}
                      onChange={(e) => changeFrom(e.target.value)} />
                    <SelectField size="small" label="To Branch *" value={toBranchId} disabled={!fromBranchId}
                      emptyLabel="Select branch…" options={branchOptions(fromBranchId)}
                      onChange={(e) => setToBranchId(e.target.value)} />
                    <TextField label="Remarks" value={notes} onChange={(e) => setNotes(e.target.value)}
                      multiline minRows={3} size="small" InputLabelProps={{ shrink: true }}
                      sx={{ gridColumn: '1 / -1' }} />
                  </Box>

                  <Box>
                    <Typography sx={{ fontWeight: 700, color: 'primary.main', mb: 0.5 }}>Category Overview</Typography>
                    <Box sx={{ border: 1, borderColor: 'divider', overflowX: 'auto' }}>
                      <Table size="small">
                        <TableHead>
                          <TableRow>
                            <TableCell>Category</TableCell>
                            <TableCell align="right">Qty</TableCell>
                            <TableCell align="right">Gross Wt</TableCell>
                          </TableRow>
                        </TableHead>
                        <TableBody>
                          {categoryRows.map((r) => (
                            <TableRow key={r.name}>
                              <TableCell sx={cellSx}>{r.name}</TableCell>
                              <TableCell align="right" sx={cellSx}>{r.qty}</TableCell>
                              <TableCell align="right" sx={{ ...cellSx, fontFamily: 'monospace' }}>{fmtWt(r.gross)}</TableCell>
                            </TableRow>
                          ))}
                          {categoryRows.length === 0 && (
                            <TableRow>
                              <TableCell colSpan={3} align="center" sx={{ py: 3, color: 'text.secondary' }}>
                                No items yet — add them on the Items Detail tab
                              </TableCell>
                            </TableRow>
                          )}
                        </TableBody>
                      </Table>
                    </Box>
                  </Box>
                </Stack>

                {/* Summary */}
                <Box sx={{ border: 1, borderColor: 'divider' }}>
                  <Stack direction="row" alignItems="baseline" spacing={2} sx={{ px: 2, py: 1, bgcolor: 'action.hover' }}>
                    <Typography variant="h6" fontWeight={700}>Summary</Typography>
                    <Typography variant="body2" fontWeight={700} sx={{ px: 1, bgcolor: 'action.selected', borderRadius: 0.5 }}>
                      Gross Wt : {fmtWt(totals.gross)}
                    </Typography>
                  </Stack>
                  <Table size="small">
                    <TableHead>
                      <TableRow>
                        <TableCell>Caption</TableCell>
                        <TableCell align="right">Pieces</TableCell>
                        <TableCell align="right">Weight</TableCell>
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      <TableRow>
                        <TableCell sx={{ fontWeight: 700, color: 'success.main' }}>Jewellery</TableCell>
                        <TableCell align="right">{totals.pieces}</TableCell>
                        <TableCell align="right" sx={{ fontFamily: 'monospace' }}>{fmtWt(totals.gross)}</TableCell>
                      </TableRow>
                      <TableRow>
                        <TableCell sx={labelSx}>Stone Wt</TableCell>
                        <TableCell />
                        <TableCell align="right" sx={{ fontFamily: 'monospace' }}>{fmtWt(totals.stone)}</TableCell>
                      </TableRow>
                      <TableRow>
                        <TableCell sx={labelSx}>Net Wt</TableCell>
                        <TableCell />
                        <TableCell align="right" sx={{ fontFamily: 'monospace' }}>{fmtWt(totals.net)}</TableCell>
                      </TableRow>
                    </TableBody>
                  </Table>
                  <Divider />
                  <Stack direction="row" justifyContent="space-between" sx={{ px: 2, py: 1.5 }}>
                    <Typography sx={{ fontWeight: 700, color: 'warning.main' }}>Stock Value (at selling price)</Typography>
                    <Typography sx={{ fontFamily: 'monospace', fontWeight: 700 }}>₹{fmtMoney(totals.value)}</Typography>
                  </Stack>
                </Box>
              </Box>
            )}

            {/* ── Tab 2: Items Detail ── */}
            {activeTab === 1 && (
              <Box sx={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
                <Autocomplete
                  sx={{ maxWidth: 520, mb: 1.5 }}
                  size="small"
                  disabled={!fromBranchId}
                  autoHighlight
                  value={null}
                  inputValue={tagSearch}
                  options={searchOptions}
                  getOptionLabel={(o) => `${o.tagNumber} — ${o.name}`}
                  filterOptions={(x) => x}
                  onInputChange={(_, v, reason) => setTagSearch(reason === 'reset' ? '' : v)}
                  onChange={(_, val) => { if (val) { setTags((p) => [...p, val]); setTagSearch(''); } }}
                  renderInput={(params) => (
                    <TextField {...params} label="Item"
                      placeholder={fromBranchId ? 'Scan or type tag number / name / HUID' : 'Select the source branch first'}
                      InputLabelProps={{ shrink: true }} />
                  )}
                  noOptionsText={tagSearch.length < 1 ? 'Type to search' : 'No IN_STOCK tag found at the source branch'}
                />

                <Box sx={{ border: 1, borderColor: 'divider', overflow: 'auto', flex: 1 }}>
                  <Table size="small" stickyHeader>
                    <TableHead>
                      <TableRow>
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
                        <TableCell />
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {tags.map((t, i) => (
                        <TableRow key={t.id} hover>
                          <TableCell sx={cellSx}>{i + 1}</TableCell>
                          <TableCell sx={{ ...cellSx, fontFamily: 'monospace', fontWeight: 700 }}>{t.tagNumber}</TableCell>
                          <TableCell sx={cellSx}>{t.name}</TableCell>
                          <TableCell sx={cellSx}>{t.category?.name ?? ''}</TableCell>
                          <TableCell sx={cellSx}>{[t.metalType, t.metalKarat].filter(Boolean).join(' ')}</TableCell>
                          <TableCell sx={{ ...cellSx, fontFamily: 'monospace' }}>{t.huid ?? ''}</TableCell>
                          <TableCell align="right" sx={{ ...cellSx, fontFamily: 'monospace' }}>{fmtWt(num(t.grossWeight))}</TableCell>
                          <TableCell align="right" sx={{ ...cellSx, fontFamily: 'monospace' }}>{fmtWt(num(t.stoneWeight))}</TableCell>
                          <TableCell align="right" sx={{ ...cellSx, fontFamily: 'monospace' }}>{fmtWt(num(t.netWeight))}</TableCell>
                          <TableCell align="right" sx={{ ...cellSx, fontFamily: 'monospace' }}>{fmtMoney(num(t.sellingPrice))}</TableCell>
                          <TableCell align="right" sx={{ py: 0 }}>
                            <IconButton size="small" aria-label={`Remove ${t.tagNumber}`}
                              onClick={() => setTags((p) => p.filter((x) => x.id !== t.id))}>
                              <Delete fontSize="small" />
                            </IconButton>
                          </TableCell>
                        </TableRow>
                      ))}
                      {tags.length === 0 && (
                        <TableRow>
                          <TableCell colSpan={11} align="center" sx={{ py: 6, color: 'text.secondary' }}>
                            {fromBranchId ? 'No items added yet' : 'Choose a source branch on Jewelry Detail, then add items here'}
                          </TableCell>
                        </TableRow>
                      )}
                    </TableBody>
                    <TableFooter>
                      <TableRow>
                        <TableCell colSpan={6} sx={{ fontWeight: 700 }}>{totals.pieces} piece{totals.pieces === 1 ? '' : 's'}</TableCell>
                        <TableCell align="right" sx={{ fontWeight: 700, fontFamily: 'monospace' }}>{fmtWt(totals.gross)}</TableCell>
                        <TableCell align="right" sx={{ fontWeight: 700, fontFamily: 'monospace' }}>{fmtWt(totals.stone)}</TableCell>
                        <TableCell align="right" sx={{ fontWeight: 700, fontFamily: 'monospace' }}>{fmtWt(totals.net)}</TableCell>
                        <TableCell align="right" sx={{ fontWeight: 700, fontFamily: 'monospace' }}>{fmtMoney(totals.value)}</TableCell>
                        <TableCell />
                      </TableRow>
                    </TableFooter>
                  </Table>
                </Box>
              </Box>
            )}
          </Box>
        </Box>

        {/* Footer: totals on the left, Save / Cancel on the right */}
        <Stack direction="row" alignItems="center" justifyContent="space-between" spacing={2}
          sx={{ px: 2, py: 1, borderTop: 1, borderColor: 'divider', bgcolor: 'action.hover' }}>
          <Typography variant="body2" color="text.secondary">
            {tags.length} piece{tags.length === 1 ? '' : 's'} · Gross {fmtWt(totals.gross)} g
            {!canSave && ' · pick both branches and at least one item to save'}
          </Typography>
          <Stack direction="row" spacing={1}>
            <Button variant="contained" disabled={!canSave || mutation.isPending} onClick={() => mutation.mutate()}>
              Save
            </Button>
            <Button variant="outlined" onClick={cancel}>Cancel</Button>
          </Stack>
        </Stack>
      </Card>
    </Box>
  );
}
