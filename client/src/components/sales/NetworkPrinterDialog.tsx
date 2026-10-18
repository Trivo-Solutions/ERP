import { useEffect, useState } from 'react';
import { Alert, Button, Dialog, DialogActions, DialogContent, DialogTitle, Stack, TextField, Typography } from '@mui/material';
import { useSnackbar } from 'notistack';
import { getNetworkPrinterHost, isValidPrinterHost, printNetworkTest, setNetworkPrinterHost } from '../../utils/networkReceiptPrinter';

// Tells THIS device where the Epson receipt printer is on the network (stored in the browser, per device).
export function NetworkPrinterDialog({ open, onClose, onSaved }: { open: boolean; onClose: () => void; onSaved: (host: string | null) => void }) {
  const { enqueueSnackbar } = useSnackbar();
  const [host, setHost] = useState('');
  const [testing, setTesting] = useState(false);
  useEffect(() => { if (open) setHost(getNetworkPrinterHost() ?? ''); }, [open]);

  const valid = isValidPrinterHost(host);
  const test = async () => {
    setTesting(true);
    try { await printNetworkTest(host.trim()); enqueueSnackbar('Test slip sent - check it came out and was cut.', { variant: 'success' }); }
    catch (e: any) { enqueueSnackbar(e?.message ?? 'Test failed', { variant: 'error' }); }
    finally { setTesting(false); }
  };
  const save = () => { setNetworkPrinterHost(host); onSaved(host.trim() || null); onClose(); };
  const clear = () => { setNetworkPrinterHost(null); onSaved(null); onClose(); };

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="xs">
      <DialogTitle>Network receipt printer (Epson TM-m30III)</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          <TextField label="Printer IP address" placeholder="192.168.1.50" value={host} autoFocus size="small"
            onChange={(e) => setHost(e.target.value)} error={host.trim() !== '' && !valid}
            helperText={host.trim() !== '' && !valid ? 'Enter an IP address like 192.168.1.50' : 'Saved on this device only'} />
          <Alert severity="info" sx={{ '& ul': { m: 0, pl: 2.5 } }}>
            <Typography variant="body2" component="div">One-time setup:
              <ul>
                <li>Give the printer a fixed IP (router reservation) and note it from its self-test slip.</li>
                <li>In Epson Web Config, enable HTTPS and ePOS-Print.</li>
                <li>On this device, open <b>https://{valid ? host.trim() : '&lt;printer-ip&gt;'}</b> once and accept the certificate warning.</li>
              </ul>
            </Typography>
          </Alert>
        </Stack>
      </DialogContent>
      <DialogActions>
        {getNetworkPrinterHost() && <Button color="error" onClick={clear}>Remove</Button>}
        <Button onClick={test} disabled={!valid || testing}>{testing ? 'Sending…' : 'Print test'}</Button>
        <Button variant="contained" onClick={save} disabled={!valid}>Save</Button>
      </DialogActions>
    </Dialog>
  );
}
