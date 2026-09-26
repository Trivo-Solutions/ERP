import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  Box, Card, Table, TableHead, TableBody, TableRow, TableCell, Typography, Chip, Divider,
  Autocomplete, TextField, Grid, Button,
} from '@mui/material';
import { Print } from '@mui/icons-material';
import { useQuery } from '@tanstack/react-query';
import { apiGet } from '../../api/client';
import { PageHeader, PageActions } from '../../components/common/PageHeader';

function money(n: number) {
  return '₹' + Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 });
}

const TYPE_COLOR: Record<string, 'info' | 'success' | 'warning'> = {
  PURCHASE: 'info', PAYMENT: 'success', RETURN: 'warning',
};

// One supplier's statement — finished-goods intake (credit: we owe more, goods + input GST), purchase
// returns and payments (debit: we owe less), in one chronological list with a running payable balance.
// Positive balance = we owe the supplier; negative = an advance paid to them. Mirror of ClientLedger.
export function SupplierLedger() {
  const { supplierId } = useParams();
  const navigate = useNavigate();
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  const { data: suppliers } = useQuery({ queryKey: ['suppliers'], queryFn: () => apiGet<any[]>('/procurement/suppliers') });
  const { data, isLoading } = useQuery({
    queryKey: ['supplier-ledger', supplierId, from, to],
    queryFn: () => apiGet<any>(`/finance/reports/supplier-ledger/${supplierId}`, {
      ...(from && { from }), ...(to && { to }),
    }),
    enabled: !!supplierId,
  });

  const rows: any[] = data?.rows ?? [];
  const selected = (suppliers ?? []).find((s: any) => s.id === supplierId) ?? null;

  return (
    <Box>
      <PageHeader title="Supplier Ledger" />

      <Card sx={{ p: 2, mb: 2 }}>
        <Grid container spacing={2} alignItems="center">
          <Grid item xs={12} sm={4}>
            <Autocomplete
              options={suppliers ?? []}
              getOptionLabel={(s: any) => `${s.supplierCode} — ${s.name}`}
              value={selected}
              onChange={(_, v) => navigate(v ? `/finance/supplier-ledger/${v.id}` : '/finance/supplier-ledger')}
              renderInput={(params) => <TextField {...params} label="Supplier" size="small" />}
              isOptionEqualToValue={(a: any, b: any) => a.id === b.id}
            />
          </Grid>
          <Grid item xs={6} sm={3}>
            <TextField fullWidth size="small" label="From" type="date" value={from}
              onChange={(e) => setFrom(e.target.value)} InputLabelProps={{ shrink: true }} />
          </Grid>
          <Grid item xs={6} sm={3}>
            <TextField fullWidth size="small" label="To" type="date" value={to}
              onChange={(e) => setTo(e.target.value)} InputLabelProps={{ shrink: true }} />
          </Grid>
          <Grid item xs={12} sm="auto">
            <Button fullWidth onClick={() => { setFrom(''); setTo(''); }}>Clear</Button>
          </Grid>
          <Grid item sx={{ ml: 'auto', alignSelf: 'center' }}>
            <PageActions actions={data ? [{ label: 'Print', icon: <Print />, onClick: () => window.print() }] : []} />
          </Grid>
        </Grid>
      </Card>

      {!supplierId ? (
        <Card sx={{ p: 4, textAlign: 'center' }}>
          <Typography color="text.secondary">Pick a supplier to view their statement</Typography>
        </Card>
      ) : (
        <Card>
          {selected && (
            <Box sx={{ p: 2 }}>
              <Typography fontWeight={700}>{selected.supplierCode} — {selected.name}</Typography>
              <Typography variant="body2" color="text.secondary">{selected.gstNumber ? `GSTIN ${selected.gstNumber}` : 'Unregistered (no GSTIN)'}</Typography>
            </Box>
          )}
          <Divider />
          <Box sx={{ overflowX: 'auto' }}>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>Date</TableCell>
                  <TableCell>Type</TableCell>
                  <TableCell>Description</TableCell>
                  <TableCell align="right">Paid / Returned</TableCell>
                  <TableCell align="right">Bought</TableCell>
                  <TableCell align="right">Payable</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {isLoading ? (
                  <TableRow><TableCell colSpan={6} align="center" sx={{ py: 4 }}>Loading...</TableCell></TableRow>
                ) : (
                  <>
                    <TableRow sx={{ bgcolor: '#F7F8FC' }}>
                      <TableCell colSpan={5} sx={{ fontStyle: 'italic', color: 'text.secondary' }}>Opening Balance</TableCell>
                      <TableCell align="right" sx={{ fontFamily: 'monospace', fontWeight: 700 }}>{money(data?.openingBalance ?? 0)}</TableCell>
                    </TableRow>
                    {rows.map((r) => (
                      <TableRow key={`${r.type}-${r.refNumber}-${r.description}`} hover>
                        <TableCell>{new Date(r.date).toLocaleDateString('en-IN')}</TableCell>
                        <TableCell><Chip label={r.type} size="small" color={TYPE_COLOR[r.type] ?? 'default'} /></TableCell>
                        <TableCell>{r.description}</TableCell>
                        <TableCell align="right" sx={{ fontFamily: 'monospace' }}>{r.debit > 0 ? money(r.debit) : '—'}</TableCell>
                        <TableCell align="right" sx={{ fontFamily: 'monospace' }}>{r.credit > 0 ? money(r.credit) : '—'}</TableCell>
                        <TableCell align="right" sx={{ fontFamily: 'monospace', fontWeight: 600 }}>{money(r.balance)}</TableCell>
                      </TableRow>
                    ))}
                    {rows.length === 0 && (
                      <TableRow><TableCell colSpan={6} align="center" sx={{ py: 4 }}>No transactions in this period</TableCell></TableRow>
                    )}
                  </>
                )}
              </TableBody>
            </Table>
          </Box>
          <Divider />
          <Box sx={{ p: 1.5, display: 'flex', justifyContent: 'flex-end', gap: 3, bgcolor: '#EEF1FA' }}>
            <Typography fontWeight={700} sx={{ fontFamily: 'monospace' }}>
              Closing Payable: {money(data?.closingBalance ?? 0)}
            </Typography>
          </Box>
        </Card>
      )}
    </Box>
  );
}
