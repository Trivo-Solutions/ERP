import { useEffect, useMemo, useState } from 'react';
import {
  Alert, Box, Button, Card, CardContent, CircularProgress, FormControlLabel, Grid, MenuItem, Skeleton, Stack, Switch, TextField, Typography,
} from '@mui/material';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSnackbar } from 'notistack';
import { PageHeader } from '../../components/common/PageHeader';
import {
  getSettings, saveSettings, photoKeys, errorMessage,
  type PhotographySettingsResponse, type PhotographySettingsValues,
} from './photographyApi';

type Key = keyof PhotographySettingsValues;
type FormValue = string | boolean;
export type SettingsForm = Record<Key, FormValue>;

const NUMBER_KEYS: Key[] = [
  'targetOptimizedSizeKB', 'minimumQuality', 'maximumQuality', 'maximumWidth', 'maximumHeight', 'minimumLongEdge',
  'thumbnailWidth', 'thumbnailHeight', 'thumbnailQuality', 'maxInputWidth', 'maxInputHeight',
];

/** API values → form state (numbers become strings so a field can be cleared while typing). */
export function toForm(s: PhotographySettingsValues): SettingsForm {
  const f: Record<string, FormValue> = {};
  for (const [k, v] of Object.entries(s)) f[k] = typeof v === 'number' ? String(v) : (v as FormValue);
  return f as SettingsForm;
}

/** Only the fields that differ from the loaded settings — the PUT merges, so unchanged fields are never resent. */
export function diffSettings(loaded: PhotographySettingsValues, form: SettingsForm): Partial<PhotographySettingsValues> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(loaded) as Key[]) {
    const cur = form[k];
    if (NUMBER_KEYS.includes(k)) {
      const num = cur === '' ? NaN : Number(cur);
      if (num !== loaded[k]) out[k] = num; // NaN is sent as-is → serialised null → the server's own validation message
    } else if (cur !== loaded[k]) out[k] = cur;
  }
  return out as Partial<PhotographySettingsValues>;
}

interface FieldProps {
  name: Key;
  label: string;
  form: SettingsForm;
  limits: PhotographySettingsResponse['limits'];
  set: (k: Key, v: FormValue) => void;
  helper?: string;
  unit?: string;
  disabled?: boolean;
}

function NumField({ name, label, form, limits, set, helper, unit, disabled }: FieldProps) {
  const lim = limits[name];
  const range = lim ? `Allowed: ${lim[0]}–${lim[1]}` : undefined;
  return (
    <TextField
      size="small" fullWidth type="number" label={label} value={form[name] as string} disabled={disabled}
      onChange={(e) => set(name, e.target.value)}
      inputProps={{ min: lim?.[0], max: lim?.[1], step: 1, 'aria-label': label }}
      InputProps={unit ? { endAdornment: <Typography variant="caption" color="text.secondary">{unit}</Typography> } : undefined}
      helperText={[helper, range].filter(Boolean).join(' · ') || undefined}
    />
  );
}

function Toggle({ name, label, form, set, disabled, helper }: Pick<FieldProps, 'name' | 'label' | 'form' | 'set' | 'disabled' | 'helper'>) {
  return (
    <Box>
      <FormControlLabel
        control={<Switch checked={!!form[name]} disabled={disabled} onChange={(e) => set(name, e.target.checked)} inputProps={{ 'aria-label': label }} />}
        label={label}
      />
      {helper && <Typography variant="caption" color="text.secondary" display="block" sx={{ ml: 6, mt: -0.5 }}>{helper}</Typography>}
    </Box>
  );
}

function FormatField({ name, label, form, set, formats }: { name: Key; label: string; form: SettingsForm; set: FieldProps['set']; formats: string[] }) {
  return (
    <TextField select size="small" fullWidth label={label} value={form[name] as string} onChange={(e) => set(name, e.target.value)}>
      {formats.map((f) => <MenuItem key={f} value={f}>{f}</MenuItem>)}
    </TextField>
  );
}

interface FormViewProps {
  data: PhotographySettingsResponse;
  form: SettingsForm;
  setField: (k: Key, v: FormValue) => void;
  dirty: boolean;
  saving: boolean;
  error?: string | null;
  onSave: () => void;
  onReset: () => void;
}

/** Presentational — renders whatever the API returned; no value is defaulted here. */
export function SettingsFormView({ data, form, setField, dirty, saving, error, onSave, onReset }: FormViewProps) {
  const p = { form, limits: data.limits, set: setField };
  return (
    <Stack spacing={2}>
      {data.usingDefaults && (
        <Alert severity="info">No settings have been saved for this company yet — the values shown are the server's defaults.</Alert>
      )}
      {error && <Alert severity="error" role="alert">{error}</Alert>}

      <Card><CardContent>
        <Typography variant="subtitle1" fontWeight={700} gutterBottom>Optimized image</Typography>
        <Alert severity="info" variant="outlined" sx={{ mb: 2 }}>
          The system will attempt to keep the optimized image at or below the configured target size. Very complex images may not
          always reach the target without excessive quality loss.
        </Alert>
        <Grid container spacing={2}>
          <Grid item xs={12}><Toggle name="generateOptimized" label="Generate optimized image" form={form} set={setField} /></Grid>
          <Grid item xs={12} sm={6} md={4}><NumField {...p} name="targetOptimizedSizeKB" label="Target optimized size" unit="KB" /></Grid>
          <Grid item xs={12} sm={6} md={4}><NumField {...p} name="minimumQuality" label="Minimum quality" /></Grid>
          <Grid item xs={12} sm={6} md={4}><NumField {...p} name="maximumQuality" label="Maximum quality" /></Grid>
          <Grid item xs={12} sm={6} md={4}><NumField {...p} name="maximumWidth" label="Maximum width" unit="px" /></Grid>
          <Grid item xs={12} sm={6} md={4}><NumField {...p} name="maximumHeight" label="Maximum height" unit="px" /></Grid>
          <Grid item xs={12} sm={6} md={4}><NumField {...p} name="minimumLongEdge" label="Minimum long edge" unit="px" helper="Size-targeting never shrinks below this" /></Grid>
          <Grid item xs={12} sm={6} md={4}><FormatField name="optimizedFormat" label="Optimized format" form={form} set={setField} formats={data.formats} /></Grid>
        </Grid>
      </CardContent></Card>

      <Card><CardContent>
        <Typography variant="subtitle1" fontWeight={700} gutterBottom>Thumbnail</Typography>
        <Grid container spacing={2}>
          <Grid item xs={12}><Toggle name="generateThumbnail" label="Generate thumbnail" form={form} set={setField} /></Grid>
          <Grid item xs={12} sm={6} md={4}><NumField {...p} name="thumbnailWidth" label="Thumbnail width" unit="px" /></Grid>
          <Grid item xs={12} sm={6} md={4}><NumField {...p} name="thumbnailHeight" label="Thumbnail height" unit="px" /></Grid>
          <Grid item xs={12} sm={6} md={4}><NumField {...p} name="thumbnailQuality" label="Thumbnail quality" /></Grid>
          <Grid item xs={12} sm={6} md={4}><FormatField name="thumbnailFormat" label="Thumbnail format" form={form} set={setField} formats={data.formats} /></Grid>
          <Grid item xs={12} sm={6} md={8}>
            <Toggle name="thumbnailCrop" label="Crop to fill" form={form} set={setField} helper="Off = fit inside the box keeping the aspect ratio" />
          </Grid>
        </Grid>
      </CardContent></Card>

      <Card><CardContent>
        <Typography variant="subtitle1" fontWeight={700} gutterBottom>Original image &amp; handling</Typography>
        <Grid container spacing={2}>
          <Grid item xs={12} md={6}>
            <Toggle name="keepOriginal" label="Keep original" form={form} set={setField} disabled
              helper="Always on — every photo needs its original. This cannot be turned off." />
          </Grid>
          <Grid item xs={12} md={6}><Toggle name="autoOrient" label="Auto orientation" form={form} set={setField} /></Grid>
          <Grid item xs={12} sm={6} md={4}><NumField {...p} name="maxInputWidth" label="Maximum input width" unit="px" /></Grid>
          <Grid item xs={12} sm={6} md={4}><NumField {...p} name="maxInputHeight" label="Maximum input height" unit="px" /></Grid>
        </Grid>
      </CardContent></Card>

      <Box sx={{ display: 'flex', gap: 1, justifyContent: 'flex-end' }}>
        <Button onClick={onReset} disabled={!dirty || saving}>Reset</Button>
        <Button variant="contained" onClick={onSave} disabled={!dirty || saving}
          startIcon={saving ? <CircularProgress size={16} color="inherit" /> : undefined}>
          {saving ? 'Saving…' : 'Save settings'}
        </Button>
      </Box>
    </Stack>
  );
}

export function PhotographySettingsPage() {
  const qc = useQueryClient();
  const { enqueueSnackbar } = useSnackbar();
  const { data, isLoading, error } = useQuery({ queryKey: photoKeys.settings, queryFn: getSettings });
  const [form, setForm] = useState<SettingsForm | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  // (Re)seed the form whenever the server copy changes (first load, and after a save).
  useEffect(() => { if (data) setForm(toForm(data.settings)); }, [data]);

  const patch = useMemo(() => (data && form ? diffSettings(data.settings, form) : {}), [data, form]);
  const dirty = Object.keys(patch).length > 0;

  const save = useMutation({
    mutationFn: () => saveSettings(patch),
    onSuccess: (res) => {
      setSaveError(null);
      qc.setQueryData(photoKeys.settings, res);
      enqueueSnackbar('Photography settings saved', { variant: 'success' });
    },
    onError: (e) => setSaveError(errorMessage(e, 'Failed to save settings')),
  });

  return (
    <Box>
      <PageHeader title="Photography Settings" subtitle="Company-wide image processing" />
      {error ? (
        <Alert severity="error" role="alert">{errorMessage(error, 'Failed to load settings')}</Alert>
      ) : isLoading || !data || !form ? (
        <Stack spacing={2}>{[0, 1, 2].map((i) => <Skeleton key={i} variant="rounded" height={160} />)}</Stack>
      ) : (
        <SettingsFormView
          data={data} form={form} dirty={dirty} saving={save.isPending} error={saveError}
          setField={(k, v) => { setSaveError(null); setForm((f) => (f ? { ...f, [k]: v } : f)); }}
          onSave={() => save.mutate()}
          onReset={() => { setSaveError(null); setForm(toForm(data.settings)); }}
        />
      )}
    </Box>
  );
}
