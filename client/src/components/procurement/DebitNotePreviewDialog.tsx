import { Dialog, DialogTitle, DialogContent, DialogActions, Button, Box, Typography, Stack, IconButton } from '@mui/material';
import { Print, Close } from '@mui/icons-material';
import { buildDebitNoteHtml, printDebitNote } from '../../utils/printDebitNote';

interface Props {
  open: boolean;
  debitNote: any;
  onClose: () => void;
}

export function DebitNotePreviewDialog({ open, debitNote, onClose }: Props) {
  if (!debitNote) return null;

  const html = buildDebitNoteHtml(debitNote);

  return (
    <Dialog open={open} onClose={onClose} maxWidth="md" fullWidth PaperProps={{ sx: { height: '85vh', maxHeight: 850 } }}>
      <DialogTitle sx={{ m: 0, p: 2, display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid #E0E0E0' }}>
        <Stack direction="row" spacing={1.5} alignItems="center">
          <Typography variant="h6" fontWeight={700}>
            Debit Note Document Preview
          </Typography>
          <Typography variant="subtitle2" sx={{ fontFamily: 'monospace', color: '#44C47A', fontWeight: 700 }}>
            {debitNote.debitNoteNumber}
          </Typography>
        </Stack>
        <IconButton onClick={onClose} size="small">
          <Close />
        </IconButton>
      </DialogTitle>

      <DialogContent sx={{ p: 0, overflow: 'hidden', bgcolor: '#525659' }}>
        <Box sx={{ width: '100%', height: '100%', display: 'flex', justifyContent: 'center', p: 2, overflow: 'auto' }}>
          <Box
            component="iframe"
            srcDoc={html}
            title={`Preview — ${debitNote.debitNoteNumber}`}
            sx={{
              width: '210mm',
              minHeight: '297mm',
              border: 'none',
              boxShadow: '0 4px 20px rgba(0,0,0,0.3)',
              bgcolor: '#fff',
            }}
          />
        </Box>
      </DialogContent>

      <DialogActions sx={{ p: 2, borderTop: '1px solid #E0E0E0', justifyContent: 'space-between' }}>
        <Button onClick={onClose} variant="outlined" color="inherit">
          Close
        </Button>
        <Button
          onClick={() => printDebitNote(debitNote)}
          variant="contained"
          startIcon={<Print />}
          sx={{ bgcolor: '#44C47A', '&:hover': { bgcolor: '#38A866' } }}
        >
          Print / Save PDF
        </Button>
      </DialogActions>
    </Dialog>
  );
}
