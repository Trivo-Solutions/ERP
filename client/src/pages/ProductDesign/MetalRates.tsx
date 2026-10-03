import { useEffect, useState } from 'react';
import { Box, Card, CardContent, TextField, Button, Table, TableHead, TableBody, TableRow, TableCell, Typography, Stack, Alert } from '@mui/material';
import { Edit } from '@mui/icons-material';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useSnackbar } from 'notistack';
import { apiGet, apiPost } from '../../api/client';
import { PageHeader } from '../../components/common/PageHeader';

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
  const [date, setDate] = useState(todayStr());
  const [source, setSource] = useState('MANUAL');
  // Edit mode: one switch opens every purity. karat -> typed value (pre-filled with the stored rate).
  const [editing, setEditing] = useState(false);
  const [edits, setEdits] = useState<Record<string, string>>({});

  const { data: rows, isLoading } = useQuery({
    queryKey: ['metal-rate-sheet', date],
    queryFn: () => apiGet<any[]>('/designs/rates/sheet', { date }),
    enabled: !!date,
  });
  const sheet: any[] = (rows as any)?.data ?? rows ?? [];

  // A different date (or a fresh save) starts from what is stored — drop any half-typed edits.
  useEffect(() => { setEdits({}); setEditing(false); }, [date]);

  const startEdit = () => {
    setEdits(Object.fromEntries(sheet.map((r) => [r.karat, r.ratePerGram != null ? String(Number(r.ratePerGram)) : ''])));
    setEditing(true);
  };
  const cancelEdit = () => { setEdits({}); setEditing(false); };

  const dirty = Object.entries(edits).filter(([karat, v]) => {
    const cur = sheet.find((r) => r.karat === karat)?.ratePerGram;
    return v !== '' && Number(v) !== (cur == null ? NaN : Number(cur));
  });
  const invalid = dirty.some(([, v]) => !(Number(v) > 0));

  const mutation = useMutation({
    mutationFn: () => apiPost('/designs/rates/batch', {
      date, source,
      rates: dirty.map(([karat, v]) => ({ karat, ratePerGram: Number(v) })),
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['metal-rate-sheet'] });
      qc.invalidateQueries({ queryKey: ['metal-rates'] });
      setEdits({}); setEditing(false);
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
            {!editing ? (
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
                    </TableCell>
                    <TableCell align="right" sx={{ fontFamily: 'monospace' }}>
                      {editing ? (
                        <TextField size="small" type="number" autoFocus value={edits[r.karat]}
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
                  </TableRow>
                );
              })}
              {!isLoading && sheet.length === 0 && (
                <TableRow><TableCell colSpan={2} align="center">No purities configured — add them under Masters → Karats.</TableCell></TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </Box>
  );
}
