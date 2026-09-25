import { forwardRef } from 'react';
import { InputAdornment, TextFieldProps } from '@mui/material';
import { NumberField } from './NumberField';

export interface CurrencyFieldProps extends Omit<TextFieldProps, 'type'> {
  currencySymbol?: string;
}

export const CurrencyField = forwardRef<HTMLInputElement, CurrencyFieldProps>(function CurrencyField(
  { currencySymbol = '₹', InputProps, ...props }, ref
) {
  return (
    <NumberField
      ref={ref}
      InputProps={{ startAdornment: <InputAdornment position="start">{currencySymbol}</InputAdornment>, ...InputProps }}
      {...props}
    />
  );
});
