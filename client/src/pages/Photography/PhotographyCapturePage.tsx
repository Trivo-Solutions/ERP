import { useEffect, useReducer, useRef, useState } from 'react';
import {
  Alert, Box, Button, Card, CardActionArea, CardContent, Chip, CircularProgress, Dialog, DialogActions, DialogContent, DialogTitle,
  Grid, InputAdornment, LinearProgress, Skeleton, Stack, TextField, ToggleButton, ToggleButtonGroup, Typography,
} from '@mui/material';
import { QrCodeScanner, ImageNotSupported, DeleteOutline, Star, PhotoCamera, UploadFile, NavigateNext, CheckCircle } from '@mui/icons-material';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSnackbar } from 'notistack';
import { PageHeader } from '../../components/common/PageHeader';
import { PermissionGate } from '../../components/auth/PermissionGate';
import {
  IMAGE_TYPES, buildUploadForm, createCaptureCommand, deleteImage, errorMessage, getCaptureCommand, getImageUrl, listImages, listStations, lookupTag,
  photoKeys, requestCameraSelection, startBridgeSession, startCaptureSession, uploadImage,
  type ImageType, type ImageVariant, type PhotographyStation, type PhotographyTag, type TagImage,
} from './photographyApi';
import { StationCameraPanel } from './StationCameraPanel';
import {
  REMOTE_STAGE_LABEL, STEP_LABEL, captureReducer, deriveCameraView, deriveStep, ensureCaptureSession, formatBytes, initialCaptureState, initialRemoteState,
  isStationOnline, newIdempotencyKey, remoteIsActive, remoteReducer, remoteRequestError, resolveStation, stationFitsTag,
  sessionErrorMessage, uploadError, validateImageFile,
} from './captureWorkflow';

const fmtDate = (s: string | null | undefined) => (s ? new Date(s).toLocaleString('en-IN') : '—');

/**
 * Signed URLs are short-lived (the response carries its own TTL), so cache one per image+variant and only
 * refetch once ~80% of that lifetime has passed — never on every render.
 */
export function useSignedUrl(imageId: string, variant: ImageVariant, enabled = true) {
  return useQuery({
    queryKey: photoKeys.url(imageId, variant),
    queryFn: () => getImageUrl(imageId, variant),
    enabled,
    staleTime: (q) => Math.max(0, ((q.state.data?.expiresInSeconds ?? 0) * 1000) * 0.8),
    gcTime: 10 * 60 * 1000,
    retry: false,
  });
}

/** Thumbnail when the image has one, otherwise the optimized/original so the gallery is never blank. */
function bestSmallVariant(img: TagImage): ImageVariant {
  return img.variants.thumbnail ? 'thumbnail' : img.variants.optimized ? 'optimized' : 'original';
}
function bestLargeVariant(img: TagImage): ImageVariant {
  return img.variants.optimized ? 'optimized' : 'original';
}

export function ImageFigure({ img, variant, height, fit = 'cover' }: { img: TagImage; variant: ImageVariant; height: number | string; fit?: 'cover' | 'contain' }) {
  const { data, isLoading, isError } = useSignedUrl(img.id, variant);
  if (isLoading) return <Skeleton variant="rectangular" height={height} />;
  if (isError || !data) {
    return (
      <Box sx={{ height, display: 'flex', alignItems: 'center', justifyContent: 'center', bgcolor: 'action.hover', color: 'text.disabled' }}>
        <ImageNotSupported />
      </Box>
    );
  }
  return <Box component="img" src={data.url} alt={`${img.imageType} photo`} loading="lazy"
    sx={{ width: '100%', height, objectFit: fit, display: 'block', bgcolor: 'action.hover' }} />;
}

export function ImageCard({ img, onOpen }: { img: TagImage; onOpen: (i: TagImage) => void }) {
  return (
    <Card variant="outlined" sx={img.isPrimary ? { borderColor: 'primary.main', borderWidth: 2 } : undefined}>
      <CardActionArea onClick={() => onOpen(img)} aria-label={`Open ${img.imageType} photo`} sx={{ minHeight: 48 }}>
        <ImageFigure img={img} variant={bestSmallVariant(img)} height={150} />
        <CardContent sx={{ p: 1, '&:last-child': { pb: 1 } }}>
          <Stack direction="row" spacing={0.5} alignItems="center" flexWrap="wrap" useFlexGap>
            {img.isPrimary && <Chip size="small" color="primary" icon={<Star />} label="PRIMARY" />}
            <Chip size="small" variant="outlined" label={img.imageType} />
            {img.processingStatus !== 'READY' && (
              <Chip size="small" color={img.processingStatus === 'FAILED' ? 'error' : 'warning'} label={img.processingStatus} />
            )}
          </Stack>
        </CardContent>
      </CardActionArea>
    </Card>
  );
}

export function ImageGallery({ images, onOpen, typeFilter }: { images: TagImage[]; onOpen: (i: TagImage) => void; typeFilter: string | null }) {
  const shown = typeFilter ? images.filter((i) => i.imageType === typeFilter) : images;
  if (images.length === 0) return <Alert severity="info">No photos yet for this tag.</Alert>;
  if (shown.length === 0) return <Alert severity="info">No {typeFilter} photos for this tag.</Alert>;
  return (
    <Grid container spacing={1.5}>
      {shown.map((img) => <Grid item xs={6} sm={4} md={3} lg={2.4} key={img.id}><ImageCard img={img} onOpen={onOpen} /></Grid>)}
    </Grid>
  );
}

/** Metadata only — never storage keys or bucket names (the API doesn't return them). */
export function ImageMeta({ img }: { img: TagImage }) {
  const rows: Array<[string, string]> = [
    ['Photo type', img.imageType],
    ['Captured', fmtDate(img.capturedAt)],
    ['Station', img.station?.name ?? '—'],
    ['Processing', img.processingStatus],
    ['Review', img.reviewStatus ?? '—'],
    ['Source', img.captureSource ?? '—'],
  ];
  return (
    <Box component="dl" sx={{ m: 0, display: 'grid', gridTemplateColumns: 'auto 1fr', columnGap: 2, rowGap: 0.5 }}>
      {rows.map(([k, v]) => (
        <Box key={k} sx={{ display: 'contents' }}>
          <Typography component="dt" variant="caption" color="text.secondary">{k}</Typography>
          <Typography component="dd" variant="body2" sx={{ m: 0 }}>{v}</Typography>
        </Box>
      ))}
    </Box>
  );
}

function PreviewDialog({ img, onClose, onDelete }: { img: TagImage | null; onClose: () => void; onDelete: (i: TagImage) => void }) {
  return (
    <Dialog open={!!img} onClose={onClose} maxWidth="md" fullWidth>
      {img && (
        <>
          <DialogTitle>
            {img.isPrimary && <Chip size="small" color="primary" icon={<Star />} label="PRIMARY" sx={{ mr: 1 }} />}
            {img.imageType} photo
          </DialogTitle>
          <DialogContent>
            <ImageFigure img={img} variant={bestLargeVariant(img)} height="min(60vh, 560px)" fit="contain" />
            <Box sx={{ mt: 2 }}><ImageMeta img={img} /></Box>
          </DialogContent>
          <DialogActions>
            <PermissionGate permission="photography:delete">
              <Button color="error" startIcon={<DeleteOutline />} onClick={() => onDelete(img)} sx={{ mr: 'auto' }}>Delete</Button>
            </PermissionGate>
            <Button onClick={onClose}>Close</Button>
          </DialogActions>
        </>
      )}
    </Dialog>
  );
}

/** The server decides how short is too short; the UI only refuses a blank reason. */
export const isDeleteReasonProvided = (r: string) => r.trim().length > 0;

export function DeleteDialog({ img, onClose, onConfirm, busy, error }: {
  img: TagImage | null; onClose: () => void; onConfirm: (reason: string) => void; busy: boolean; error?: string | null;
}) {
  const [reason, setReason] = useState('');
  useEffect(() => { if (img) setReason(''); }, [img]);
  const blank = !isDeleteReasonProvided(reason);
  return (
    <Dialog open={!!img} onClose={busy ? undefined : onClose} maxWidth="xs" fullWidth>
      <DialogTitle>Delete this photo?</DialogTitle>
      <DialogContent>
        <Typography variant="body2" sx={{ mb: 2 }}>
          {img?.isPrimary ? 'This is the PRIMARY photo. ' : ''}The photo is removed from this tag. The action is recorded in the audit trail.
        </Typography>
        {error && <Alert severity="error" role="alert" sx={{ mb: 2 }}>{error}</Alert>}
        <TextField autoFocus fullWidth required multiline minRows={2} label="Reason for deleting" value={reason}
          onChange={(e) => setReason(e.target.value)} inputProps={{ maxLength: 500 }} />
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={busy}>Cancel</Button>
        <Button color="error" variant="contained" disabled={blank || busy} onClick={() => onConfirm(reason.trim())}
          startIcon={busy ? <CircularProgress size={16} color="inherit" /> : undefined}>
          Delete photo
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export function TagHeader({ tag }: { tag: PhotographyTag }) {
  const p = tag.photography;
  return (
    <Card sx={{ mb: 2 }}>
      <CardContent>
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} justifyContent="space-between">
          <Box>
            <Typography variant="h5" fontWeight={700}>{tag.tagNumber}</Typography>
            <Typography variant="body2" color="text.secondary">
              {[tag.name, tag.category?.name, tag.metalKarat && `${tag.metalKarat} ${tag.metalType ?? ''}`.trim()].filter(Boolean).join(' · ')}
            </Typography>
          </Box>
          <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
            <Chip label={`Branch: ${tag.branch?.name ?? '—'}`} variant="outlined" />
            <Chip label={tag.status} />
            <Chip label={`${p.imageCount} ${p.imageCount === 1 ? 'photo' : 'photos'}`} color={p.imageCount ? 'default' : 'warning'} />
            <Chip label={p.hasPrimary ? 'Has primary' : 'No primary yet'} color={p.hasPrimary ? 'success' : 'warning'} />
          </Stack>
        </Stack>
        <Typography variant="caption" color="text.secondary" sx={{ mt: 1, display: 'block' }}>
          Last captured: {fmtDate(p.lastCapturedAt)}
        </Typography>
      </CardContent>
    </Card>
  );
}

export function StationPicker({ stations, tag, selectedId, onSelect, disabled }: {
  stations: PhotographyStation[]; tag: PhotographyTag; selectedId?: string; onSelect: (s: PhotographyStation) => void; disabled?: boolean;
}) {
  // Showing only same-branch stations is a convenience; the server re-checks the branch rule when the session starts.
  const usable = stations.filter((s) => s.isActive && (!tag.branch || s.branchId === tag.branch.id));
  if (usable.length === 0) {
    return <Alert severity="warning">No capture station is available for {tag.branch?.name ?? 'this tag’s branch'}. Ask an administrator to set one up.</Alert>;
  }
  return (
    <Stack spacing={1}>
      {usable.map((s) => (
        <Card key={s.id} variant="outlined" sx={s.id === selectedId ? { borderColor: 'primary.main', borderWidth: 2 } : undefined}>
          <CardActionArea disabled={disabled} onClick={() => onSelect(s)} aria-pressed={s.id === selectedId} sx={{ minHeight: 48 }}>
            <CardContent sx={{ py: 1, '&:last-child': { pb: 1 } }}>
              <Stack direction="row" justifyContent="space-between" alignItems="center" spacing={1}>
                <Box>
                  <Typography fontWeight={600}>{s.name}</Typography>
                  <Typography variant="caption" color="text.secondary">{s.branchName}</Typography>
                </Box>
                <Stack direction="row" spacing={0.5}>
                  {/* Shown only when a bridge heartbeat is recent; its absence is never presented as "offline" (the manual route needs no bridge). */}
                  {isStationOnline(s) && <Chip size="small" variant="outlined" color="success" label="Camera online" />}
                  <Chip size="small" label={s.isActive ? 'Active' : 'Inactive'} color={s.isActive ? 'success' : 'default'} />
                </Stack>
              </Stack>
            </CardContent>
          </CardActionArea>
        </Card>
      ))}
    </Stack>
  );
}

export function PhotoTypeSelector({ value, onChange, disabled }: { value: ImageType; onChange: (t: ImageType) => void; disabled?: boolean }) {
  return (
    <ToggleButtonGroup exclusive size="small" value={value} disabled={disabled} aria-label="Photo type" sx={{ flexWrap: 'wrap' }}
      onChange={(_, v) => { if (v) onChange(v as ImageType); }}>
      {IMAGE_TYPES.map((t) => (
        <ToggleButton key={t} value={t} color={t === 'PRIMARY' ? 'primary' : 'standard'} sx={{ minHeight: 44, px: 2, fontWeight: t === 'PRIMARY' ? 700 : 400 }}>
          {t === 'PRIMARY' && <Star fontSize="small" sx={{ mr: 0.5 }} />}{t}
        </ToggleButton>
      ))}
    </ToggleButtonGroup>
  );
}

export function SelectedPhotoPreview({ file, url, photoType, progress, uploading, onUpload, onRetake }: {
  file: { name: string; size: number }; url: string | null; photoType: ImageType; progress: number | null; uploading: boolean; onUpload: () => void; onRetake: () => void;
}) {
  return (
    <Stack spacing={1.5}>
      {url && <Box component="img" src={url} alt="Selected photo preview" sx={{ width: '100%', maxHeight: 360, objectFit: 'contain', bgcolor: 'action.hover', borderRadius: 1 }} />}
      <Typography variant="body2">
        {file.name || 'Camera photo'} · {formatBytes(file.size)} · will be saved as <b>{photoType}</b>
      </Typography>
      {uploading && (
        <Box>
          <Typography variant="caption">Uploading…{progress != null ? ` ${Math.round(progress * 100)}%` : ''}</Typography>
          <LinearProgress variant={progress != null && progress > 0 ? 'determinate' : 'indeterminate'} value={(progress ?? 0) * 100} />
        </Box>
      )}
      <Stack direction="row" spacing={1}>
        <Button variant="contained" size="large" disabled={uploading} onClick={onUpload}
          startIcon={uploading ? <CircularProgress size={18} color="inherit" /> : <UploadFile />}>
          {uploading ? 'Uploading…' : 'Upload'}
        </Button>
        <Button variant="outlined" size="large" disabled={uploading} onClick={onRetake}>Choose another</Button>
      </Stack>
    </Stack>
  );
}

/** Shown after a photo is saved (manual or station camera): the one obvious next action is NEXT. */
export function PhotoSavedBanner({ image, replacedPrimary, onNext }: { image: TagImage; replacedPrimary?: boolean; onNext: () => void }) {
  return (
    <Alert severity={image.processingStatus === 'FAILED' ? 'warning' : 'success'} role="status" icon={<CheckCircle fontSize="inherit" />}
      sx={{ alignItems: 'center' }}
      action={<Button variant="contained" color="success" size="large" endIcon={<NavigateNext />} onClick={onNext} sx={{ minHeight: 48, fontWeight: 700 }}>Next</Button>}>
      <Typography fontWeight={700}>✓ Photo saved</Typography>
      <Typography variant="body2">
        {image.imageType}{replacedPrimary ? ' — replaced the previous primary' : ''}. Processing: {image.processingStatus}
        {image.processingStatus === 'FAILED' ? ' (the original is stored)' : ''}.
      </Typography>
    </Alert>
  );
}

export function PhotographyCapturePage() {
  const qc = useQueryClient();
  const { enqueueSnackbar } = useSnackbar();
  const inputRef = useRef<HTMLInputElement>(null);
  const cameraRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [input, setInput] = useState('');
  const [scanned, setScanned] = useState('');
  const [typeFilter, setTypeFilter] = useState<string | null>(null);
  const [preview, setPreview] = useState<TagImage | null>(null);
  const [toDelete, setToDelete] = useState<TagImage | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [cap, dispatch] = useReducer(captureReducer, initialCaptureState);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [fileProblem, setFileProblem] = useState<string | null>(null);
  // Synchronous double-click guard: state updates are async, a ref is not.
  const inFlight = useRef(false);
  // Remote capture through the station's Camera Bridge. Independent of the manual flow above: the manual buttons stay
  // usable whether or not a bridge exists, is online, or fails.
  const [remote, dispatchRemote] = useReducer(remoteReducer, initialRemoteState);
  const remoteInFlight = useRef(false);

  useEffect(() => { inputRef.current?.focus(); }, []);

  const tagQ = useQuery({ queryKey: photoKeys.tag(scanned), queryFn: () => lookupTag(scanned), enabled: !!scanned, retry: false });
  const tag = tagQ.data;
  const imagesQ = useQuery({ queryKey: photoKeys.images(tag?.id ?? ''), queryFn: () => listImages(tag!.id), enabled: !!tag?.id });
  const images = imagesQ.data ?? [];
  // The station and its camera are page-level, not per tag: read from the first render so the camera is visible before any
  // scan, and re-read to follow the bridge's report (quickly while a camera selection is pending, otherwise at heartbeat pace).
  const stationsQ = useQuery({
    queryKey: photoKeys.stations, queryFn: listStations, retry: false,
    refetchInterval: (q) => (q.state.data?.some((s) => s.cameras?.pendingCameraId) ? 1500 : 5000),
  });
  const station = resolveStation(stationsQ.data, cap.station?.id ?? null);
  const activeStations = (stationsQ.data ?? []).filter((s) => s.isActive);
  const cameraView = deriveCameraView(station);
  const selectCamera = useMutation({
    mutationFn: (cameraId: string) => requestCameraSelection(station!.id, cameraId),
    onSuccess: () => qc.invalidateQueries({ queryKey: photoKeys.stations }),
    onError: (e) => enqueueSnackbar(errorMessage(e, 'Could not change the camera'), { variant: 'error' }),
  });
  const branchMismatch = !!(tag && station && !stationFitsTag(station, tag));
  const tagReady = !!tag && !!station && !branchMismatch;

  // Object URL for the preview: revoked whenever the file changes and on unmount.
  useEffect(() => {
    if (!cap.file) { setPreviewUrl(null); return; }
    const u = URL.createObjectURL(cap.file);
    setPreviewUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [cap.file]);

  const del = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) => deleteImage(id, reason),
    onSuccess: () => {
      enqueueSnackbar('Photo deleted', { variant: 'success' });
      setToDelete(null); setPreview(null); setDeleteError(null);
      qc.invalidateQueries({ queryKey: ['photography', 'images'] });
      qc.invalidateQueries({ queryKey: ['photography', 'tag'] });
      qc.invalidateQueries({ queryKey: photoKeys.dashboard });
    },
    onError: (e) => setDeleteError(errorMessage(e, 'Failed to delete the photo')),
  });

  const refreshAfterUpload = () => {
    qc.invalidateQueries({ queryKey: ['photography', 'images'] });
    qc.invalidateQueries({ queryKey: ['photography', 'tag'] });
    qc.invalidateQueries({ queryKey: photoKeys.dashboard });
  };

  // Poll the command until it reaches a terminal state; the server (not a timeout here) says what happened.
  const remoteCommandId = remote.commandId;
  const remoteActive = remoteIsActive(remote);
  useEffect(() => {
    if (!remoteCommandId || !remoteActive) return;
    let stopped = false;
    const tick = async () => {
      try {
        const c = await getCaptureCommand(remoteCommandId);
        if (stopped) return;
        dispatchRemote({ type: 'COMMAND', command: c });
        if (c.status === 'UPLOADED') refreshAfterUpload();
      } catch { /* transient: the next tick retries; the server expires the command on its own deadline */ }
    };
    const t = setInterval(tick, 700);
    void tick();
    return () => { stopped = true; clearInterval(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [remoteCommandId, remoteActive]);

  const captureWithCamera = async () => {
    if (!tag || !station || !tagReady || remoteInFlight.current || remoteIsActive(remote)) return;
    remoteInFlight.current = true;
    dispatchRemote({ type: 'REQUESTING' });
    try {
      // Each capture mints its own bridge-sourced ticket, used once right here and never kept or stored: there is nothing
      // to expire between photos, so the operator never has to restart anything.
      const session = await startBridgeSession(tag.id, station.id);
      const command = await createCaptureCommand(session.ticket, cap.photoType);
      dispatchRemote({ type: 'COMMAND', command });
    } catch (e) {
      dispatchRemote({ type: 'REQUEST_FAILED', message: remoteRequestError(e) });
    } finally {
      remoteInFlight.current = false;
    }
  };

  // Back to a clean slate for the next tag. The station (and so its camera) is deliberately kept.
  const clearTag = () => { dispatch({ type: 'NEXT_TAG' }); dispatchRemote({ type: 'RESET' }); setFileProblem(null); setTypeFilter(null); };
  // A scanner types the tag number and sends Enter; so does a person.
  const submit = () => {
    const v = input.trim();
    if (!v) return;
    // A different tag must never inherit the previous tag's ticket or pending image.
    clearTag();
    setScanned(v);
    setInput('');
  };
  const next = () => {
    clearTag();
    setScanned(''); setInput('');
    inputRef.current?.focus();
  };

  const saved = remote.stage === 'DONE' && remote.image ? { image: remote.image, replacedPrimary: false }
    : cap.result ? { image: cap.result.image, replacedPrimary: !!cap.result.replacedPrimaryImageId } : null;

  // Enter on an empty scan field is the keyboard path through the loop: capture, then (once saved) next.
  const quickAction = () => {
    if (saved) next();
    else if (tagReady && cameraView.canCapture && !cap.file) void captureWithCamera();
  };

  const onFilePicked = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = ''; // allow re-picking the same file
    if (!f) return;
    const problem = validateImageFile(f);
    setFileProblem(problem);
    if (!problem) dispatch({ type: 'FILE_CHOSEN', file: f, idempotencyKey: newIdempotencyKey() });
  };

  const upload = async () => {
    const { file, idempotencyKey, photoType } = cap;
    if (inFlight.current || !tag || !station || !file || !idempotencyKey) return;
    inFlight.current = true;
    dispatch({ type: 'UPLOAD_STARTED' });
    try {
      // The ticket is kept in memory only; a missing or about-to-expire one is replaced here through the same endpoint, silently.
      let session = cap.session;
      for (let attempt = 0; attempt < 2; attempt++) {
        let ensured;
        try {
          ensured = await ensureCaptureSession(session, () => startCaptureSession(tag.id, station.id));
        } catch (e) {
          dispatch({ type: 'SESSION_FAILED', message: sessionErrorMessage(e) });
          return;
        }
        session = ensured.session;
        if (ensured.renewed) dispatch({ type: 'SESSION_STARTED', session });
        try {
          const result = await uploadImage(
            buildUploadForm({ ticket: session.ticket, imageType: photoType, idempotencyKey, file }),
            (fraction) => dispatch({ type: 'UPLOAD_PROGRESS', fraction }),
          );
          dispatch({ type: 'UPLOAD_SUCCEEDED', result });
          refreshAfterUpload();
          return;
        } catch (e) {
          const err = uploadError(e);
          // The server rejected a ticket the browser thought was fine (clock skew): renew once and resend the same upload
          // under the same idempotency key.
          if (err.kind === 'SESSION_EXPIRED' && attempt === 0) { session = null; continue; }
          dispatch({ type: 'UPLOAD_FAILED', error: err });
          return;
        }
      }
    } finally {
      inFlight.current = false;
    }
  };

  const notFound = tagQ.isError && (tagQ.error as any)?.response?.status === 404;
  const step = deriveStep({ tagLoading: tagQ.isLoading, hasTag: !!tag, tagError: tagQ.isError, state: cap });
  const readiness = !tag ? STEP_LABEL.IDLE : !station ? STEP_LABEL.TAG_READY : branchMismatch ? 'Station is in another branch' : STEP_LABEL[step];
  const busy = remoteIsActive(remote) || cap.uploading;

  return (
    <Box>
      <PageHeader title="Photography Capture" subtitle="Scan a tag, capture, next" />
      <Card sx={{ mb: 2 }}>
        <CardContent>
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5}>
            <TextField
              inputRef={inputRef} fullWidth autoFocus placeholder="Scan barcode or type tag number, then Enter"
              value={input} onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); if (input.trim()) submit(); else quickAction(); } }}
              inputProps={{ 'aria-label': 'Tag number', autoComplete: 'off', style: { fontSize: 20 } }}
              InputProps={{
                startAdornment: <InputAdornment position="start"><QrCodeScanner /></InputAdornment>,
                endAdornment: tagQ.isFetching ? <InputAdornment position="end"><CircularProgress size={18} /></InputAdornment> : undefined,
              }}
            />
            <Button variant="contained" size="large" onClick={submit} disabled={!input.trim()} sx={{ minWidth: 120 }}>Find tag</Button>
            <Button variant={saved ? 'contained' : 'outlined'} color={saved ? 'success' : 'primary'} size="large" onClick={next}
              disabled={!scanned && !input} endIcon={<NavigateNext />} sx={{ minWidth: 120 }}>Next</Button>
          </Stack>
          <Typography variant="caption" color="text.secondary" sx={{ mt: 1, display: 'block' }} role="status">Capture: {readiness}</Typography>
        </CardContent>
      </Card>

      {stationsQ.isError && <Alert severity="error" role="alert" sx={{ mb: 2 }}>{errorMessage(stationsQ.error, 'Failed to load stations')}</Alert>}
      {stationsQ.data && activeStations.length === 0 && (
        <Alert severity="warning" sx={{ mb: 2 }}>No capture station is set up. Ask an administrator to add one.</Alert>
      )}
      {activeStations.length > 1 && (
        // Several stations: pick once; the choice is kept for every following tag. A native <select> so arrow keys work while closed.
        <TextField select fullWidth size="small" label="Station" value={station?.id ?? ''} disabled={busy}
          onChange={(e) => { const st = activeStations.find((x) => x.id === e.target.value); if (st) dispatch({ type: 'SELECT_STATION', station: st }); }}
          SelectProps={{ native: true }} InputLabelProps={{ shrink: true }} sx={{ mb: 2 }}>
          <option value="" disabled>Select a station…</option>
          {activeStations.map((s) => <option key={s.id} value={s.id}>{s.name} — {s.branchName}</option>)}
        </TextField>
      )}
      {station && (
        <Box sx={{ mb: 2 }}>
          <StationCameraPanel view={cameraView} capturing={busy} selecting={selectCamera.isPending} tagReady={tagReady}
            onSelect={(id) => selectCamera.mutate(id)} onCapture={captureWithCamera} />
        </Box>
      )}

      {notFound && <Alert severity="warning" role="alert" sx={{ mb: 2 }}>No tag “{scanned}” was found (or it is not in a branch you can access).</Alert>}
      {tagQ.isError && !notFound && <Alert severity="error" role="alert" sx={{ mb: 2 }}>{errorMessage(tagQ.error, 'Failed to look up the tag')}</Alert>}
      {tagQ.isLoading && <Skeleton variant="rounded" height={110} sx={{ mb: 2 }} />}

      {tag && (
        <>
          <TagHeader tag={tag} />
          {branchMismatch && (
            <Alert severity="warning" role="alert" sx={{ mb: 2 }}>
              Station “{station!.name}” is in {station!.branchName}, but this tag belongs to {tag.branch?.name}. {activeStations.length > 1 ? 'Choose a station in the tag’s branch.' : 'Ask an administrator to set up a station there.'}
            </Alert>
          )}

          <Card sx={{ mb: 2 }}>
            <CardContent>
              <Stack spacing={2}>
                <Box>
                  <Typography variant="caption" color="text.secondary">Photo type</Typography>
                  <Box><PhotoTypeSelector value={cap.photoType} disabled={busy} onChange={(t) => dispatch({ type: 'SET_PHOTO_TYPE', photoType: t })} /></Box>
                </Box>

                {remoteIsActive(remote) && (
                  <Box role="status">
                    <Typography variant="body2" gutterBottom>{REMOTE_STAGE_LABEL[remote.stage]}</Typography>
                    <LinearProgress />
                  </Box>
                )}
                {remote.stage === 'FAILED' && remote.message && (
                  <Alert severity="error" role="alert"
                    action={cameraView.canCapture ? <Button color="inherit" size="small" onClick={captureWithCamera}>Retry</Button> : undefined}>
                    {remote.message}
                  </Alert>
                )}
                {saved && <PhotoSavedBanner image={saved.image} replacedPrimary={saved.replacedPrimary} onNext={next} />}

                {/* Manual fallback: always available for a loaded tag, whether or not a station camera is. capture="environment" opens the
                    camera on phones/tablets; desktops fall back to a file dialog. */}
                {!cap.file && (
                  <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
                    <Button variant="outlined" size="large" startIcon={<PhotoCamera />} disabled={!tagReady || busy} onClick={() => cameraRef.current?.click()}>Take photo</Button>
                    <Button variant="outlined" size="large" startIcon={<UploadFile />} disabled={!tagReady || busy} onClick={() => fileRef.current?.click()}>Choose file</Button>
                  </Stack>
                )}
                <input ref={cameraRef} hidden type="file" accept="image/*" capture="environment" onChange={onFilePicked} aria-label="Take photo" />
                <input ref={fileRef} hidden type="file" accept="image/*" onChange={onFilePicked} aria-label="Choose image file" />
                {fileProblem && <Alert severity="warning" role="alert">{fileProblem}</Alert>}

                {cap.file && (
                  <SelectedPhotoPreview file={cap.file} url={previewUrl} photoType={cap.photoType} progress={cap.progress}
                    uploading={cap.uploading} onUpload={upload} onRetake={() => dispatch({ type: 'FILE_CLEARED' })} />
                )}

                {cap.error && (
                  <Alert severity="error" role="alert">{cap.error.message}</Alert>
                )}
              </Stack>
            </CardContent>
          </Card>

          <Typography variant="subtitle1" fontWeight={700} gutterBottom>Existing photos</Typography>
          <Stack direction="row" spacing={1} sx={{ mb: 1.5 }} flexWrap="wrap" useFlexGap>
            <Chip label="All" clickable color={typeFilter === null ? 'primary' : 'default'} onClick={() => setTypeFilter(null)} />
            {IMAGE_TYPES.map((t) => (
              <Chip key={t} label={t} clickable color={typeFilter === t ? 'primary' : 'default'} onClick={() => setTypeFilter(t)} />
            ))}
          </Stack>
          {imagesQ.isLoading ? (
            <Grid container spacing={1.5}>{[0, 1, 2, 3].map((i) => <Grid item xs={6} sm={4} md={3} key={i}><Skeleton variant="rounded" height={190} /></Grid>)}</Grid>
          ) : imagesQ.isError ? (
            <Alert severity="error" role="alert">{errorMessage(imagesQ.error, 'Failed to load photos')}</Alert>
          ) : (
            <ImageGallery images={images} onOpen={setPreview} typeFilter={typeFilter} />
          )}
        </>
      )}

      <PreviewDialog img={preview} onClose={() => setPreview(null)} onDelete={(i) => { setDeleteError(null); setToDelete(i); }} />
      <DeleteDialog img={toDelete} busy={del.isPending} error={deleteError}
        onClose={() => setToDelete(null)} onConfirm={(reason) => toDelete && del.mutate({ id: toDelete.id, reason })} />
    </Box>
  );
}
