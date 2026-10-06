import { useEffect, useState } from 'react';
import { Dialog, DialogTitle, DialogContent, DialogActions, Button, Grid, MenuItem, TextField, Typography, Alert } from '@mui/material';

export interface MaterialSaleEntry { metal: string; karat: string; weight: number; rate: number; }

interface Props {
  open: boolean;
  karats: Array<{ code: string; metalType: string; isActive?: boolean }>;
  rateByKarat: Record<string, number>;
  onClose: () => void;
  onAdd: (e: MaterialSaleEntry) => void;
}

const METALS = ['GOLD', 'SILVER'];

/** Loose gold/silver sold straight out of the Metal Vault. The server prices and stock-checks the line again on save. */
export function MaterialSaleDialog({ open, karats, rateByKarat, onClose, onAdd }: Props) {
  const [metal, setMetal] = useState('GOLD');
  const [karat, setKarat] = useState('');
  const [weight, setWeight] = useState('');
  const [rate, setRate] = useState('');
  const [rateTouched, setRateTouched] = useState(false);
  const [error, setError] = useState('');

  const options = karats.filter((k) => k.metalType === metal && k.isActive !== false);

  useEffect(() => {
    if (!open) return;
    setMetal('GOLD'); setKarat(''); setWeight(''); setRate(''); setRateTouched(false); setError('');
  }, [open]);

  const pickKarat = (code: string) => {
    setKarat(code);
    if (!rateTouched) setRate(rateByKarat[code] ? String(rateByKarat[code]) : '');
  };

  const value = Math.round((Number(weight) || 0) * (Number(rate) || 0) * 100) / 100;

  const submit = () => {
    const w = Number(weight), r = Number(rate);
    if (!metal) return setError('Metal is required');
    if (!karat) return setError('Karat / purity is required');
    if (!(w > 0)) return setError('Weight must be greater than 0');
    if (rate === '' || !(r >= 0)) return setError('Rate must be 0 or more');
    onAdd({ metal, karat, weight: w, rate: r });
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="xs" fullWidth>
      <DialogTitle fontWeight={700}>Material Sale</DialogTitle>
      <DialogContent>
        <Grid container spacing={2} sx={{ pt: 1 }}>
          <Grid item xs={6}>
            <TextField select fullWidth size="small" label="Metal" value={metal} autoFocus
              onChange={(e) => { setMetal(e.target.value); setKarat(''); if (!rateTouched) setRate(''); }}>
              {METALS.map((m) => <MenuItem key={m} value={m}>{m === 'GOLD' ? 'Gold' : 'Silver'}</MenuItem>)}
            </TextField>
          </Grid>
          <Grid item xs={6}>
            <TextField select fullWidth size="small" label="Karat / Purity" value={karat} onChange={(e) => pickKarat(e.target.value)}>
              {options.map((k) => <MenuItem key={k.code} value={k.code}>{k.code}</MenuItem>)}
            </TextField>
          </Grid>
          <Grid item xs={6}>
            <TextField fullWidth size="small" type="number" label="Weight (g)" value={weight}
              inputProps={{ step: 0.001, min: 0 }} onChange={(e) => setWeight(e.target.value)} />
          </Grid>
          <Grid item xs={6}>
            <TextField fullWidth size="small" type="number" label="Rate / g" value={rate}
              inputProps={{ step: 0.01, min: 0 }} onChange={(e) => { setRate(e.target.value); setRateTouched(true); }} />
          </Grid>
          <Grid item xs={12}>
            <Typography variant="body2" color="text.secondary">Material Value (Weight × Rate)</Typography>
            <Typography variant="h6" sx={{ fontFamily: 'monospace' }}>₹{value.toLocaleString('en-IN', { maximumFractionDigits: 2 })}</Typography>
          </Grid>
          {error && <Grid item xs={12}><Alert severity="error">{error}</Alert></Grid>}
        </Grid>
      </DialogContent>
      <DialogActions sx={{ p: 2 }}>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="contained" onClick={submit}>Add</Button>
      </DialogActions>
    </Dialog>
  );
}
