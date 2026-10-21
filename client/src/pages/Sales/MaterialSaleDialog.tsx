import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Dialog, DialogTitle, DialogContent, DialogActions, Button, Grid, MenuItem, TextField, Typography, Alert } from '@mui/material';
import { apiGet } from '../../api/client';

export interface MaterialSaleEntry { metal: string; karat: string; weight: number; pieces: number; rate: number; }

interface Props {
  open: boolean;
  karats: Array<{ code: string; metalType: string; isActive?: boolean }>;
  rateByKarat: Record<string, number>;
  /** Grams of this karat already sitting on the open invoice as material lines (so a second line sees what is left). */
  inCartByKarat?: Record<string, number>;
  onClose: () => void;
  onAdd: (e: MaterialSaleEntry) => void;
}

const METALS = ['GOLD', 'SILVER'];
const r3 = (n: number) => Math.round(n * 1000) / 1000;

/** Total grams in a list of Metal Vault lots (GET /inventory/metals). Display only — the server's FIFO consume is the authority. */
export function sumVaultLots(lots: Array<{ availableWt: number | string }> | undefined | null): number {
  return r3((lots ?? []).reduce((s, l) => s + Number(l.availableWt || 0), 0));
}

/** Grams still sellable for display, or null when the vault figure is unknown. */
export function remainingVault(vault: number | null, inCart: number): number | null {
  return vault === null ? null : r3(vault - inCart);
}

/** Shortage in grams (0 when covered or when the vault figure is unknown — the server then decides). */
export function vaultShortage(remaining: number | null, weight: number): number {
  return remaining !== null && weight > remaining + 0.0005 ? r3(weight - remaining) : 0;
}

/** What the availability request asks the server for. `metalType` makes the server return only the lots a sale of that metal can
 *  draw from (GOLD = GOLD + legacy NULL lots, SILVER = SILVER lots only) - the same rule the sale itself enforces - so the figure
 *  shown here is never more than the server will accept. */
export const vaultQueryParams = (karat: string, metal?: string) => ({ karat, ...(metal && { metalType: metal }) });
export const vaultQueryKey = (karat: string, metal?: string) => ['vault-availability', karat, metal ?? ''];

/** Vault grams for a karat of a metal; null while loading or if the caller may not read stock (then the server still enforces it). */
export function useVaultGrams(karat: string, enabled = true, metal?: string): number | null {
  const { data } = useQuery({
    queryKey: vaultQueryKey(karat, metal),
    queryFn: () => apiGet<any>('/inventory/metals', vaultQueryParams(karat, metal)),
    enabled: enabled && !!karat,
    retry: false,
    staleTime: 0,
  });
  if (!data) return null;
  return sumVaultLots((data as any)?.data ?? data);
}

export function VaultAvailability({ karat, weight, inCart, metal }: { karat: string; weight: number; inCart: number; metal?: string }) {
  const vault = useVaultGrams(karat, true, metal);
  const remaining = remainingVault(vault, inCart);
  const short = vaultShortage(remaining, weight);
  if (!karat) return null;
  if (remaining === null) {
    return <Typography variant="body2" color="text.secondary">Available Vault Stock: checking… (the server confirms on save)</Typography>;
  }
  return (
    <>
      <Typography variant="body2" data-testid="vault-available" color={short ? 'error' : 'text.secondary'}>
        Available Vault Stock: <b>{remaining.toFixed(3)} g</b>{inCart > 0 ? ` (${r3(inCart).toFixed(3)} g already on this invoice)` : ''}
      </Typography>
      {short > 0 && <Alert severity="error" sx={{ mt: 1 }}>Short by {short.toFixed(3)} g — not enough {karat} in the Metal Vault.</Alert>}
    </>
  );
}

/** Loose gold/silver sold straight out of the Metal Vault. The server prices and stock-checks the line again on save. */
export function MaterialSaleDialog({ open, karats, rateByKarat, inCartByKarat = {}, onClose, onAdd }: Props) {
  const [metal, setMetal] = useState('GOLD');
  const [karat, setKarat] = useState('');
  const [weight, setWeight] = useState('');
  const [pieces, setPieces] = useState('1');
  const [rate, setRate] = useState('');
  const [error, setError] = useState('');

  const options = karats.filter((k) => k.metalType === metal && k.isActive !== false);
  const masterRate = karat ? rateByKarat[karat] : undefined;
  const vault = useVaultGrams(karat, open, metal);
  const remaining = remainingVault(vault, inCartByKarat[karat] ?? 0);
  const short = vaultShortage(remaining, Number(weight) || 0);

  useEffect(() => {
    if (!open) return;
    setMetal('GOLD'); setKarat(''); setWeight(''); setPieces('1'); setRate(''); setError('');
  }, [open]);

  const pickKarat = (code: string) => {
    setKarat(code); setError('');
    setRate(rateByKarat[code] ? String(rateByKarat[code]) : '');
  };

  const value = Math.round((Number(weight) || 0) * (Number(rate) || 0) * 100) / 100;

  const submit = () => {
    const w = Number(weight), r = Number(rate), p = Number(pieces);
    if (!metal) return setError('Metal is required');
    if (!karat) return setError('Karat / purity is required');
    if (!(w > 0)) return setError('Weight must be greater than 0');
    if (!Number.isInteger(p) || p < 1) return setError('Pieces must be a whole number, at least 1');
    if (rate === '' || !(r >= 0)) return setError('Rate must be 0 or more');
    if (short > 0) return setError(`Short by ${short.toFixed(3)} g in the Metal Vault`);
    onAdd({ metal, karat, weight: w, pieces: p, rate: r });
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="xs" fullWidth>
      <DialogTitle fontWeight={700}>Material Sale</DialogTitle>
      <DialogContent>
        <Grid container spacing={2} sx={{ pt: 1 }}>
          <Grid item xs={6}>
            <TextField select fullWidth size="small" label="Material" value={metal} autoFocus
              onChange={(e) => { setMetal(e.target.value); setKarat(''); setRate(''); }}>
              {METALS.map((m) => <MenuItem key={m} value={m}>{m === 'GOLD' ? 'Gold' : 'Silver'}</MenuItem>)}
            </TextField>
          </Grid>
          <Grid item xs={6}>
            <TextField select fullWidth size="small" label="Karat / Purity" value={karat} onChange={(e) => pickKarat(e.target.value)}>
              {options.map((k) => <MenuItem key={k.code} value={k.code}>{k.code}</MenuItem>)}
            </TextField>
          </Grid>
          <Grid item xs={12}>
            <VaultAvailability karat={karat} weight={Number(weight) || 0} inCart={inCartByKarat[karat] ?? 0} metal={metal} />
          </Grid>
          <Grid item xs={4}>
            <TextField fullWidth size="small" type="number" label="Weight (g)" value={weight}
              inputProps={{ step: 0.001, min: 0 }} onChange={(e) => setWeight(e.target.value)} />
          </Grid>
          <Grid item xs={3}>
            <TextField fullWidth size="small" type="number" label="Pieces" value={pieces}
              inputProps={{ step: 1, min: 1 }} onChange={(e) => setPieces(e.target.value)} />
          </Grid>
          <Grid item xs={5}>
            {/* Today's selling rate from the metal-rate master; typed by hand only when the master has none for this karat. */}
            <TextField fullWidth size="small" type="number" label="Rate / g" value={rate}
              disabled={!!masterRate} helperText={masterRate ? "Today's selling rate" : karat ? 'No rate set — enter one' : undefined}
              inputProps={{ step: 0.01, min: 0 }} onChange={(e) => setRate(e.target.value)} />
          </Grid>
          <Grid item xs={12}>
            <Typography variant="body2" color="text.secondary">Material Amount (Weight × Rate)</Typography>
            <Typography variant="h6" sx={{ fontFamily: 'monospace' }}>₹{value.toLocaleString('en-IN', { maximumFractionDigits: 2 })}</Typography>
          </Grid>
          {error && <Grid item xs={12}><Alert severity="error">{error}</Alert></Grid>}
        </Grid>
      </DialogContent>
      <DialogActions sx={{ p: 2 }}>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="contained" onClick={submit} disabled={short > 0}>Add</Button>
      </DialogActions>
    </Dialog>
  );
}
