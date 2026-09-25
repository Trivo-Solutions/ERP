// Shared "Excel-exportable" mechanism for Phase H's report pages — a plain CSV, which Excel opens
// natively, rather than pulling in an xlsx/exceljs dependency for one column of formatting no one
// asked for. Each column's value is read via its own accessor so callers can format numbers/dates
// however the on-screen table already does, without re-deriving that logic here.
export interface CsvColumn<T> {
  header: string;
  value: (row: T) => string | number;
}

function escapeCsvCell(value: string | number): string {
  const s = String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function exportToCsv<T>(filename: string, columns: CsvColumn<T>[], rows: T[]) {
  const lines = [
    columns.map((c) => escapeCsvCell(c.header)).join(','),
    ...rows.map((row) => columns.map((c) => escapeCsvCell(c.value(row))).join(',')),
  ];
  const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename.endsWith('.csv') ? filename : `${filename}.csv`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
