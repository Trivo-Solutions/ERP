import { forwardRef } from 'react';
import { TextField, TextFieldProps } from '@mui/material';

// Wraps the UI_DESIGN_GUIDE.md §1 keyboard-first native-select pattern (SelectProps={{native:
// true}} + InputLabelProps={{shrink:true}}) so every dropdown gets arrow-key/type-ahead-without-
// opening behavior by construction, instead of relying on every call site to hand-copy it.

export interface SelectFieldOption { value: string | number; label: string }
export interface SelectFieldOptGroup { label: string; options: SelectFieldOption[] }

export interface SelectFieldProps extends Omit<TextFieldProps, 'select'> {
  options?: SelectFieldOption[];
  optgroups?: SelectFieldOptGroup[];
  // Label for a leading blank/"none" option. Omit entirely to not render one (e.g. a required
  // field whose first real option should already be a sensible default).
  emptyLabel?: string;
}

export const SelectField = forwardRef<HTMLInputElement, SelectFieldProps>(function SelectField({
  options, optgroups, emptyLabel, children, SelectProps, InputLabelProps, fullWidth = true, ...props
}, ref) {
  return (
    <TextField
      select
      inputRef={ref}
      fullWidth={fullWidth}
      SelectProps={{ native: true, ...SelectProps }}
      InputLabelProps={{ shrink: true, ...InputLabelProps }}
      {...props}
    >
      {emptyLabel !== undefined && <option value="">{emptyLabel}</option>}
      {options?.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      {optgroups?.map((g) => (
        <optgroup key={g.label} label={g.label}>
          {g.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </optgroup>
      ))}
      {children}
    </TextField>
  );
});
