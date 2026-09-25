import { useEffect, useState } from 'react';
import {
  Alert, Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, Divider, Grid, IconButton, Stack,
  Table, TableBody, TableCell, TableHead, TableRow, TextField, Typography,
} from '@mui/material';
import { Add, Delete } from '@mui/icons-material';
import { NumberField } from '../../components/fields/NumberField';
import { SelectField } from '../../components/fields/SelectField';
import { computeEstimateTotals, computeLineAmount } from '../../utils/estimateCalc';

// An estimate loaded into the billing screen keeps its material rows (gold, stones, ...) and its making-charge /
// value-addition rates, so the biller can change a rate, drop a row or add one before billing. The line's price is
// always derived from these with the SAME formula the Estimation screen uses (utils/estimateCalc) — the invoice
// line is then sent as a flat (FIXED) amount equal to that total.

export interface EstimateRow {
  key: string;
  code: string;
  materialType: string;
  name: string;
  weight: number;
  unit: string;
  rate: number;
}

export interface EstimateBreakdown {
  rows: EstimateRow[];
  mcRate: number;      // ₹ per gram of metal
  vaPercent: number;   // % of metal value
}

const MATERIAL_TYPES = ['METAL', 'STONE', 'DIAMOND', 'FINDING', 'OTHER'];

export function estimateTotals(b: EstimateBreakdown) {
  const items = b.rows.map((r) => ({
    materialType: r.materialType, weight: r.weight, saleAmount: computeLineAmount(r.weight, r.rate),
  }));
  const t = computeEstimateTotals(items, { saleMcRate: b.mcRate, saleVaPercent: b.vaPercent });
  const metalAmount = items.filter((i) => i.materialType === 'METAL').reduce((s, i) => s + i.saleAmount, 0);
  return {
    total: t.totalSaleAmount,
    making: t.makingSaleAmount,
    metalWeight: t.metalWeight,
    metalAmount,
    otherMaterials: t.materialsSaleAmt - metalAmount,   // stones etc.
  };
}

function fmt(n: number) {
  return '₹' + Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });
}

let rowSeq = 0;
export const newRowKey = () => `r${++rowSeq}`;

export function EstimateBreakdownDialog({ title, quotedTotal, value, onClose, onSave }: {
  title: string;
  quotedTotal: number;
  value: EstimateBreakdown | null;
  onClose: () => void;
  onSave: (b: EstimateBreakdown) => void;
}) {
  const [draft, setDraft] = useState<EstimateBreakdown | null>(value);
  useEffect(() => { setDraft(value); }, [value]);

  if (!draft) return null;
  const totals = estimateTotals(draft);
  const patchRow = (key: string, patch: Partial<EstimateRow>) =>
    setDraft((d) => d && ({ ...d, rows: d.rows.map((r) => (r.key === key ? { ...r, ...patch } : r)) }));

  return (
    <Dialog open onClose={onClose} maxWidth="md" fullWidth>
      <DialogTitle fontWeight={700}>
        {title}
        <Typography variant="caption" display="block" color="text.secondary">
          Change a rate, delete a row or add one — the line price follows. The saved estimate itself is not changed.
        </Typography>
      </DialogTitle>
      <DialogContent>
        <Box sx={{ overflowX: 'auto' }}>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Material</TableCell>
                <TableCell sx={{ width: 120 }}>Type</TableCell>
                <TableCell align="right" sx={{ width: 110 }}>Weight</TableCell>
                <TableCell align="right" sx={{ width: 120 }}>Rate</TableCell>
                <TableCell align="right" sx={{ width: 110 }}>Amount</TableCell>
                <TableCell sx={{ width: 40 }} />
              </TableRow>
            </TableHead>
            <TableBody>
              {draft.rows.map((r) => (
                <TableRow key={r.key}>
                  <TableCell>
                    <TextField size="small" fullWidth value={r.name} placeholder="Name / code"
                      onChange={(e) => patchRow(r.key, { name: e.target.value, code: r.code || e.target.value })} />
                  </TableCell>
                  <TableCell>
                    <SelectField size="small" value={r.materialType}
                      options={MATERIAL_TYPES.map((t) => ({ value: t, label: t }))}
                      onChange={(e) => patchRow(r.key, { materialType: e.target.value })} />
                  </TableCell>
                  <TableCell align="right">
                    <NumberField size="small" value={r.weight} inputProps={{ step: 0.001, min: 0, style: { textAlign: 'right' } }}
                      onChange={(e) => patchRow(r.key, { weight: Number(e.target.value) })} />
                  </TableCell>
                  <TableCell align="right">
                    <NumberField size="small" value={r.rate} inputProps={{ step: 0.01, min: 0, style: { textAlign: 'right' } }}
                      onChange={(e) => patchRow(r.key, { rate: Number(e.target.value) })} />
                  </TableCell>
                  <TableCell align="right" sx={{ fontFamily: 'monospace' }}>{fmt(computeLineAmount(r.weight, r.rate))}</TableCell>
                  <TableCell>
                    <IconButton size="small" color="error" title="Remove this row"
                      onClick={() => setDraft((d) => d && ({ ...d, rows: d.rows.filter((x) => x.key !== r.key) }))}>
                      <Delete fontSize="small" />
                    </IconButton>
                  </TableCell>
                </TableRow>
              ))}
              {draft.rows.length === 0 && (
                <TableRow><TableCell colSpan={6}><Typography color="text.secondary">No rows — the line will price at the making charge only.</Typography></TableCell></TableRow>
              )}
            </TableBody>
          </Table>
        </Box>
        <Button size="small" startIcon={<Add />} sx={{ mt: 1 }}
          onClick={() => setDraft((d) => d && ({ ...d, rows: [...d.rows, { key: newRowKey(), code: '', materialType: 'STONE', name: '', weight: 0, unit: 'CT', rate: 0 }] }))}>
          Add row
        </Button>

        <Divider sx={{ my: 2 }} />
        <Grid container spacing={2} alignItems="center">
          <Grid item xs={6} sm={3}>
            <NumberField size="small" label="Making (₹/g of metal)" value={draft.mcRate}
              onChange={(e) => setDraft({ ...draft, mcRate: Number(e.target.value) })} />
          </Grid>
          <Grid item xs={6} sm={3}>
            <NumberField size="small" label="VA % (of metal value)" value={draft.vaPercent}
              onChange={(e) => setDraft({ ...draft, vaPercent: Number(e.target.value) })} />
          </Grid>
          <Grid item xs={12} sm={6}>
            <Stack spacing={0.25} alignItems="flex-end">
              <Typography variant="body2" color="text.secondary">Materials {fmt(totals.metalAmount + totals.otherMaterials)} · Making {fmt(totals.making)}</Typography>
              <Typography variant="h6" fontWeight={800} sx={{ fontFamily: 'monospace' }}>{fmt(totals.total)}</Typography>
              {Math.abs(totals.total - quotedTotal) > 0.005 && (
                <Typography variant="caption" color="warning.main">
                  Quoted {fmt(quotedTotal)} · {totals.total > quotedTotal ? '+' : '−'}{fmt(Math.abs(totals.total - quotedTotal))}
                </Typography>
              )}
            </Stack>
          </Grid>
        </Grid>
        {totals.metalWeight === 0 && draft.rows.length > 0 && (
          <Alert severity="info" sx={{ mt: 2 }}>No METAL row — making charge and VA apply to metal weight/value, so they will be zero.</Alert>
        )}
      </DialogContent>
      <DialogActions sx={{ p: 2.5 }}>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="contained" onClick={() => onSave(draft)}>Apply to bill</Button>
      </DialogActions>
    </Dialog>
  );
}
