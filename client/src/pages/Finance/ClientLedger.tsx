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

const TYPE_COLOR: Record<string, 'info' | 'success' | 'warning' | 'secondary'> = {
  INVOICE: 'info', PAYMENT: 'success', RETURN: 'warning', EXCHANGE: 'secondary',
};

// F4: one client's full statement — every SalesInvoice (debit), InvoicePayment (credit, incl.
// F2's standalone on-account payments), SalesReturn (credit), and OldGoldExchange (credit) that
// ever moved their Client.currentBalance, in one chronological list with a running balance.
export function ClientLedger() {
  const { clientId } = useParams();
  const navigate = useNavigate();
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  const { data: clients } = useQuery({ queryKey: ['clients'], queryFn: () => apiGet<any[]>('/orders/clients') });
  const { data, isLoading } = useQuery({
    queryKey: ['client-ledger', clientId, from, to],
    queryFn: () => apiGet<any>(`/finance/reports/client-ledger/${clientId}`, {
      ...(from && { from }), ...(to && { to }),
    }),
    enabled: !!clientId,
  });

  const rows: any[] = data?.rows ?? [];
  const selected = (clients ?? []).find((c: any) => c.id === clientId) ?? null;

  return (
    <Box>
      <PageHeader title="Client Ledger" />

      <Card sx={{ p: 2, mb: 2 }}>
        <Grid container spacing={2} alignItems="center">
          <Grid item xs={12} sm={4}>
            <Autocomplete
              options={clients ?? []}
              getOptionLabel={(c: any) => `${c.clientCode} — ${c.name}`}
              value={selected}
              onChange={(_, v) => navigate(v ? `/finance/client-ledger/${v.id}` : '/finance/client-ledger')}
              renderInput={(params) => <TextField {...params} label="Client" size="small" />}
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

      {!clientId ? (
        <Card sx={{ p: 4, textAlign: 'center' }}>
          <Typography color="text.secondary">Pick a client to view their statement</Typography>
        </Card>
      ) : (
        <Card>
          {selected && (
            <Box sx={{ p: 2 }}>
              <Typography fontWeight={700}>{selected.clientCode} — {selected.name}</Typography>
              <Typography variant="body2" color="text.secondary">{selected.type}</Typography>
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
                  <TableCell align="right">Debit</TableCell>
                  <TableCell align="right">Credit</TableCell>
                  <TableCell align="right">Balance</TableCell>
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
                      <TableRow key={`${r.type}-${r.refNumber}`} hover>
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
              Closing Balance: {money(data?.closingBalance ?? 0)}
            </Typography>
          </Box>
        </Card>
      )}
    </Box>
  );
}
