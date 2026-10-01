import { useState } from 'react';
import {
  Box, Card, CardContent, Table, TableHead, TableBody, TableRow, TableCell, Typography,
  Grid, TextField, Divider,
} from '@mui/material';
import { useQuery } from '@tanstack/react-query';
import { apiGet } from '../../api/client';
import { PageHeader } from '../../components/common/PageHeader';

function money(n: number) {
  return '₹' + Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 });
}

// H4: one day's company-wide rollup — sales issued, payments received (the actual cash/bank
// movement, by mode, for till reconciliation), returns and exchanges (accounting credits, kept
// separate from payments since neither is same-day cash paid out), and standalone credit notes
// (customer-balance credits, excluding return-linked which are under returns, and cancelled notes).
export function DayBook() {
  const [date, setDate] = useState(new Date().toISOString().split('T')[0]);

  const { data, isLoading } = useQuery({
    queryKey: ['day-book', date],
    queryFn: () => apiGet<any>('/finance/reports/day-book', { date }),
  });

  return (
    <Box>
      <PageHeader title="Day Book" />

      <Card sx={{ p: 2, mb: 2 }}>
        <Grid container spacing={2}>
          <Grid item xs={6} sm={3}>
            <TextField fullWidth size="small" label="Date" type="date" value={date}
              onChange={(e) => setDate(e.target.value)} InputLabelProps={{ shrink: true }} />
          </Grid>
        </Grid>
      </Card>

      {isLoading || !data ? (
        <Card sx={{ p: 4, textAlign: 'center' }}><Typography color="text.secondary">Loading...</Typography></Card>
      ) : (
        <Grid container spacing={2}>
          <Grid item xs={12} md={6}>
            <Card>
              <CardContent>
                <Typography variant="subtitle1" fontWeight={700} gutterBottom>Sales ({data.sales.count})</Typography>
                <Table size="small">
                  <TableBody>
                    {data.sales.rows.map((r: any) => (
                      <TableRow key={r.invoiceNumber}>
                        <TableCell sx={{ fontFamily: 'monospace', fontSize: 12 }}>{r.invoiceNumber}</TableCell>
                        <TableCell sx={{ fontSize: 12 }}>{r.client}</TableCell>
                        <TableCell align="right" sx={{ fontFamily: 'monospace' }}>{money(r.amount)}</TableCell>
                      </TableRow>
                    ))}
                    {data.sales.rows.length === 0 && <TableRow><TableCell colSpan={3} align="center" sx={{ py: 2, color: 'text.secondary' }}>No sales</TableCell></TableRow>}
                  </TableBody>
                </Table>
                <Divider sx={{ my: 1 }} />
                <Box sx={{ display: 'flex', justifyContent: 'space-between' }}>
                  <Typography fontWeight={700}>Total</Typography>
                  <Typography fontWeight={700} sx={{ fontFamily: 'monospace' }}>{money(data.sales.totalAmount)}</Typography>
                </Box>
              </CardContent>
            </Card>
          </Grid>

          <Grid item xs={12} md={6}>
            <Card>
              <CardContent>
                <Typography variant="subtitle1" fontWeight={700} gutterBottom>Payments Received ({data.payments.count})</Typography>
                <Table size="small">
                  <TableBody>
                    {data.payments.byMode.map((m: any) => (
                      <TableRow key={m.mode}>
                        <TableCell>{m.mode}</TableCell>
                        <TableCell align="right" sx={{ fontFamily: 'monospace' }}>{money(m.total)}</TableCell>
                      </TableRow>
                    ))}
                    {data.payments.byMode.length === 0 && <TableRow><TableCell colSpan={2} align="center" sx={{ py: 2, color: 'text.secondary' }}>No payments</TableCell></TableRow>}
                  </TableBody>
                </Table>
                <Divider sx={{ my: 1 }} />
                <Box sx={{ display: 'flex', justifyContent: 'space-between' }}>
                  <Typography fontWeight={700}>Total</Typography>
                  <Typography fontWeight={700} sx={{ fontFamily: 'monospace' }}>{money(data.payments.total)}</Typography>
                </Box>
              </CardContent>
            </Card>
          </Grid>

          <Grid item xs={12} md={6}>
            <Card>
              <CardContent>
                <Typography variant="subtitle1" fontWeight={700} gutterBottom>Returns ({data.returns.count})</Typography>
                <Table size="small">
                  <TableBody>
                    {data.returns.rows.map((r: any) => (
                      <TableRow key={r.returnNumber}>
                        <TableCell sx={{ fontFamily: 'monospace', fontSize: 12 }}>{r.returnNumber}</TableCell>
                        <TableCell align="right" sx={{ fontFamily: 'monospace' }}>{money(r.amount)}</TableCell>
                      </TableRow>
                    ))}
                    {data.returns.rows.length === 0 && <TableRow><TableCell colSpan={2} align="center" sx={{ py: 2, color: 'text.secondary' }}>No returns</TableCell></TableRow>}
                  </TableBody>
                </Table>
                <Divider sx={{ my: 1 }} />
                <Box sx={{ display: 'flex', justifyContent: 'space-between' }}>
                  <Typography fontWeight={700}>Total</Typography>
                  <Typography fontWeight={700} sx={{ fontFamily: 'monospace' }}>{money(data.returns.totalAmount)}</Typography>
                </Box>
              </CardContent>
            </Card>
          </Grid>

          <Grid item xs={12} md={6}>
            <Card>
              <CardContent>
                <Typography variant="subtitle1" fontWeight={700} gutterBottom>Old Gold Exchanges ({data.exchanges.count})</Typography>
                <Table size="small">
                  <TableBody>
                    {data.exchanges.rows.map((r: any) => (
                      <TableRow key={r.exchangeNumber}>
                        <TableCell sx={{ fontFamily: 'monospace', fontSize: 12 }}>{r.exchangeNumber}</TableCell>
                        <TableCell align="right" sx={{ fontFamily: 'monospace' }}>{money(r.amount)}</TableCell>
                      </TableRow>
                    ))}
                    {data.exchanges.rows.length === 0 && <TableRow><TableCell colSpan={2} align="center" sx={{ py: 2, color: 'text.secondary' }}>No exchanges</TableCell></TableRow>}
                  </TableBody>
                </Table>
                <Divider sx={{ my: 1 }} />
                <Box sx={{ display: 'flex', justifyContent: 'space-between' }}>
                  <Typography fontWeight={700}>Total</Typography>
                  <Typography fontWeight={700} sx={{ fontFamily: 'monospace' }}>{money(data.exchanges.totalAmount)}</Typography>
                </Box>
              </CardContent>
            </Card>
          </Grid>

          <Grid item xs={12} md={6}>
            <Card>
              <CardContent>
                <Typography variant="subtitle1" fontWeight={700} gutterBottom>Credit Notes ({data.creditNotes?.count ?? 0})</Typography>
                <Table size="small">
                  <TableBody>
                    {(data.creditNotes?.rows ?? []).map((r: any) => (
                      <TableRow key={r.creditNoteNumber}>
                        <TableCell sx={{ fontFamily: 'monospace', fontSize: 12 }}>{r.creditNoteNumber}</TableCell>
                        <TableCell align="right" sx={{ fontFamily: 'monospace' }}>{money(r.amount)}</TableCell>
                      </TableRow>
                    ))}
                    {(data.creditNotes?.rows ?? []).length === 0 && (
                      <TableRow><TableCell colSpan={2} align="center" sx={{ py: 2, color: 'text.secondary' }}>No credit notes</TableCell></TableRow>
                    )}
                  </TableBody>
                </Table>
                <Divider sx={{ my: 1 }} />
                <Box sx={{ display: 'flex', justifyContent: 'space-between' }}>
                  <Typography fontWeight={700}>Total</Typography>
                  <Typography fontWeight={700} sx={{ fontFamily: 'monospace' }}>{money(data.creditNotes?.totalAmount ?? 0)}</Typography>
                </Box>
              </CardContent>
            </Card>
          </Grid>
        </Grid>
      )}
    </Box>
  );
}
