import { useEffect, useState } from 'react';
import { Box, Card, CardContent, TextField, Button, Table, TableHead, TableBody, TableRow, TableCell, Typography, Stack, Alert } from '@mui/material';
import { Edit } from '@mui/icons-material';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useSnackbar } from 'notistack';
import { apiGet, apiPost } from '../../api/client';
import { PageHeader } from '../../components/common/PageHeader';
import { useAuthStore } from '../../store/auth.store';

const todayStr = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const fmt = (n: any) => `₹${Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;

// One date, every purity: pick a date, see each karat's rate saved for exactly that date, edit any of
// them in the table and save the lot at once. Rates stay per date (a save only touches the chosen
// date); GET /designs/rates/latest — what New Sale / New Tag / Old Gold read — is unchanged.
export function MetalRates() {
  const { enqueueSnackbar } = useSnackbar();
  const qc = useQueryClient();
  // Entering rates is its own grant (rate:update); the server refuses everyone else regardless of this button.
  const canUpdateRates = useAuthStore((s) => s.hasPermission('rate:update'));
  const [date, setDate] = useState(todayStr());
  const [source, setSource] = useState('MANUAL');
  // Edit mode: one switch opens every purity. karat -> typed value (pre-filled with the stored rate).
  const [editing, setEditing] = useState(false);
  const [edits, setEdits] = useState<Record<string, string>>({});
  // OG = Old Gold buying rate, same shape as `edits` (karat -> typed value).
  const [ogEdits, setOgEdits] = useState<Record<string, string>>({});

  const { data: rows, isLoading } = useQuery({
    queryKey: ['metal-rate-sheet', date],
    queryFn: () => apiGet<any[]>('/designs/rates/sheet', { date }),
    enabled: !!date,
  });
  const sheet: any[] = (rows as any)?.data ?? rows ?? [];

  // A different date (or a fresh save) starts from what is stored — drop any half-typed edits.
  useEffect(() => { setEdits({}); setOgEdits({}); setEditing(false); }, [date]);

  const startEdit = () => {
    const own = sheet.filter((r) => !r.isDerived);
    setEdits(Object.fromEntries(own.map((r) => [r.karat, r.ratePerGram != null ? String(Number(r.ratePerGram)) : ''])));
    setOgEdits(Object.fromEntries(own.map((r) => [r.karat, r.ogRatePerGram != null ? String(Number(r.ogRatePerGram)) : ''])));
    setEditing(true);
  };
  const cancelEdit = () => { setEdits({}); setOgEdits({}); setEditing(false); };

  // A row is dirty when its rate or its OG rate differs from what is stored. A row's rate is always sent
  // (the server needs it); a blank OG field means "no OG rate" and is sent as null so it can be cleared.
  // Calculated (derived) gold rows are never edited or sent — the server recomputes them from the 24K
  // rates. While editing, they show a live preview of what the save will produce (display only).
  const base = sheet.find((r) => !r.isDerived && r.karat === '24K');
  const preview = (r: any, edited: Record<string, string>, stored: any) => {
    const typed = edited[r.metalType === 'SILVER' ? '999' : '24K'];
    const b = typed !== undefined && typed !== '' ? Number(typed) : null;
    if (b == null || !(b > 0)) return stored;
    return Math.round(b * Number(r.purity) / 0.999 * 100) / 100;
  };
  const dirty = sheet.filter((r) => !r.isDerived).filter((r) => {
    const v = edits[r.karat] ?? '';
    const og = ogEdits[r.karat] ?? '';
    const rateChanged = v !== '' && Number(v) !== (r.ratePerGram == null ? NaN : Number(r.ratePerGram));
    const ogChanged = (og === '' ? null : Number(og)) !== (r.ogRatePerGram == null ? null : Number(r.ogRatePerGram));
    return rateChanged || ogChanged;
  }).map((r) => r.karat as string);
  // Rate must be positive when given, and a row needs a rate (typed or already stored) before an OG rate can ride on it.
  const invalid = dirty.some((karat) => {
    const r = sheet.find((x) => x.karat === karat);
    const v = edits[karat] ?? '';
    const og = ogEdits[karat] ?? '';
    const effectiveRate = v !== '' ? Number(v) : (r?.ratePerGram != null ? Number(r.ratePerGram) : NaN);
    return !(effectiveRate > 0) || (og !== '' && !(Number(og) > 0));
  });

  const mutation = useMutation({
    mutationFn: () => apiPost('/designs/rates/batch', {
      date, source,
      rates: dirty.map((karat) => {
        const r = sheet.find((x) => x.karat === karat);
        const v = edits[karat] ?? '';
        const og = ogEdits[karat] ?? '';
        return {
          karat,
          ratePerGram: v !== '' ? Number(v) : Number(r.ratePerGram),
          ogRatePerGram: og === '' ? null : Number(og),
        };
      }),
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['metal-rate-sheet'] });
      qc.invalidateQueries({ queryKey: ['metal-rates'] });
      setEdits({}); setOgEdits({}); setEditing(false);
      enqueueSnackbar('Rates saved', { variant: 'success' });
    },
    onError: (e: any) => enqueueSnackbar(e.response?.data?.error ?? 'Failed to save rates', { variant: 'error' }),
  });

  return (
    <Box>
      <PageHeader title="Daily Metal Rates" />

      <Card>
        <CardContent>
          <Stack direction="row" spacing={2} alignItems="center" sx={{ mb: 2 }} flexWrap="wrap" useFlexGap>
            <TextField label="Date" type="date" size="small" value={date}
              onChange={(e) => e.target.value && setDate(e.target.value)} InputLabelProps={{ shrink: true }} />
            <TextField select size="small" label="Source" value={source} onChange={(e) => setSource(e.target.value)}
              SelectProps={{ native: true }} InputLabelProps={{ shrink: true }} sx={{ minWidth: 150 }}>
              <option value="MANUAL">Manual Entry</option>
              <option value="MCX">MCX Exchange</option>
              <option value="IBJA">IBJA Rate</option>
              <option value="API">API Feed</option>
            </TextField>
            <Box sx={{ flex: 1 }} />
            {!canUpdateRates ? null : !editing ? (
              <Button variant="outlined" startIcon={<Edit />} onClick={startEdit} disabled={isLoading || sheet.length === 0}>Edit</Button>
            ) : (
              <>
                <Button onClick={cancelEdit} disabled={mutation.isPending}>Cancel</Button>
                <Button variant="contained" disabled={invalid || mutation.isPending}
                  onClick={() => (dirty.length ? mutation.mutate() : cancelEdit())}>
                  {mutation.isPending ? 'Saving...' : `Save Changes${dirty.length ? ` (${dirty.length})` : ''}`}
                </Button>
              </>
            )}
          </Stack>

          {!isLoading && sheet.length > 0 && sheet.every((r) => r.ratePerGram == null) && (
            <Alert severity="info" sx={{ mb: 2 }}>
              No rates saved for this date yet. Click Edit to enter them — the greyed hint is the latest earlier rate.
            </Alert>
          )}

          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Purity</TableCell>
                <TableCell align="right">Rate / Gram (₹)</TableCell>
                <TableCell align="right">OG Rate / Gram (₹)</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {sheet.map((r) => {
                return (
                  <TableRow key={r.karat} hover>
                    <TableCell sx={{ fontWeight: 700 }}>
                      {r.karat}
                      <Typography component="span" variant="caption" color="text.secondary" sx={{ ml: 1, fontFamily: 'monospace' }}>
                        {(Number(r.purity) * 100).toFixed(2)}%
                      </Typography>
                      {r.metalType === 'SILVER' && !r.isDerived && (
                        <Typography variant="caption" color="text.secondary" display="block" fontWeight={400}>
                          Silver 999 base: Rate column = Silver 999 · OG column = Old Silver 999
                        </Typography>
                      )}
                      {r.isDerived && <Typography component="span" variant="caption" color="text.secondary" sx={{ ml: 1 }}>calculated</Typography>}
                    </TableCell>
                    <TableCell align="right" sx={{ fontFamily: 'monospace' }}>
                      {editing && r.isDerived ? (
                        <Typography component="span" color="text.secondary" fontFamily="monospace" title={r.metalType === 'SILVER' ? 'Calculated from the Silver 999 rate' : 'Calculated from the 24K rate'}>
                          {preview(r, edits, r.ratePerGram) != null ? fmt(preview(r, edits, r.ratePerGram)) : '—'}
                        </Typography>
                      ) : editing ? (
                        <TextField size="small" type="number" autoFocus={r.karat === base?.karat} value={edits[r.karat] ?? ''}
                          placeholder={r.previousRate != null ? String(Number(r.previousRate)) : ''}
                          onChange={(e) => setEdits((p) => ({ ...p, [r.karat]: e.target.value }))}
                          onWheel={(e) => (e.target as HTMLInputElement).blur()}
                          onKeyDown={(e) => { if (e.key === 'Escape') cancelEdit(); }}
                          inputProps={{ step: 0.01, min: 0, style: { textAlign: 'right', width: 120 } }} />
                      ) : r.ratePerGram != null ? (
                        <Typography component="span" fontWeight={700} color="#44C47A" fontSize={15} fontFamily="monospace">{fmt(r.ratePerGram)}</Typography>
                      ) : (
                        <Typography component="span" color="text.disabled" fontFamily="monospace">
                          — {r.previousRate != null && `(last ${fmt(r.previousRate)})`}
                        </Typography>
                      )}
                    </TableCell>
                    <TableCell align="right" sx={{ fontFamily: 'monospace' }}>
                      {editing && r.isDerived ? (
                        <Typography component="span" color="text.secondary" fontFamily="monospace" title={r.metalType === 'SILVER' ? 'Calculated from the Old Silver 999 rate' : 'Calculated from the 24K old gold rate'}>
                          {preview(r, ogEdits, r.ogRatePerGram) != null ? fmt(preview(r, ogEdits, r.ogRatePerGram)) : '—'}
                        </Typography>
                      ) : editing ? (
                        <TextField size="small" type="number" value={ogEdits[r.karat] ?? ''}
                          placeholder={r.previousOgRate != null ? String(Number(r.previousOgRate)) : ''}
                          onChange={(e) => setOgEdits((p) => ({ ...p, [r.karat]: e.target.value }))}
                          onWheel={(e) => (e.target as HTMLInputElement).blur()}
                          onKeyDown={(e) => { if (e.key === 'Escape') cancelEdit(); }}
                          inputProps={{ step: 0.01, min: 0, style: { textAlign: 'right', width: 120 } }} />
                      ) : r.ogRatePerGram != null ? (
                        <Typography component="span" fontWeight={700} color="#B26A00" fontSize={15} fontFamily="monospace">{fmt(r.ogRatePerGram)}</Typography>
                      ) : (
                        <Typography component="span" color="text.disabled" fontFamily="monospace">
                          — {r.previousOgRate != null && `(last ${fmt(r.previousOgRate)})`}
                        </Typography>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
              {!isLoading && sheet.length === 0 && (
                <TableRow><TableCell colSpan={3} align="center">No purities configured — add them under Masters → Karats.</TableCell></TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </Box>
  );
}
