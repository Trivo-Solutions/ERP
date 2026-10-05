import { Button, Dialog, DialogActions, DialogContent, DialogTitle, Typography } from '@mui/material';

// Shown before an estimate is added to a bill whose customer is someone else.
export function CustomerMismatchDialog({ open, onCancel, onConfirm }: { open: boolean; onCancel: () => void; onConfirm: () => void }) {
  return (
    <Dialog open={open} onClose={onCancel} maxWidth="xs" fullWidth>
      <DialogTitle fontWeight={700}>Customer Mismatch</DialogTitle>
      <DialogContent>
        <Typography variant="body2">
          This estimate belongs to a different customer than the customer currently selected on this bill. Do you want to add this estimate anyway?
        </Typography>
      </DialogContent>
      <DialogActions sx={{ p: 2 }}>
        <Button onClick={onCancel}>Cancel</Button>
        <Button variant="contained" color="warning" onClick={onConfirm}>Add Anyway</Button>
      </DialogActions>
    </Dialog>
  );
}
