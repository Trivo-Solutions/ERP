import { useEffect, useMemo, useRef, useState } from 'react';
import { Box, Button, Chip, Stack, Typography } from '@mui/material';
import { ChevronLeft, ChevronRight } from '@mui/icons-material';
import { EstimateBreakdown, EstimateBreakdownDialog, estimateTotals } from './EstimateBreakdown';

// Material Pricing (F4): one editing session over every eligible tagged line of the bill. Each piece keeps its OWN
// draft; stepping Previous / Next only changes which piece is on screen — nothing is saved until "Apply to bill", and
// Cancel throws every edit away. The editor itself is the Estimation screen's EstimateBreakdownDialog (controlled mode).
// The prices shown here are a preview: the server re-prices every line from the stored rows.

export interface MaterialPricingEntry {
  key: string;                    // the sale line's key
  tagNumber: string;              // "Jewel Code"
  description: string;
  initial: EstimateBreakdown;     // what the piece opened with (its saved breakdown, else built from the tag)
  currentLineTotal: number;       // what the grid shows for this line right now
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const fmt = (n: number) => '₹' + Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });

// Row keys are UI-only; compare on the figures that are actually priced.
function signature(b: EstimateBreakdown) {
  return JSON.stringify({
    rows: b.rows.map((r) => [r.code, r.materialType, r.name, Number(r.weight), r.unit, Number(r.rate)]),
    mc: Number(b.mcRate), va: Number(b.vaPercent),
  });
}

export function MaterialPricingDialog({ entries, startKey, otherLinesTotal, onClose, onApply }: {
  entries: MaterialPricingEntry[];
  startKey: string;
  otherLinesTotal: number;        // grid totals of every line that is not part of this session (custom lines, locked ones)
  onClose: () => void;
  onApply: (changed: Array<{ key: string; breakdown: EstimateBreakdown; quotedTotal: number }>) => void;
}) {
  const [index, setIndex] = useState(Math.max(0, entries.findIndex((e) => e.key === startKey)));
  const [drafts, setDrafts] = useState<Record<string, EstimateBreakdown>>(() =>
    Object.fromEntries(entries.map((e) => [e.key, e.initial])));

  const isChanged = (e: MaterialPricingEntry) => signature(drafts[e.key]) !== signature(e.initial);
  const changedCount = entries.filter(isChanged).length;
  const entry = entries[index];

  const go = (delta: number) => setIndex((i) => Math.min(entries.length - 1, Math.max(0, i + delta)));
  const goRef = useRef(go);
  goRef.current = go;
  useEffect(() => {
    // Alt+Left / Alt+Right. Captured so the browser's own "back / forward" never fires.
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      if (e.key === 'ArrowLeft') { e.preventDefault(); e.stopPropagation(); goRef.current(-1); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); e.stopPropagation(); goRef.current(1); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  // The bill's subtotal as it would stand if applied now: an edited piece at its draft total, every other piece as
  // the grid shows it today.
  const billTotal = useMemo(() => round2(
    otherLinesTotal + entries.reduce((s, e) => s + (signature(drafts[e.key]) !== signature(e.initial)
      ? estimateTotals(drafts[e.key]).total : e.currentLineTotal), 0)), [entries, drafts, otherLinesTotal]);

  if (!entry) return null;
  const changed = isChanged(entry);
  const pieceTotal = round2(estimateTotals(drafts[entry.key]).total);

  return (
    <EstimateBreakdownDialog
      title={`${entry.tagNumber} — ${entry.description}`}
      quotedTotal={entry.currentLineTotal}
      value={drafts[entry.key]}
      onChange={(b) => setDrafts((d) => ({ ...d, [entry.key]: b }))}
      onClose={onClose}
      onSave={() => onApply(entries.filter(isChanged).map((e) => ({
        key: e.key, breakdown: drafts[e.key], quotedTotal: e.currentLineTotal,
      })))}
      applyLabel={changedCount > 0 ? `Apply to bill (${changedCount} changed)` : 'Apply to bill'}
      heading={
        <Box>
          <Stack direction="row" spacing={1.5} alignItems="center" flexWrap="wrap" useFlexGap>
            <Typography variant="h6" fontWeight={800}>Material Pricing</Typography>
            <Chip size="small" color="primary" label={`Tag ${index + 1} of ${entries.length}`} />
            {changed
              ? <Chip size="small" color="warning" label="Unsaved changes" />
              : <Chip size="small" variant="outlined" label="No changes" />}
          </Stack>
          <Stack direction="row" spacing={1.5} alignItems="baseline" sx={{ mt: 0.75 }}>
            <Typography sx={{ fontFamily: 'monospace', fontWeight: 800, fontSize: 18, color: '#44C47A' }}>{entry.tagNumber}</Typography>
            <Typography variant="body1" color="text.secondary" noWrap>{entry.description}</Typography>
          </Stack>
          <Typography variant="caption" display="block" color="text.secondary">
            Change a rate, delete a row or add one — the price follows. Nothing is saved until Apply to bill, and only this bill
            changes: the tag and its cost are left as they are.
          </Typography>
        </Box>
      }
      leftActions={entries.length > 1 && (
        <Stack direction="row" spacing={1}>
          <Button startIcon={<ChevronLeft />} disabled={index === 0} onClick={() => go(-1)} title="Alt+Left">Previous</Button>
          <Button endIcon={<ChevronRight />} disabled={index === entries.length - 1} onClick={() => go(1)} title="Alt+Right">Next</Button>
        </Stack>
      )}
      summaryExtra={
        <Stack alignItems="flex-end" sx={{ mt: 0.5 }}>
          <Typography variant="caption" color="text.secondary">This piece {fmt(pieceTotal)}</Typography>
          <Typography variant="body2" fontWeight={700} sx={{ fontFamily: 'monospace' }}>Bill subtotal {fmt(billTotal)}</Typography>
        </Stack>
      }
    />
  );
}
