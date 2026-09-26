import { useState } from 'react';
import {
  Box, Card, Table, TableHead, TableBody, TableRow, TableCell,
  Typography, Chip, Button, MenuItem, TextField, Grid, Alert,
} from '@mui/material';
import { LockOpen } from '@mui/icons-material';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useSnackbar } from 'notistack';
import { apiGet, apiPatch } from '../../api/client';
import { PageHeader } from '../../components/common/PageHeader';
import { StatusChip } from '../../components/common/StatusChip';

export function Reservations() {
  const { enqueueSnackbar } = useSnackbar();
  const qc = useQueryClient();
  const [statusFilter, setStatusFilter] = useState('ACTIVE');

  const { data, isLoading } = useQuery({
    queryKey: ['reservations', statusFilter],
    queryFn: () => apiGet<any[]>('/orders/reservations', { status: statusFilter }),
    refetchInterval: 20_000,
  });

  const releaseMutation = useMutation({
    mutationFn: (id: string) => apiPatch(`/orders/reservations/${id}/release`, {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['reservations'] });
      enqueueSnackbar('Reservation released — stock returned to vault', { variant: 'success' });
    },
    onError: (err: any) => enqueueSnackbar(err.response?.data?.error ?? 'Release failed', { variant: 'error' }),
  });

  const reservations = data ?? [];
  const metalCount = reservations.filter((r: any) => r.reservationType === 'METAL').length;
  const stoneCount = reservations.filter((r: any) => r.reservationType === 'STONE').length;
  const totalMetalWt = reservations
    .filter((r: any) => r.reservationType === 'METAL')
    .reduce((s: number, r: any) => s + Number(r.reservedWeight), 0);

  return (
    <Box>
      <PageHeader
        title="Material Reservations"
      />

      {/* Summary chips */}
      <Grid container spacing={2} sx={{ mb: 2 }}>
        {[
          { label: `${metalCount} Metal reservations`, color: '#44C47A', sub: `${totalMetalWt.toFixed(3)} g locked` },
          { label: `${stoneCount} Stone reservations`, color: '#7B1FA2', sub: 'Carats locked' },
        ].map((s) => (
          <Grid item key={s.label}>
            <Card sx={{ px: 2, py: 1.5 }}>
              <Typography variant="body2" fontWeight={700} color={s.color}>{s.label}</Typography>
              <Typography variant="caption" color="text.secondary">{s.sub}</Typography>
            </Card>
          </Grid>
        ))}
      </Grid>

      {statusFilter === 'ACTIVE' && (
        <Alert severity="info" sx={{ mb: 2 }}>
          Active reservations lock the exact metal and stones required for each order. Only release a reservation if the order is cancelled or if materials are being substituted.
        </Alert>
      )}

      <Card sx={{ mb: 2, p: 1.5 }}>
        <TextField select size="small" label="Status" value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)} sx={{ width: 180 }}>
          <MenuItem value="ACTIVE">Active</MenuItem>
          <MenuItem value="CONSUMED">Consumed</MenuItem>
          <MenuItem value="RELEASED">Released</MenuItem>
        </TextField>
      </Card>

      <Card>
        <Box sx={{ overflowX: 'auto' }}>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>Order #</TableCell>
              <TableCell>Client</TableCell>
              <TableCell>Order Status</TableCell>
              <TableCell>Type</TableCell>
              <TableCell>Material</TableCell>
              <TableCell align="right">Reserved Weight / Cts</TableCell>
              <TableCell>Reserved At</TableCell>
              <TableCell>Status</TableCell>
              <TableCell>Action</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {isLoading ? (
              <TableRow><TableCell colSpan={9} align="center" sx={{ py: 4 }}>Loading...</TableCell></TableRow>
            ) : reservations.length === 0 ? (
              <TableRow><TableCell colSpan={9} align="center" sx={{ py: 4 }}>No {statusFilter.toLowerCase()} reservations</TableCell></TableRow>
            ) : reservations.map((r: any) => (
              <TableRow key={r.id} hover>
                <TableCell sx={{ fontFamily: 'monospace', fontWeight: 700, color: '#44C47A', fontSize: 12 }}>
                  {r.order?.orderNumber}
                </TableCell>
                <TableCell>{r.order?.client?.name}</TableCell>
                <TableCell><StatusChip status={r.order?.status} /></TableCell>
                <TableCell>
                  <Chip label={r.reservationType} size="small"
                    color={r.reservationType === 'METAL' ? 'warning' : 'secondary'} />
                </TableCell>
                <TableCell>
                  {r.reservationType === 'METAL' ? (
                    <Box>
                      <Typography variant="body2" fontWeight={600}>{r.metalStock?.materialName}</Typography>
                      <Typography variant="caption" color="text.secondary">{r.metalStock?.stockCode} · {r.metalStock?.karat}</Typography>
                    </Box>
                  ) : (
                    <Box>
                      <Typography variant="body2" fontWeight={600}>{r.stoneLot?.stoneType}</Typography>
                      <Typography variant="caption" color="text.secondary">
                        {r.stoneLot?.lotNumber} · {r.stoneLot?.color} {r.stoneLot?.clarity}
                      </Typography>
                    </Box>
                  )}
                </TableCell>
                <TableCell align="right" sx={{ fontFamily: 'monospace', fontWeight: 700 }}>
                  {Number(r.reservedWeight).toFixed(4)}
                  <Typography component="span" variant="caption" color="text.secondary" sx={{ ml: 0.5 }}>
                    {r.reservationType === 'METAL' ? 'g' : 'ct'}
                  </Typography>
                </TableCell>
                <TableCell sx={{ fontSize: 12 }}>
                  {new Date(r.reservedAt).toLocaleDateString('en-IN')}
                </TableCell>
                <TableCell><StatusChip status={r.status} /></TableCell>
                <TableCell>
                  {r.status === 'ACTIVE' && (
                    <Button
                      size="small" color="error" variant="outlined"
                      startIcon={<LockOpen fontSize="small" />}
                      onClick={() => releaseMutation.mutate(r.id)}
                      disabled={releaseMutation.isPending}
                    >
                      Release
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        </Box>
      </Card>
    </Box>
  );
}
