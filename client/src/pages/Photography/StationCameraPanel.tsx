import { useState } from 'react';
import { Alert, Box, Button, Chip, CircularProgress, Stack, TextField, Typography } from '@mui/material';
import { PhotoCamera, Videocam } from '@mui/icons-material';
import type { CameraView } from './captureWorkflow';

/**
 * The station-camera section of the Capture page. Presentational only: the page owns the data (the bridge's last report,
 * read from the station list) and the actions. The browser never talks to the Camera Bridge — selection is a request the
 * ERP relays, and the status shown is what the bridge reported.
 */
export function StationCameraPanel({ view, capturing, selecting, onSelect, onCapture, tagReady = true }: {
  view: CameraView; capturing: boolean; selecting: boolean; onSelect: (cameraId: string) => void; onCapture: () => void;
  /** False until a tag is loaded: the camera status is still shown, but there is nothing to attach a photo to yet. */
  tagReady?: boolean;
}) {
  const [changing, setChanging] = useState(false);
  const mustPick = view.state === 'SELECTION_REQUIRED' || view.state === 'DISCONNECTED';
  // With one camera there is nothing to choose; with several, the picker opens on demand ("Change camera") or when a choice is required.
  const showPicker = mustPick || (view.cameras.length > 1 && changing);
  const canChange = view.cameras.length > 1 && !mustPick && view.canSelect;
  const shown = view.selected ?? (view.cameras.length === 1 ? view.cameras[0] : null);
  return (
    <Box component="section" aria-label="Station camera" sx={{ border: 1, borderColor: 'divider', borderRadius: 1, p: 1.5 }}>
      <Stack direction="row" spacing={1} alignItems="center" justifyContent="space-between" flexWrap="wrap" useFlexGap sx={{ mb: 1 }}>
        <Typography variant="subtitle2" fontWeight={700} sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
          <Videocam fontSize="small" /> Camera
        </Typography>
        <Chip size="small" variant="outlined" color={view.tone} role="status" label={view.label}
          icon={view.state === 'SWITCHING' ? <CircularProgress size={12} /> : undefined} />
      </Stack>

      {view.state === 'BRIDGE_OFFLINE' && (
        <Typography variant="body2" color="text.secondary">
          The station’s camera program is not reporting. Use Take photo or Choose file below.
        </Typography>
      )}

      {view.state === 'NO_CAMERA' && (
        <Typography variant="body2" color="text.secondary">
          No camera was found on this station. Plug one in, or use Take photo or Choose file below.
        </Typography>
      )}

      {view.state === 'DISCONNECTED' && (
        <Alert severity="error" role="alert" sx={{ mb: 1 }}>
          {view.selected ? `“${view.selected.displayName}” is disconnected.` : 'The selected camera is disconnected.'}{' '}
          It is not replaced automatically — reconnect it{view.cameras.some((c) => c.available) ? ' or choose another camera' : ''}.
        </Alert>
      )}

      {showPicker && (
        // A native <select>: arrow keys change the value while it is focused and closed (keyboard-first screens).
        <TextField select fullWidth size="small" label="Station camera" value={view.selected?.id ?? ''} disabled={capturing || selecting || !view.canSelect}
          onChange={(e) => { if (e.target.value) { onSelect(e.target.value); setChanging(false); } }} SelectProps={{ native: true }} InputLabelProps={{ shrink: true }} sx={{ mb: 1 }}>
          <option value="" disabled>Select a camera…</option>
          {view.cameras.map((c) => (
            <option key={c.id} value={c.id} disabled={!c.available}>{c.displayName}{c.available ? '' : ' (unavailable)'}</option>
          ))}
        </TextField>
      )}

      {!showPicker && shown && view.state !== 'DISCONNECTED' && (
        <Stack direction="row" spacing={1} alignItems="center" justifyContent="space-between" sx={{ mb: 1 }}>
          <Typography variant="body1" fontWeight={600}>{view.tone === 'success' ? '🟢 ' : ''}{shown.displayName}</Typography>
          {canChange && <Button size="small" disabled={capturing || selecting} onClick={() => setChanging(true)}>Change camera</Button>}
        </Stack>
      )}

      {view.state === 'UNREPORTED' && (
        <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>The station camera is online.</Typography>
      )}

      <Button variant="contained" size="large" fullWidth disabled={!view.canCapture || !tagReady || capturing || selecting} onClick={onCapture}
        sx={{ minHeight: 64, fontSize: 20, fontWeight: 700 }}
        startIcon={capturing ? <CircularProgress size={22} color="inherit" /> : <PhotoCamera />}>
        {capturing ? 'Capturing…' : 'Capture Photo'}
      </Button>
      {view.canCapture && !tagReady && <Typography variant="caption" color="text.secondary" sx={{ mt: 0.5, display: 'block' }}>Scan a tag to capture.</Typography>}
    </Box>
  );
}
