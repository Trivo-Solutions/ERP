import { useState } from 'react';
import {
  Box, Grid, Card, CardContent, Typography, Chip, Button, TextField, MenuItem,
  Alert, Table, TableHead, TableBody, TableRow, TableCell, Divider, Tooltip, Link,
} from '@mui/material';
import { useQuery, useMutation } from '@tanstack/react-query';
import { Scale, QrCode, Nfc, Link as LinkIcon, LinkOff, Usb, Print, ReceiptLong, Download, Settings } from '@mui/icons-material';
import { useSnackbar } from 'notistack';
import { apiGet, apiPost } from '../../api/client';
import { PageHeader } from '../../components/common/PageHeader';
import { useScaleReading } from '../../hooks/useSocket';
import { useWebSerial } from '../../hooks/useWebSerial';
import { useUiStore } from '../../store/ui.store';
import { getPrintAgentStatus, getReceiptPrinterStatus, isReceiptAgentOutdated, receiptStatusRefetchMs, printReceiptTest, PRINT_AGENT_DOWNLOAD_URL, PRINT_AGENT_INSTALLER_URL, PRINT_AGENT_SETUP_URL } from '../../utils/printAgent';

export function HardwarePage() {
  const { enqueueSnackbar } = useSnackbar();
  const { scaleDevice, setScaleDevice } = useUiStore();

  // WebSocket-pushed weight from backend RS232 (cloud-deployed fallback)
  const [wsWeight, setWsWeight] = useState<number | null>(null);
  useScaleReading(scaleDevice, (w) => setWsWeight(w));

  // Web Serial API — browser talks directly to local COM/USB port (preferred)
  const { isSupported, isConnected, lastReading, error: serialError, connect, disconnect } = useWebSerial({
    baudRate: 9600,
    deviceId: scaleDevice,
    onReading: (r) => enqueueSnackbar(`Scale: ${r.weight.toFixed(4)} g`, { variant: 'info', autoHideDuration: 1500 }),
  });

  // Displayed weight — Web Serial takes priority over WS fallback
  const liveWeight = lastReading?.weight ?? wsWeight;
  const weightSource = lastReading ? 'WEB_SERIAL' : wsWeight !== null ? 'WS_BACKEND' : null;

  const [simWeight, setSimWeight] = useState<number>(15.5);
  const [barcodeResult, setBarcodeResult] = useState<any>(null);
  const [scanInput, setScanInput] = useState('');

  const { data: devices } = useQuery({
    queryKey: ['hardware-devices'],
    queryFn: () => apiGet<any>('/hardware/devices'),
    refetchInterval: 10_000,
  });

  // Local print agent (printer-agent/) — a separate process on this same PC, not a backend
  // device, so this polls it directly rather than through /hardware/devices.
  const { data: printAgentStatus, isError: printAgentOffline } = useQuery({
    queryKey: ['print-agent-status'],
    queryFn: getPrintAgentStatus,
    refetchInterval: 10_000,
    retry: false,
  });

  // Receipt printer (ESC/POS, e.g. Epson TM-m30III) on the same agent - polled separately so the
  // label printer card above is unaffected by it.
  const { data: receiptStatus, isError: receiptQueryError, error: receiptError, refetch: refetchReceipt } = useQuery({
    queryKey: ['receipt-printer-status'],
    queryFn: getReceiptPrinterStatus,
    refetchInterval: receiptStatusRefetchMs(10_000),
    retry: false,
  });
  const receiptAgentOutdated = receiptQueryError && isReceiptAgentOutdated(receiptError);
  const receiptAgentOffline = receiptQueryError && !receiptAgentOutdated;
  const receiptTestMutation = useMutation({
    mutationFn: printReceiptTest,
    onSuccess: () => { enqueueSnackbar('Test slip sent to the receipt printer queue - check that it came out', { variant: 'success' }); refetchReceipt(); },
    onError: (e: any) => enqueueSnackbar(e?.message ?? 'Test print failed', { variant: 'error' }),
  });

  const simulateMutation = useMutation({
    mutationFn: () => apiPost(`/hardware/scales/${scaleDevice}/simulate`, { weight: simWeight }),
    onSuccess: () => enqueueSnackbar('Scale reading simulated via WS', { variant: 'success' }),
  });

  const barcodeMutation = useMutation({
    mutationFn: (barcodeData: string) => apiPost('/hardware/barcode/scan', { barcodeData }),
    onSuccess: (data: any) => setBarcodeResult(data),
    onError: () => { setBarcodeResult(null); enqueueSnackbar('Barcode not found', { variant: 'error' }); },
  });

  return (
    <Box>
      <PageHeader
        title="Hardware Integration"
      />

      <Grid container spacing={2}>
        {/* ── Scale Monitor ────────────────────────────────────────────── */}
        <Grid item xs={12} md={4}>
          <Card>
            <CardContent>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 2 }}>
                <Scale color="primary" />
                <Typography variant="subtitle1" fontWeight={700}>Weighing Scale</Typography>
                <Chip
                  label={liveWeight !== null ? 'LIVE' : 'NO SIGNAL'}
                  size="small"
                  color={liveWeight !== null ? 'success' : 'error'}
                />
                {weightSource && (
                  <Chip
                    label={weightSource === 'WEB_SERIAL' ? 'USB' : 'NETWORK'}
                    size="small"
                    color={weightSource === 'WEB_SERIAL' ? 'primary' : 'default'}
                    variant="outlined"
                  />
                )}
              </Box>

              {/* Live display */}
              <Box sx={{ textAlign: 'center', py: 3, bgcolor: '#070D2A', borderRadius: 2, mb: 2 }}>
                <Typography sx={{ fontFamily: 'monospace', fontSize: 36, fontWeight: 700, color: '#44C47A', letterSpacing: '0.1em' }}>
                  {liveWeight !== null ? liveWeight.toFixed(4) : '----.----'}
                </Typography>
                <Typography sx={{ color: '#44C47A', fontSize: 14 }}>
                  {lastReading?.unit ?? 'grams'}
                  {lastReading && !lastReading.isStable && (
                    <span style={{ color: '#FF6B35', marginLeft: 8, fontSize: 12 }}>UNSTABLE</span>
                  )}
                </Typography>
              </Box>

              {/* Web Serial connect/disconnect */}
              {isSupported ? (
                <Button
                  fullWidth
                  variant={isConnected ? 'outlined' : 'contained'}
                  color={isConnected ? 'error' : 'primary'}
                  startIcon={isConnected ? <LinkOff /> : <Usb />}
                  onClick={isConnected ? disconnect : connect}
                  sx={{ mb: 1.5 }}
                >
                  {isConnected ? 'Disconnect Scale (USB)' : 'Connect Scale via USB / COM Port'}
                </Button>
              ) : (
                <Alert severity="warning" sx={{ mb: 1.5, fontSize: 12 }}>
                  Web Serial API requires Chrome/Edge 89+ on HTTPS or localhost.
                  Backend RS232 mode is active via WebSocket.
                </Alert>
              )}

              {serialError && <Alert severity="error" sx={{ mb: 1.5, fontSize: 12 }}>{serialError}</Alert>}

              <Divider sx={{ my: 1.5 }}>
                <Typography variant="caption" color="text.secondary">or use development simulator</Typography>
              </Divider>

              <Box sx={{ display: 'flex', gap: 1 }}>
                <TextField
                  size="small" type="number" value={simWeight}
                  onChange={(e) => setSimWeight(Number(e.target.value))}
                  inputProps={{ step: 0.001 }} label="Weight (g)" sx={{ flex: 1 }}
                />
                <Button variant="outlined" onClick={() => simulateMutation.mutate()}>
                  Simulate
                </Button>
              </Box>

              <TextField
                select fullWidth size="small" label="Active Scale ID"
                value={scaleDevice} onChange={(e) => setScaleDevice(e.target.value)} sx={{ mt: 1.5 }}
              >
                {((devices as any)?.connectedScales ?? ['default-scale']).map((s: string) => (
                  <MenuItem key={s} value={s}>{s}</MenuItem>
                ))}
              </TextField>
            </CardContent>
          </Card>
        </Grid>

        {/* ── Barcode / RFID ───────────────────────────────────────────── */}
        <Grid item xs={12} md={4}>
          <Card>
            <CardContent>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 2 }}>
                <QrCode color="primary" />
                <Typography variant="subtitle1" fontWeight={700}>Barcode / RFID Scanner</Typography>
              </Box>

              <Alert severity="info" sx={{ mb: 2, fontSize: 12 }}>
                USB HID barcode scanners emulate keyboard input natively — no driver needed.
                Focus this field, then scan.
              </Alert>

              <TextField
                fullWidth
                label="Scan or type barcode / job card ID"
                value={scanInput}
                onChange={(e) => setScanInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && scanInput.trim()) {
                    barcodeMutation.mutate(scanInput.trim());
                    setScanInput('');
                  }
                }}
                helperText="Press Enter after scan"
                autoFocus
                sx={{ mb: 2 }}
              />

              {barcodeMutation.isPending && (
                <Typography variant="caption" color="text.secondary">Looking up…</Typography>
              )}

              {barcodeResult && (
                <Box sx={{ p: 1.5, bgcolor: '#F0FFF4', borderRadius: 2 }}>
                  <Typography variant="caption" color="success.main" fontWeight={700}>Job Card Found</Typography>
                  <Typography variant="body2" fontWeight={700} sx={{ fontFamily: 'monospace' }}>{barcodeResult.jobNumber}</Typography>
                  <Typography variant="caption" display="block">{barcodeResult.design?.name}</Typography>
                  <Typography variant="caption" color="text.secondary">
                    Process: {barcodeResult.currentProcess ?? '—'} | Status: {barcodeResult.status}
                  </Typography>
                  {barcodeResult.order && (
                    <Typography variant="caption" display="block" color="text.secondary">
                      Order: {barcodeResult.order?.orderNumber} — {barcodeResult.order?.client?.name}
                    </Typography>
                  )}
                </Box>
              )}
            </CardContent>
          </Card>
        </Grid>

        {/* ── Registered Devices ───────────────────────────────────────── */}
        <Grid item xs={12} md={4}>
          <Card sx={{ height: '100%' }}>
            <CardContent>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 2 }}>
                <Nfc color="primary" />
                <Typography variant="subtitle1" fontWeight={700}>Registered Devices</Typography>
              </Box>

              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>Type</TableCell>
                    <TableCell>Port / IP</TableCell>
                    <TableCell>Last Ping</TableCell>
                    <TableCell>Status</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {((devices as any)?.data ?? []).map((d: any) => {
                    const minsAgo = d.lastPing
                      ? Math.floor((Date.now() - new Date(d.lastPing).getTime()) / 60_000)
                      : null;
                    const isRecent = minsAgo !== null && minsAgo < 5;
                    return (
                      <TableRow key={d.id}>
                        <TableCell><Chip label={d.deviceType} size="small" /></TableCell>
                        <TableCell sx={{ fontFamily: 'monospace', fontSize: 11 }}>
                          {d.port ?? d.ipAddress ?? '—'}
                        </TableCell>
                        <TableCell sx={{ fontSize: 11 }}>
                          {d.lastPing ? new Date(d.lastPing).toLocaleTimeString('en-IN') : 'Never'}
                        </TableCell>
                        <TableCell>
                          <Chip
                            label={isRecent ? 'Online' : 'Offline'}
                            size="small"
                            color={isRecent ? 'success' : 'default'}
                          />
                        </TableCell>
                      </TableRow>
                    );
                  })}
                  {!((devices as any)?.data?.length) && (
                    <TableRow>
                      <TableCell colSpan={4} align="center" sx={{ py: 3, color: 'text.secondary', fontSize: 12 }}>
                        No backend devices registered.
                        <br />Connect directly via Web Serial above.
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </Grid>

        {/* ── Label Printer Agent ──────────────────────────────────────── */}
        <Grid item xs={12} md={4}>
          <Card>
            <CardContent>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 2 }}>
                <Print color="primary" />
                <Typography variant="subtitle1" fontWeight={700}>Label Printer Agent</Typography>
                <Chip
                  label={
                    printAgentStatus?.online ? 'ONLINE'
                      : printAgentStatus && !printAgentStatus.configured ? 'NEEDS SETUP'
                      : printAgentStatus ? 'OFFLINE'
                      : printAgentOffline ? 'NOT RUNNING' : 'CHECKING...'
                  }
                  size="small"
                  color={
                    printAgentStatus?.online ? 'success'
                      : printAgentStatus ? 'warning'
                      : printAgentOffline ? 'error' : 'default'
                  }
                />
              </Box>

              <Alert severity="info" sx={{ mb: 2, fontSize: 12 }}>
                A small app that runs on this counter PC and talks to its USB-attached label
                printer — separate from the ERP web app itself. One-time setup per PC.
              </Alert>

              {printAgentStatus && (
                <Typography variant="body2" sx={{ mb: 2 }}>
                  {printAgentStatus.configured ? printAgentStatus.printerName : 'Not configured'} — {printAgentStatus.statusText}
                </Typography>
              )}

              <Button
                fullWidth
                variant="contained"
                startIcon={<Download />}
                href={PRINT_AGENT_INSTALLER_URL}
                download
                sx={{ mb: 1 }}
              >
                Download Print Agent (Installer)
              </Button>

              {printAgentStatus && (
                <Button
                  fullWidth
                  variant="outlined"
                  startIcon={<Settings />}
                  href={PRINT_AGENT_SETUP_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  sx={{ mb: 1 }}
                >
                  {printAgentStatus.configured ? 'Change Printer / Autostart' : 'Open Setup'}
                </Button>
              )}

              <Typography variant="caption" color="text.secondary" component="div">
                Run <code>TRIVO Print Agent Setup.exe</code> — it installs, starts automatically at
                login, and auto-detects your printer (or opens a setup page to pick it from a
                list). Nothing to copy or edit by hand, no admin rights needed.
              </Typography>
              <Typography variant="caption" color="text.secondary" component="div" sx={{ mt: 1 }}>
                Prefer the manual route instead? <Link href={PRINT_AGENT_DOWNLOAD_URL} download>Download the .zip</Link> and
                run <code>printer-agent.exe</code> directly — same auto-detect/setup behavior, but
                no install step or autostart.
              </Typography>
            </CardContent>
          </Card>
        </Grid>

        {/* ── Receipt Printer (Epson TM-m30III, estimates) ─────────────── */}
        <Grid item xs={12} md={4}>
          <Card>
            <CardContent>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 2 }}>
                <ReceiptLong color="primary" />
                <Typography variant="subtitle1" fontWeight={700}>Receipt Printer</Typography>
                <Chip
                  label={
                    receiptStatus?.online ? 'ONLINE'
                      : receiptStatus && !receiptStatus.configured ? 'NEEDS SETUP'
                      : receiptStatus ? 'OFFLINE'
                      : receiptAgentOutdated ? 'AGENT NEEDS UPDATE'
                      : receiptAgentOffline ? 'AGENT NOT RUNNING' : 'CHECKING...'
                  }
                  size="small"
                  color={
                    receiptStatus?.online ? 'success'
                      : receiptStatus ? 'warning'
                      : receiptAgentOutdated ? 'warning'
                      : receiptAgentOffline ? 'error' : 'default'
                  }
                />
              </Box>

              <Alert severity="info" sx={{ mb: 2, fontSize: 12 }}>
                The 80 mm Epson used for estimates. It runs on the same print agent as the label
                printer (one installer for both), but is a separate printer - changing one never
                changes the other.
              </Alert>

              {receiptStatus && (
                <Typography variant="body2" sx={{ mb: 2 }}>
                  {receiptStatus.configured ? receiptStatus.printerName : 'Not configured'} — {receiptStatus.statusText}
                </Typography>
              )}
              {receiptAgentOutdated && (
                <Typography variant="body2" color="warning.main" sx={{ mb: 2 }}>
                  The print agent on this PC is an older version without receipt-printer support.
                  Download and run the installer below, then reload this page. The label printer keeps working meanwhile.
                </Typography>
              )}
              {receiptAgentOffline && (
                <Typography variant="body2" color="error" sx={{ mb: 2 }}>
                  The print agent is not running on this PC. Start it (see the Label Printer Agent card), then reload.
                </Typography>
              )}

              <Button
                fullWidth
                variant="contained"
                startIcon={<Download />}
                href={PRINT_AGENT_INSTALLER_URL}
                download
                sx={{ mb: 1 }}
              >
                Download Print Agent (Installer)
              </Button>

              {receiptStatus && (
                <Button
                  fullWidth
                  variant="outlined"
                  startIcon={<Settings />}
                  href={PRINT_AGENT_SETUP_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  sx={{ mb: 1 }}
                >
                  {receiptStatus.configured ? 'Change Receipt Printer' : 'Choose Receipt Printer'}
                </Button>
              )}
              <Button
                fullWidth
                variant="contained"
                startIcon={<Print />}
                disabled={!receiptStatus?.configured || receiptStatus.online === false || receiptTestMutation.isPending}
                onClick={() => receiptTestMutation.mutate()}
              >
                {receiptTestMutation.isPending ? 'Sending…' : 'Print Test Slip'}
              </Button>

              <Typography variant="caption" color="text.secondary" component="div" sx={{ mt: 1 }}>
                Pick the printer under "Receipt printer" on the setup page. Estimates then get a
                "Print to Receipt Printer" button on the Estimation screen.
              </Typography>
            </CardContent>
          </Card>
        </Grid>
      </Grid>
    </Box>
  );
}
