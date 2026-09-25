import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Box, Card, Table, TableHead, TableBody, TableRow, TableCell,
  Typography, Chip, LinearProgress, TextField, InputAdornment, Grid,
} from '@mui/material';
import { Search, Warning } from '@mui/icons-material';
import { useQuery } from '@tanstack/react-query';
import { apiGet } from '../../api/client';
import { PageHeader } from '../../components/common/PageHeader';
import { KpiCard } from '../../components/common/KpiCard';

export function KarigarBalances() {
  const navigate = useNavigate();
  const [search, setSearch] = useState('');

  const { data, isLoading } = useQuery({
    queryKey: ['karigar-balances-report'],
    queryFn: () => apiGet<any[]>('/reports/karigar-balances'),
    refetchInterval: 30_000,
  });

  const all = data ?? [];
  const filtered = search
    ? all.filter((a: any) =>
        a.name.toLowerCase().includes(search.toLowerCase()) ||
        a.artisanCode.toLowerCase().includes(search.toLowerCase()))
    : all;

  const totalBalance = all.reduce((s: number, a: any) => s + Number(a.metalBalance), 0);
  const highBalance  = all.filter((a: any) => Number(a.metalBalance) > 50).length;
  const zeroBalance  = all.filter((a: any) => Number(a.metalBalance) === 0).length;

  const maxBalance = Math.max(...all.map((a: any) => Number(a.metalBalance)), 0.001);

  return (
    <Box>
      <PageHeader
        title="Karigar Metal Balances"
        subtitle="Running weight outstanding with each artisan — pending return to vault"
        breadcrumbs={[{ label: 'Reports', path: '/reports/wip' }, { label: 'Karigar Balances' }]}
      />

      <Grid container spacing={2} sx={{ mb: 2 }}>
        <Grid item xs={6} sm={3}>
          <KpiCard title="Total Outstanding" value={`${totalBalance.toFixed(3)} g`}
            icon={<Warning />} color="#44C47A"
            subtitle="Combined balance across all artisans" />
        </Grid>
        <Grid item xs={6} sm={3}>
          <KpiCard title="Active Artisans" value={all.length} icon={<Warning />} color="#0277BD" />
        </Grid>
        <Grid item xs={6} sm={3}>
          <KpiCard title="High Balance (>50g)" value={highBalance} icon={<Warning />}
            color={highBalance > 0 ? '#B00020' : '#1B5E20'}
            subtitle="Require immediate follow-up" />
        </Grid>
        <Grid item xs={6} sm={3}>
          <KpiCard title="Cleared (0g)" value={zeroBalance} icon={<Warning />} color="#1B5E20" />
        </Grid>
      </Grid>

      <Card sx={{ mb: 2, p: 1.5 }}>
        <TextField
          size="small" placeholder="Search artisan name or code..." value={search}
          onChange={(e) => setSearch(e.target.value)}
          InputProps={{ startAdornment: <InputAdornment position="start"><Search fontSize="small" /></InputAdornment> }}
          sx={{ width: 280 }}
        />
      </Card>

      <Card>
        <Box sx={{ overflowX: 'auto' }}>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>Code</TableCell>
              <TableCell>Artisan Name</TableCell>
              <TableCell>Type</TableCell>
              <TableCell>Specializations</TableCell>
              <TableCell align="right">Metal Balance (g)</TableCell>
              <TableCell sx={{ width: 160 }}>Balance Indicator</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {isLoading ? (
              <TableRow><TableCell colSpan={6} align="center" sx={{ py: 4 }}><LinearProgress /></TableCell></TableRow>
            ) : filtered.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} align="center" sx={{ py: 4 }}>
                  {search ? 'No artisans match the search' : 'All balances are cleared — no metal outstanding'}
                </TableCell>
              </TableRow>
            ) : filtered.map((artisan: any) => {
              const balance = Number(artisan.metalBalance);
              const pct = Math.min(100, (balance / maxBalance) * 100);
              const color = balance > 50 ? '#B00020' : balance > 20 ? '#E65100' : '#44C47A';
              return (
                <TableRow
                  key={artisan.artisanCode}
                  hover
                  sx={{ cursor: 'pointer', bgcolor: balance > 50 ? '#FFF5F5' : 'inherit' }}
                  onClick={() => navigate('/outsourcing/ledger')}
                >
                  <TableCell sx={{ fontFamily: 'monospace', fontWeight: 700, fontSize: 12, color: '#44C47A' }}>
                    {artisan.artisanCode}
                  </TableCell>
                  <TableCell sx={{ fontWeight: 600 }}>{artisan.name}</TableCell>
                  <TableCell>
                    <Chip label={artisan.type} size="small"
                      color={artisan.type === 'EXTERNAL' ? 'warning' : 'default'} />
                  </TableCell>
                  <TableCell sx={{ fontSize: 12 }}>
                    {Array.isArray(artisan.specializations)
                      ? artisan.specializations.join(', ') || '—'
                      : '—'}
                  </TableCell>
                  <TableCell align="right">
                    <Typography
                      sx={{ fontFamily: 'monospace', fontWeight: 700, fontSize: 14,
                        color: balance === 0 ? 'success.main' : color }}
                    >
                      {balance.toFixed(4)} g
                    </Typography>
                    {balance > 50 && (
                      <Chip label="HIGH" size="small" color="error" sx={{ fontSize: 9, height: 16, ml: 0.5 }} />
                    )}
                  </TableCell>
                  <TableCell>
                    <LinearProgress
                      variant="determinate"
                      value={pct}
                      sx={{
                        height: 8, borderRadius: 4,
                        bgcolor: '#F4F6FB',
                        '& .MuiLinearProgress-bar': { bgcolor: color, borderRadius: 4 },
                      }}
                    />
                    <Typography variant="caption" color="text.secondary">
                      {pct.toFixed(0)}% of max
                    </Typography>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
        </Box>

        {!isLoading && filtered.length > 0 && (
          <Box sx={{ p: 1.5, borderTop: 1, borderColor: 'divider', display: 'flex', justifyContent: 'flex-end', gap: 3 }}>
            <Typography variant="caption" color="text.secondary">
              Showing {filtered.length} of {all.length} artisans
            </Typography>
            <Typography variant="caption" fontWeight={700} sx={{ fontFamily: 'monospace', color: '#44C47A' }}>
              Total outstanding: {totalBalance.toFixed(4)} g
            </Typography>
          </Box>
        )}
      </Card>
    </Box>
  );
}
