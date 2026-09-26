import { useState } from 'react';
import { Box, Card, Table, TableHead, TableBody, TableRow, TableCell, Typography, Button, Grid, Chip, MenuItem, TextField, Alert } from '@mui/material';
import { Add } from '@mui/icons-material';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm, Controller } from 'react-hook-form';
import { useSnackbar } from 'notistack';
import { apiGet, apiPost } from '../../api/client';
import { PageHeader } from '../../components/common/PageHeader';

export function KarigarLedger() {
  const { enqueueSnackbar } = useSnackbar();
  const qc = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [selectedArtisan, setSelectedArtisan] = useState<string>('');

  const { data: artisans } = useQuery({ queryKey: ['artisans'], queryFn: () => apiGet<any[]>('/outsourcing/artisans') });
  const { data: ledger } = useQuery({ queryKey: ['karigar-ledger', selectedArtisan], queryFn: () => selectedArtisan ? apiGet<any>(`/outsourcing/artisans/${selectedArtisan}/ledger`) : null, enabled: !!selectedArtisan });

  const { control, handleSubmit, reset } = useForm({ defaultValues: { name: '', type: 'EXTERNAL', specializations: [], phone: '' } });

  const createMutation = useMutation({
    mutationFn: (data: any) => apiPost('/outsourcing/artisans', data),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['artisans'] }); setCreateOpen(false); reset(); enqueueSnackbar('Artisan registered', { variant: 'success' }); },
  });

  const selected = (artisans ?? []).find((a: any) => a.id === selectedArtisan);

  return (
    <Box>
      <PageHeader title="Karigar Metal Balance Ledger"
        actions={[{ label: 'Register Artisan', icon: <Add />, onClick: () => setCreateOpen(true) }]} />

      <Grid container spacing={2}>
        {/* Artisan List */}
        <Grid item xs={12} md={3}>
          <Card>
            <Box sx={{ p: 1.5, borderBottom: 1, borderColor: 'divider' }}>
              <Typography variant="subtitle2" fontWeight={700}>Artisans / Karigars</Typography>
            </Box>
            {(artisans ?? []).map((a: any) => (
              <Box key={a.id} onClick={() => setSelectedArtisan(a.id)} sx={{ p: 1.5, cursor: 'pointer', bgcolor: selectedArtisan === a.id ? '#FFF8E7' : 'transparent', borderBottom: '1px solid #F5F5F5', '&:hover': { bgcolor: '#FAFAF0' } }}>
                <Typography variant="body2" fontWeight={700}>{a.name}</Typography>
                <Typography variant="caption" color="text.secondary">{a.artisanCode} · {a.type}</Typography>
                <Box sx={{ mt: 0.5 }}>
                  <Typography variant="caption" sx={{ color: Number(a.metalBalance) > 0 ? 'error.main' : 'success.main', fontFamily: 'monospace', fontWeight: 700 }}>
                    Balance: {Number(a.metalBalance).toFixed(4)}g
                  </Typography>
                </Box>
              </Box>
            ))}
          </Card>
        </Grid>

        {/* Ledger */}
        <Grid item xs={12} md={9}>
          {!selectedArtisan ? (
            <Card sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 300 }}>
              <Typography color="text.secondary">Select an artisan to view their ledger</Typography>
            </Card>
          ) : (
            <Card>
              <Box sx={{ p: 2, borderBottom: 1, borderColor: 'divider', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <Box>
                  <Typography variant="subtitle1" fontWeight={700}>{selected?.name}</Typography>
                  <Typography variant="caption" color="text.secondary">{selected?.artisanCode} · Specializations: {selected?.specializations?.join(', ') ?? '—'}</Typography>
                </Box>
                <Chip label={`Balance: ${Number(selected?.metalBalance ?? 0).toFixed(4)}g`}
                  color={Number(selected?.metalBalance ?? 0) > 0 ? 'error' : 'success'} sx={{ fontFamily: 'monospace', fontWeight: 700 }} />
              </Box>
              <Box sx={{ overflowX: 'auto' }}>
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>Date</TableCell><TableCell>Type</TableCell><TableCell>Metal</TableCell>
                    <TableCell align="right">Issued (g)</TableCell><TableCell align="right">Returned (g)</TableCell>
                    <TableCell align="right">Scrap (g)</TableCell><TableCell align="right">Loss %</TableCell>
                    <TableCell align="right">Balance (g)</TableCell><TableCell>Job Card</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {(ledger?.ledgerEntries ?? []).map((entry: any) => (
                    <TableRow key={entry.id} hover>
                      <TableCell sx={{ fontSize: 12 }}>{new Date(entry.date).toLocaleDateString('en-IN')}</TableCell>
                      <TableCell><Chip label={entry.transactionType} size="small" color={entry.transactionType === 'ISSUE' ? 'warning' : 'success'} /></TableCell>
                      <TableCell>{entry.metalType} {entry.karat ?? ''}</TableCell>
                      <TableCell align="right" sx={{ fontFamily: 'monospace', color: 'warning.main' }}>{Number(entry.issuedWeight).toFixed(4)}</TableCell>
                      <TableCell align="right" sx={{ fontFamily: 'monospace', color: 'success.main' }}>{Number(entry.returnedWeight).toFixed(4)}</TableCell>
                      <TableCell align="right" sx={{ fontFamily: 'monospace' }}>{Number(entry.scrapWeight).toFixed(4)}</TableCell>
                      <TableCell align="right" sx={{ fontFamily: 'monospace', color: Number(entry.lossPercent) > 3 ? 'error.main' : 'inherit' }}>{Number(entry.lossPercent).toFixed(2)}%</TableCell>
                      <TableCell align="right" sx={{ fontFamily: 'monospace', fontWeight: 700 }}>{Number(entry.balanceAfter).toFixed(4)}</TableCell>
                      <TableCell sx={{ fontSize: 11, fontFamily: 'monospace' }}>{entry.jobCardRef ?? '—'}</TableCell>
                    </TableRow>
                  ))}
                  {(ledger?.ledgerEntries ?? []).length === 0 && (
                    <TableRow><TableCell colSpan={9} align="center" sx={{ py: 3 }}>No transactions</TableCell></TableRow>
                  )}
                </TableBody>
              </Table>
              </Box>
            </Card>
          )}
        </Grid>
      </Grid>
    </Box>
  );
}
