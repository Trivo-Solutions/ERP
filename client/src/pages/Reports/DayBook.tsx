import { useEffect, useState } from 'react';
import {
  Box, Card, CardContent, Table, TableHead, TableBody, TableRow, TableCell, Typography,
  Grid, TextField, Divider, TablePagination, Chip,
} from '@mui/material';
import { useQuery } from '@tanstack/react-query';
import { apiGet } from '../../api/client';
import { PageHeader } from '../../components/common/PageHeader';

export function money(n: number) {
  const v = Number(n || 0);
  // A negative (e.g. a day's net movement when more went out than came in) reads "-₹9,666.00", not "₹-9,666.00".
  return (v < 0 ? '-' : '') + '₹' + Math.abs(v).toLocaleString('en-IN', { minimumFractionDigits: 2 });
}
function wt(n: number) {
  return Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 3, maximumFractionDigits: 3 });
}

const PAGE_SIZES = [5, 10, 25];

/** The rows one screen of a list shows. Pure, so paging can be tested without a DOM. */
export function pageRows<T>(rows: T[], page: number, size: number): T[] {
  return rows.slice(page * size, page * size + size);
}

// The business day is India's, whatever timezone this browser is in (matches the server's day boundary).
/** An instant as a dd/mm/yyyy India calendar date (the business day, not the browser's). */
export const indiaDate = (iso: string | Date) =>
  new Date(iso).toLocaleDateString('en-GB', { timeZone: 'Asia/Kolkata', day: '2-digit', month: '2-digit', year: 'numeric' });

export const todayInIndia = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
const mono = { fontFamily: 'monospace' } as const;

// A list card: count in the title, 5 rows per page by default, total of ALL rows (not just the page) at the bottom.
function ListCard({ title, rows, columns, total, empty, rowKey }: {
  title: string; rows: any[]; total: number; empty: string; rowKey: (r: any) => string;
  columns: { head: string; align?: 'right'; sx?: object; render: (r: any) => React.ReactNode }[];
}) {
  const [page, setPage] = useState(0);
  const [size, setSize] = useState(5);
  // A new date brings a new row set — never leave the card on a page that no longer exists.
  useEffect(() => { setPage(0); }, [rows.length]);
  const shown = pageRows(rows, page, size);

  return (
    <Card>
      <CardContent>
        <Typography variant="subtitle1" fontWeight={700} gutterBottom>{title} ({rows.length})</Typography>
        <Table size="small">
          <TableHead>
            <TableRow>
              {columns.map((c) => <TableCell key={c.head} align={c.align} sx={{ fontSize: 12, color: 'text.secondary' }}>{c.head}</TableCell>)}
            </TableRow>
          </TableHead>
          <TableBody>
            {shown.map((r) => (
              <TableRow key={rowKey(r)}>
                {columns.map((c) => <TableCell key={c.head} align={c.align} sx={{ fontSize: 12, ...c.sx }}>{c.render(r)}</TableCell>)}
              </TableRow>
            ))}
            {rows.length === 0 && <TableRow><TableCell colSpan={columns.length} align="center" sx={{ py: 2, color: 'text.secondary' }}>{empty}</TableCell></TableRow>}
          </TableBody>
        </Table>
        {rows.length > PAGE_SIZES[0] && (
          <TablePagination
            component="div" count={rows.length} page={page} rowsPerPage={size} rowsPerPageOptions={PAGE_SIZES}
            onPageChange={(_, p) => setPage(p)} onRowsPerPageChange={(e) => { setSize(Number(e.target.value)); setPage(0); }}
          />
        )}
        <Divider sx={{ my: 1 }} />
        <Box sx={{ display: 'flex', justifyContent: 'space-between' }}>
          <Typography fontWeight={700}>Total</Typography>
          <Typography fontWeight={700} sx={mono}>{money(total)}</Typography>
        </Box>
      </CardContent>
    </Card>
  );
}

function NetLine({ label, value, bold, sign }: { label: string; value: number; bold?: boolean; sign?: '+' | '−' }) {
  return (
    <Box sx={{ display: 'flex', justifyContent: 'space-between', py: 0.25 }}>
      <Typography fontWeight={bold ? 700 : 400} color={bold ? 'text.primary' : 'text.secondary'}>{sign ? `${sign} ` : ''}{label}</Typography>
      <Typography fontWeight={bold ? 700 : 400} sx={mono}>{money(value)}</Typography>
    </Box>
  );
}

// H4: one day's company-wide rollup — sales issued, payments received (the actual cash/bank
// movement, by mode, for till reconciliation), returns and metal exchanges (accounting credits, kept
// separate from payments since neither is same-day cash paid out), and standalone credit notes
// (customer-balance credits, excluding return-linked which are under returns, and cancelled notes).
export function DayBook() {
  const [date, setDate] = useState(todayInIndia());

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
        <DayBookView key={date} data={data} />
      )}
    </Box>
  );
}

// The report body for one day's data (separate from the fetch so it can be rendered on its own).
export function DayBookView({ data }: { data: any }) {
  const [metal, setMetal] = useState('ALL');

  const exchangeRows: any[] = data?.exchanges.rows ?? [];
  const metals: any[] = data?.metalExchange?.byMetal ?? [];
  const filteredExchanges = metal === 'ALL' ? exchangeRows : exchangeRows.filter((r) => r.metalType === metal);
  const filteredTotal = filteredExchanges.reduce((s, r) => s + r.amount, 0);

  return (
        <Grid container spacing={2}>
          <Grid item xs={12} md={6}>
            <ListCard
              title="Sales" rows={data.sales.rows} total={data.sales.totalAmount} empty="No sales"
              rowKey={(r) => r.invoiceNumber}
              columns={[
                { head: 'Invoice', sx: mono, render: (r) => r.invoiceNumber },
                { head: 'Customer', render: (r) => r.client },
                { head: 'Amount', align: 'right', sx: { ...mono, fontSize: 13 }, render: (r) => money(r.amount) },
              ]}
            />
          </Grid>

          <Grid item xs={12} md={6}>
            <MoneyInCard data={data} />
          </Grid>

          <Grid item xs={12} md={6}>
            <ListCard
              title="Payments Received" rows={data.payments.rows ?? []} total={data.payments.total} empty="No payments"
              rowKey={(r) => r.paymentNumber}
              columns={[
                { head: 'No.', sx: mono, render: (r) => r.paymentNumber },
                { head: 'Customer', render: (r) => r.client },
                { head: 'Mode', render: (r) => r.mode },
                { head: 'Against', render: (r) => r.invoiceNumber
                  ? <span style={mono}>{r.invoiceNumber}</span>
                  : <Chip size="small" color="warning" variant="outlined" label="On account" /> },
                { head: 'Amount', align: 'right', sx: { ...mono, fontSize: 13 }, render: (r) => money(r.amount) },
              ]}
            />
          </Grid>

          <Grid item xs={12} md={6}>
            <ListCard
              title="Advances Received" rows={data.advances?.rows ?? []} total={data.advances?.totalAmount ?? 0} empty="No advances"
              rowKey={(r) => r.advanceNumber}
              columns={[
                { head: 'No.', sx: mono, render: (r) => (
                  <>{r.advanceNumber}{r.reversed && <Chip size="small" color="error" variant="outlined" label="Reversed" sx={{ ml: 1, height: 18, fontSize: 11 }} />}</>
                ) },
                { head: 'Customer', render: (r) => r.client },
                { head: 'Mode', render: (r) => r.mode === 'SPLIT'
                  ? (r.payments ?? []).map((p: any) => p.mode).join(' + ')
                  : r.mode },
                { head: 'Amount', align: 'right', sx: { ...mono, fontSize: 13 }, render: (r) => money(r.amount) },
                { head: 'Unused', align: 'right', sx: { ...mono, fontSize: 13 }, render: (r) => money(r.available) },
              ]}
            />
          </Grid>

          <Grid item xs={12} md={6}>
            <ListCard
              title="Advance Reversals (Money Out)" rows={data.moneyOut?.rows ?? []} total={data.moneyOut?.total ?? 0} empty="No advances reversed"
              rowKey={(r) => r.advanceNumber}
              columns={[
                { head: 'No.', sx: mono, render: (r) => r.advanceNumber },
                { head: 'Customer', render: (r) => r.client },
                { head: 'Mode', render: (r) => (r.payments ?? []).map((p: any) => p.mode).join(' + ') },
                { head: 'Taken on', render: (r) => indiaDate(r.originalDate) },
                { head: 'Amount', align: 'right', sx: { ...mono, fontSize: 13 }, render: (r) => money(r.amount) },
              ]}
            />
          </Grid>

          <Grid item xs={12} md={6}>
            <ListCard
              title="Returns" rows={data.returns.rows} total={data.returns.totalAmount} empty="No returns"
              rowKey={(r) => r.returnNumber}
              columns={[
                { head: 'Return', sx: mono, render: (r) => r.returnNumber },
                { head: 'Amount', align: 'right', sx: { ...mono, fontSize: 13 }, render: (r) => money(r.amount) },
              ]}
            />
          </Grid>

          <Grid item xs={12} md={6}>
            <Card>
              <CardContent>
                <Typography variant="subtitle1" fontWeight={700} gutterBottom>Metal Exchange ({data.exchanges.count})</Typography>
                {metals.length > 0 && (
                  <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', mb: 1.5 }}>
                    <Chip size="small" label={`All (${exchangeRows.length})`} color={metal === 'ALL' ? 'primary' : 'default'} onClick={() => setMetal('ALL')} />
                    {metals.map((m) => (
                      <Chip key={m.metalType} size="small" color={metal === m.metalType ? 'primary' : 'default'} onClick={() => setMetal(m.metalType)}
                        label={`${m.metalType} · ${wt(m.fineWeight)} g · ${money(m.amount)}`} />
                    ))}
                  </Box>
                )}
                <MetalExchangeTable rows={filteredExchanges} total={filteredTotal} />
              </CardContent>
            </Card>
          </Grid>

          <Grid item xs={12} md={6}>
            <ListCard
              title="Credit Notes" rows={data.creditNotes?.rows ?? []} total={data.creditNotes?.totalAmount ?? 0} empty="No credit notes"
              rowKey={(r) => r.creditNoteNumber}
              columns={[
                { head: 'Credit note', sx: mono, render: (r) => r.creditNoteNumber },
                { head: 'Amount', align: 'right', sx: { ...mono, fontSize: 13 }, render: (r) => money(r.amount) },
              ]}
            />
          </Grid>

          <Grid item xs={12} md={6}>
            <Card sx={{ height: '100%' }}>
              <CardContent>
                <Typography variant="subtitle1" fontWeight={700} gutterBottom>Day Summary (Net)</Typography>
                <NetLine label="Sales" value={data.net.sales} />
                {data.net.salesDebitNotes > 0 && <NetLine label="Debit notes" value={data.net.salesDebitNotes} sign="+" />}
                <NetLine label="Returns" value={data.net.returns} sign="−" />
                <NetLine label="Credit notes" value={data.net.creditNotes} sign="−" />
                <Divider sx={{ my: 0.5 }} />
                <NetLine label="Net Sales" value={data.net.netSales} bold />
                <Box sx={{ mt: 1 }} />
                <NetLine label="Payments received" value={data.net.collected} sign="−" />
                <NetLine label="Metal exchanged" value={data.net.metalExchanged} sign="−" />
                <Divider sx={{ my: 0.5 }} />
                <NetLine label="Added to customer balances" value={data.net.balanceChange} bold />
              </CardContent>
            </Card>
          </Grid>
        </Grid>
  );
}

function MetalExchangeTable({ rows, total }: { rows: any[]; total: number }) {
  const [page, setPage] = useState(0);
  const [size, setSize] = useState(5);
  useEffect(() => { setPage(0); }, [rows.length]);
  const shown = pageRows(rows, page, size);
  const head = { fontSize: 12, color: 'text.secondary' };

  return (
    <>
      <Box sx={{ overflowX: 'auto' }}>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell sx={head}>No.</TableCell>
              <TableCell sx={head}>Metal</TableCell>
              <TableCell sx={head}>Purity</TableCell>
              <TableCell align="right" sx={head}>Net g</TableCell>
              <TableCell align="right" sx={head}>Fine g</TableCell>
              <TableCell align="right" sx={head}>Amount</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {shown.map((r) => (
              <TableRow key={r.exchangeNumber}>
                <TableCell sx={{ ...mono, fontSize: 12 }}>{r.exchangeNumber}</TableCell>
                <TableCell sx={{ fontSize: 12 }}>{r.metalType}</TableCell>
                <TableCell sx={{ fontSize: 12 }}>{r.karat}</TableCell>
                <TableCell align="right" sx={{ ...mono, fontSize: 12 }}>{wt(r.netWeight)}</TableCell>
                <TableCell align="right" sx={{ ...mono, fontSize: 12 }}>{wt(r.fineWeight)}</TableCell>
                <TableCell align="right" sx={{ ...mono, fontSize: 13 }}>{money(r.amount)}</TableCell>
              </TableRow>
            ))}
            {rows.length === 0 && <TableRow><TableCell colSpan={6} align="center" sx={{ py: 2, color: 'text.secondary' }}>No metal exchanges</TableCell></TableRow>}
          </TableBody>
        </Table>
      </Box>
      {rows.length > PAGE_SIZES[0] && (
        <TablePagination
          component="div" count={rows.length} page={page} rowsPerPage={size} rowsPerPageOptions={PAGE_SIZES}
          onPageChange={(_, p) => setPage(p)} onRowsPerPageChange={(e) => { setSize(Number(e.target.value)); setPage(0); }}
        />
      )}
      <Divider sx={{ my: 1 }} />
      <Box sx={{ display: 'flex', justifyContent: 'space-between' }}>
        <Typography fontWeight={700}>Total</Typography>
        <Typography fontWeight={700} sx={mono}>{money(total)}</Typography>
      </Box>
    </>
  );
}

// Cash / UPI / Card (and any other mode) = payments received + advances received, side by side.
// Payments Received and Advances Received keep their own lists and totals; this card only adds them up.
export function MoneyInCard({ data }: { data: any }) {
  const modes: any[] = data.moneyIn?.byMode ?? [];
  const head = { fontSize: 12, color: 'text.secondary' };
  return (
    <Card sx={{ height: '100%' }}>
      <CardContent>
        <Typography variant="subtitle1" fontWeight={700} gutterBottom>Money In by Mode</Typography>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell sx={head}>Mode</TableCell>
              <TableCell align="right" sx={head}>Payments</TableCell>
              <TableCell align="right" sx={head}>Advances</TableCell>
              <TableCell align="right" sx={head}>Money In</TableCell>
              <TableCell align="right" sx={head}>Money Out</TableCell>
              <TableCell align="right" sx={head}>Net</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {modes.map((m) => (
              <TableRow key={m.mode}>
                <TableCell>
                  {m.mode}{!m.recognised && <Chip size="small" variant="outlined" label="other" sx={{ ml: 1, height: 18, fontSize: 11 }} />}
                </TableCell>
                <TableCell align="right" sx={{ ...mono, fontSize: 13 }}>{money(m.receipts)}</TableCell>
                <TableCell align="right" sx={{ ...mono, fontSize: 13 }}>{money(m.advances)}</TableCell>
                <TableCell align="right" sx={{ ...mono, fontSize: 13, fontWeight: 700 }}>{money(m.total)}</TableCell>
                <TableCell align="right" sx={{ ...mono, fontSize: 13, color: m.out > 0 ? 'error.main' : undefined }}>{money(m.out ?? 0)}</TableCell>
                <TableCell align="right" sx={{ ...mono, fontSize: 13, fontWeight: 700 }}>{money(m.net ?? m.total)}</TableCell>
              </TableRow>
            ))}
            {modes.length === 0 && <TableRow><TableCell colSpan={6} align="center" sx={{ py: 2, color: 'text.secondary' }}>No money received</TableCell></TableRow>}
          </TableBody>
        </Table>
        <Divider sx={{ my: 1 }} />
        <Box sx={{ display: 'flex', justifyContent: 'space-between' }}>
          <Typography fontWeight={700}>Total Money In</Typography>
          <Typography fontWeight={700} sx={mono}>{money(data.moneyIn?.total ?? 0)}</Typography>
        </Box>
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5, mb: 0.5 }}>
          Payments {money(data.moneyIn?.receiptsTotal ?? 0)} + Advances {money(data.moneyIn?.advancesTotal ?? 0)}
        </Typography>
        <Box sx={{ display: 'flex', justifyContent: 'space-between' }}>
          <Typography fontWeight={700}>Total Money Out</Typography>
          <Typography fontWeight={700} sx={mono}>{money(data.moneyOut?.total ?? 0)}</Typography>
        </Box>
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5, mb: 0.5 }}>
          Advances reversed today
        </Typography>
        <Divider sx={{ my: 0.5 }} />
        <Box sx={{ display: 'flex', justifyContent: 'space-between' }}>
          <Typography fontWeight={700}>Net Money Movement</Typography>
          <Typography fontWeight={700} sx={mono}>{money(data.net?.netMoneyMovement ?? data.moneyIn?.total ?? 0)}</Typography>
        </Box>
      </CardContent>
    </Card>
  );
}
