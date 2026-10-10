import { useEffect, useState, type ReactNode } from 'react';
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
  // Offers: the tag's own material row (so the server can find its tagged rate) and the rate before an offer lowered it.
  materialId?: string;
  baseRate?: number;
}

export interface EstimateBreakdown {
  rows: EstimateRow[];
  mcRate: number;      // ₹ per gram of metal
  vaPercent: number;   // % of metal value
  // Offers: the tagged MC / VA an applied offer lowered (so "Remove offer" can put them back).
  baseMcRate?: number;
  baseVaPercent?: number;
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
    // Making charge (labour, ₹/g of metal) and value addition (a % of the metal's value), shown as their own lines.
    mcAmount: t.metalWeight * Number(b.mcRate || 0),
    vaAmount: (metalAmount * Number(b.vaPercent || 0)) / 100,
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

export function EstimateBreakdownDialog({
  title, quotedTotal, value, onClose, onSave, onChange, heading, leftActions, summaryExtra, applyLabel,
}: {
  title: string;
  quotedTotal: number;
  value: EstimateBreakdown | null;
  onClose: () => void;
  onSave: (b: EstimateBreakdown) => void;
  // Controlled mode (used by the multi-tag Material Pricing dialog): when `onChange` is given, `value` IS the draft and
  // every edit is reported through `onChange`; the dialog keeps no draft of its own, so a parent can swap `value` between
  // pieces and keep each piece's edits.
  onChange?: (b: EstimateBreakdown) => void;
  heading?: ReactNode;        // replaces the plain title + hint
  leftActions?: ReactNode;    // left side of the footer (e.g. Previous / Next)
  summaryExtra?: ReactNode;   // under the line total (e.g. the bill total)
  applyLabel?: string;
}) {
  const controlled = !!onChange;
  const [ownDraft, setOwnDraft] = useState<EstimateBreakdown | null>(value);
  useEffect(() => { if (!controlled) setOwnDraft(value); }, [value, controlled]);
  const draft = controlled ? value : ownDraft;
  const setDraft = (next: EstimateBreakdown | null | ((d: EstimateBreakdown | null) => EstimateBreakdown | null)) => {
    const resolved = typeof next === 'function' ? next(draft) : next;
    if (controlled) { if (resolved) onChange!(resolved); } else setOwnDraft(resolved);
  };

  if (!draft) return null;
  const totals = estimateTotals(draft);
  const patchRow = (key: string, patch: Partial<EstimateRow>) =>
    setDraft((d) => d && ({ ...d, rows: d.rows.map((r) => (r.key === key ? { ...r, ...patch } : r)) }));

  return (
    <Dialog open onClose={onClose} maxWidth="md" fullWidth>
      <DialogTitle fontWeight={700}>
        {heading ?? (<>
          {title}
          <Typography variant="caption" display="block" color="text.secondary">
            Change a rate, delete a row or add one — the line price follows. Only this bill changes — the tag and any saved estimate are left as they are.
          </Typography>
        </>)}
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
              {/* Labour on the metal, in the same Weight / Rate / Amount columns as the materials above. */}
              <TableRow sx={{ bgcolor: 'action.hover' }}>
                <TableCell>
                  <Typography variant="body2" fontWeight={600}>Making Charge (MC)</Typography>
                  <Typography variant="caption" color="text.secondary">₹ per gram of metal</Typography>
                </TableCell>
                <TableCell><Typography variant="caption" color="text.secondary">LABOUR</Typography></TableCell>
                <TableCell align="right" sx={{ fontFamily: 'monospace' }}>{totals.metalWeight.toFixed(3)}</TableCell>
                <TableCell align="right">
                  <NumberField size="small" value={draft.mcRate} inputProps={{ step: 0.01, min: 0, style: { textAlign: 'right' } }}
                    onChange={(e) => setDraft({ ...draft, mcRate: Number(e.target.value) })} />
                </TableCell>
                <TableCell align="right" sx={{ fontFamily: 'monospace' }}>{fmt(totals.mcAmount)}</TableCell>
                <TableCell />
              </TableRow>
              <TableRow sx={{ bgcolor: 'action.hover' }}>
                <TableCell>
                  <Typography variant="body2" fontWeight={600}>Value Addition (VA)</Typography>
                  <Typography variant="caption" color="text.secondary">% of the metal's value ({fmt(totals.metalAmount)})</Typography>
                </TableCell>
                <TableCell><Typography variant="caption" color="text.secondary">LABOUR</Typography></TableCell>
                <TableCell align="right" sx={{ color: 'text.disabled' }}>—</TableCell>
                <TableCell align="right">
                  <NumberField size="small" value={draft.vaPercent} inputProps={{ step: 0.01, min: 0, style: { textAlign: 'right' } }}
                    onChange={(e) => setDraft({ ...draft, vaPercent: Number(e.target.value) })} />
                </TableCell>
                <TableCell align="right" sx={{ fontFamily: 'monospace' }}>{fmt(totals.vaAmount)}</TableCell>
                <TableCell />
              </TableRow>
            </TableBody>
          </Table>
        </Box>
        <Button size="small" startIcon={<Add />} sx={{ mt: 1 }}
          onClick={() => setDraft((d) => d && ({ ...d, rows: [...d.rows, { key: newRowKey(), code: '', materialType: 'STONE', name: '', weight: 0, unit: 'CT', rate: 0 }] }))}>
          Add row
        </Button>

        <Divider sx={{ my: 2 }} />
        <Grid container spacing={2} alignItems="center">
          <Grid item xs={12}>
            <Stack spacing={0.25} alignItems="flex-end">
              <Typography variant="body2" color="text.secondary">Materials {fmt(totals.metalAmount + totals.otherMaterials)} · MC {fmt(totals.mcAmount)} · VA {fmt(totals.vaAmount)}</Typography>
              <Typography variant="h6" fontWeight={800} sx={{ fontFamily: 'monospace' }}>{fmt(totals.total)}</Typography>
              {Math.abs(totals.total - quotedTotal) > 0.005 && (
                <Typography variant="caption" color="warning.main">
                  Quoted {fmt(quotedTotal)} · {totals.total > quotedTotal ? '+' : '−'}{fmt(Math.abs(totals.total - quotedTotal))}
                </Typography>
              )}
              {summaryExtra}
            </Stack>
          </Grid>
        </Grid>
        {totals.metalWeight === 0 && draft.rows.length > 0 && (
          <Alert severity="info" sx={{ mt: 2 }}>No METAL row — making charge and VA apply to metal weight/value, so they will be zero.</Alert>
        )}
      </DialogContent>
      <DialogActions sx={{ p: 2.5 }}>
        {leftActions && <Box sx={{ mr: 'auto' }}>{leftActions}</Box>}
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="contained" onClick={() => onSave(draft)}>{applyLabel ?? 'Apply to bill'}</Button>
      </DialogActions>
    </Dialog>
  );
}
