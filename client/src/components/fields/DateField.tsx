import { forwardRef } from 'react';
import { TextField, TextFieldProps } from '@mui/material';

// Wraps the app's existing native <input type="date"> convention (deliberately not MUI's
// DatePicker/LocalizationProvider — the app already standardizes on native date inputs
// everywhere; see UI_DESIGN_GUIDE.md). Just packages the InputLabelProps={{shrink:true}} every
// call site needs so the label doesn't overlap the native date placeholder.

export const DateField = forwardRef<HTMLInputElement, Omit<TextFieldProps, 'type'>>(function DateField(
  { InputLabelProps, fullWidth = true, ...props }, ref
) {
  return (
    <TextField
      type="date"
      inputRef={ref}
      fullWidth={fullWidth}
      InputLabelProps={{ shrink: true, ...InputLabelProps }}
      {...props}
    />
  );
});
