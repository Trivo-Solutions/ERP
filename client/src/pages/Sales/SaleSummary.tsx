import { Box, Card, Chip, Stack, Typography } from '@mui/material';

// The bill as it will be raised, laid out the way a jeweller reads it: what the piece is made of (metal, stones,
// labour), the gross, then everything added and taken off it, and the net the customer pays. Figures are computed
// by the New Sale screen the same way createInvoice prices them; this only presents them.

export interface SaleFigures {
  grossWeight: number;
  gold: number;
  stone: number;
  mc: number;                // making charge (labour)
  va: number;                // value addition
  subtotal: number;          // gold + stone + MC + VA
  otherCharges: number;
  discount: number;
  taxable: number;
  // GST by rate: the amount at each distinct rate (a fraction, 0.03 = 3%). Split into CGST + SGST when the supply is
  // within the company's state, IGST otherwise.
  gst: Array<{ rate: number; amount: number }>;
  sameState: boolean;
  currency: string;
  roundOff: number;
  total: number;
}

const fmt2 = (n: number) => Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pct = (r: number) => `${Number((r * 100).toFixed(3))}%`;

function Section({ children }: { children: React.ReactNode }) {
  return (
    <Typography variant="overline" fontWeight={700} color="primary"
      sx={{ display: 'block', bgcolor: 'action.hover', px: 2, py: 0.5, lineHeight: 1.8 }}>
      {children}
    </Typography>
  );
}

function Row({ label, hint, amount, sign, strong, muted }: {
  label: string; hint?: string; amount: number; sign?: '+' | '−'; strong?: boolean; muted?: boolean;
}) {
  return (
    <Stack direction="row" justifyContent="space-between" alignItems="baseline" spacing={2}
      sx={{ px: 2, py: 0.6, ...(strong && { borderTop: 1, borderColor: 'divider', mt: 0.25 }) }}>
      <Typography variant="body2" fontWeight={strong ? 700 : 400} color={muted ? 'text.secondary' : 'text.primary'}>
        {label}
        {hint && <Typography component="span" variant="caption" color="text.secondary" sx={{ ml: 0.75 }}>{hint}</Typography>}
      </Typography>
      <Typography variant="body2" fontWeight={strong ? 700 : 400} sx={{ fontFamily: 'monospace', whiteSpace: 'nowrap' }}>
        {sign ? `${sign} ` : ''}{fmt2(Math.abs(amount))}
      </Typography>
    </Stack>
  );
}

export function SaleSummary({ f }: { f: SaleFigures }) {
  const symbol = f.currency === 'INR' ? '₹' : `${f.currency} `;
  return (
    <Card sx={{ p: 0, overflow: 'hidden' }}>
      <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ px: 2, py: 1.25, borderBottom: 1, borderColor: 'divider' }}>
        <Typography variant="subtitle1" fontWeight={700}>Summary</Typography>
        <Chip size="small" color="secondary" variant="outlined" label={`Gross Wt ${f.grossWeight.toFixed(3)} g`} sx={{ fontFamily: 'monospace' }} />
      </Stack>

      <Section>Material &amp; Labour</Section>
      <Row label="Gold" amount={f.gold} />
      {f.stone > 0.005 && <Row label="Stone" amount={f.stone} />}
      <Row label="Making Charge (MC)" amount={f.mc} />
      <Row label="Value Addition (VA)" amount={f.va} />
      <Row label="Gross Amount" amount={f.subtotal} strong />

      <Section>Add &amp; Less</Section>
      {f.otherCharges > 0.005 && <Row label="Shipping / Other" amount={f.otherCharges} sign="+" />}
      {f.discount > 0.005 && <Row label="Discount" amount={f.discount} sign="−" />}
      {(f.otherCharges > 0.005 || f.discount > 0.005) && <Row label="Taxable Amount" amount={f.taxable} muted />}
      {f.gst.length === 0 && <Row label="GST" hint={f.currency === 'INR' ? undefined : 'not charged'} amount={0} muted />}
      {f.gst.map((g) => f.sameState ? (
        <Box key={g.rate}>
          <Row label={`CGST ${pct(g.rate / 2)}`} amount={g.amount / 2} sign="+" />
          <Row label={`SGST ${pct(g.rate / 2)}`} amount={g.amount / 2} sign="+" />
        </Box>
      ) : (
        <Row key={g.rate} label={`IGST ${pct(g.rate)}`} amount={g.amount} sign="+" />
      ))}
      <Row label="Round off" hint={Math.abs(f.roundOff) < 0.005 ? 'none' : undefined} amount={f.roundOff}
        sign={Math.abs(f.roundOff) < 0.005 ? undefined : f.roundOff > 0 ? '+' : '−'} />

      <Stack direction="row" justifyContent="space-between" alignItems="center"
        sx={{ px: 2, py: 1.5, mt: 0.5, borderTop: 2, borderColor: 'secondary.main', bgcolor: 'action.hover' }}>
        <Typography fontWeight={700} color="secondary.dark">Net Amount</Typography>
        <Typography variant="h6" fontWeight={700} sx={{ fontFamily: 'monospace' }}>{symbol}{fmt2(f.total)}</Typography>
      </Stack>
    </Card>
  );
}
