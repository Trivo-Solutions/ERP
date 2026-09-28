import { Button } from '@mui/material';
import { PrintAgentNotRunningError, PRINT_AGENT_DOWNLOAD_URL } from './printAgent';

// Passed as notistack's `action` prop on a print-error snackbar. Only renders when the error is
// specifically "agent not running" — other print errors (offline printer, bad request, ...) don't
// need a download link.
export function printAgentSnackbarAction(err: unknown) {
  if (!(err instanceof PrintAgentNotRunningError)) return undefined;
  return (
    <Button size="small" color="inherit" href={PRINT_AGENT_DOWNLOAD_URL} download>
      Download Print Agent
    </Button>
  );
}
