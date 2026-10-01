import { Dialog, DialogTitle, DialogContent, DialogActions, Button, Box, Typography, Stack, IconButton } from '@mui/material';
import { Print, Close } from '@mui/icons-material';
import { buildCreditNoteHtml, printCreditNote } from '../../utils/printCreditNote';

interface Props {
  open: boolean;
  creditNote: any;
  onClose: () => void;
}

export function CreditNotePreviewDialog({ open, creditNote, onClose }: Props) {
  if (!creditNote) return null;

  const html = buildCreditNoteHtml(creditNote);

  return (
    <Dialog open={open} onClose={onClose} maxWidth="md" fullWidth PaperProps={{ sx: { height: '85vh', maxHeight: 850 } }}>
      <DialogTitle sx={{ m: 0, p: 2, display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid #E0E0E0' }}>
        <Stack direction="row" spacing={1.5} alignItems="center">
          <Typography variant="h6" fontWeight={700}>
            Credit Note Document Preview
          </Typography>
          <Typography variant="subtitle2" sx={{ fontFamily: 'monospace', color: '#44C47A', fontWeight: 700 }}>
            {creditNote.creditNoteNumber}
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
            title={`Preview — ${creditNote.creditNoteNumber}`}
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
          onClick={() => printCreditNote(creditNote)}
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
