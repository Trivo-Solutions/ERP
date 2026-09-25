import { forwardRef } from 'react';
import { TextField, TextFieldProps } from '@mui/material';

// Shared numeric input: disables the native spinner arrows and the scroll-changes-value browser
// behavior (same guard EditableCell in MastersPage.tsx already applies) — a hover-scroll on a
// focused number field silently bumping a price/weight is surprising inside a dense table or form.

export const NumberField = forwardRef<HTMLInputElement, Omit<TextFieldProps, 'type'>>(function NumberField(
  { sx, onWheel, fullWidth = true, ...props }, ref
) {
  return (
    <TextField
      type="number"
      inputRef={ref}
      fullWidth={fullWidth}
      sx={{
        '& input[type=number]': { MozAppearance: 'textfield' },
        '& input[type=number]::-webkit-outer-spin-button, & input[type=number]::-webkit-inner-spin-button': {
          WebkitAppearance: 'none', margin: 0,
        },
        ...sx,
      }}
      onWheel={onWheel ?? ((e) => (e.target as HTMLInputElement).blur())}
      {...props}
    />
  );
});
