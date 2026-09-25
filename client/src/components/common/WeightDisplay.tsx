import { Typography, TypographyProps } from '@mui/material';

interface Props extends Omit<TypographyProps, 'children'> {
  value: number | null | undefined;
  unit?: 'g' | 'ct' | 'kg';
  decimals?: number;
  label?: string;
}

export function WeightDisplay({ value, unit = 'g', decimals = 3, label, ...props }: Props) {
  const formatted = value != null ? value.toFixed(decimals) : '—';
  return (
    <Typography fontFamily="'Roboto Mono', monospace" {...props}>
      {label && <span style={{ opacity: 0.6, fontSize: '0.85em' }}>{label}: </span>}
      {formatted}
      {value != null && (
        <span style={{ opacity: 0.6, fontSize: '0.8em', marginLeft: 2 }}>{unit}</span>
      )}
    </Typography>
  );
}

export function weightFmt(value: number | null | undefined, unit = 'g', decimals = 3): string {
  if (value == null) return '—';
  return `${value.toFixed(decimals)} ${unit}`;
}
