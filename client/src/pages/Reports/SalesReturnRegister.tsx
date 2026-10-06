import { useMemo, useState } from 'react';
import { Box, Card, Typography, Chip, TextField } from '@mui/material';
import { useQuery } from '@tanstack/react-query';
import { apiGet } from '../../api/client';
import { PageHeader } from '../../components/common/PageHeader';
import { DataTable, DataTableColumn } from '../../components/common/DataTable';
import { DateField } from '../../components/fields/DateField';
import { REPAIR_STATUS_LABEL } from '../Tagging/RepairRegister';

// Sales Return Register — the FINANCIAL record: which sales were returned and what the customer was credited. What
// happened to each piece afterwards (transfer to Head Office, inspection, repair, back to stock) is the Repair
// Register's job; the Inspection column here is only a pointer to it.

const inr = (n: number) => `₹${n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const day = (v: string) => new Date(v).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
const INSPECTION_LABEL: Record<string, string> = { NOT_APPLICABLE: 'n/a (material)', PENDING: 'Pending', PASSED: 'Passed', COMPLETED: 'Completed' };
const INSPECTION_COLOR: Record<string, 'default' | 'success' | 'warning'> = { NOT_APPLICABLE: 'default', PENDING: 'warning', PASSED: 'success', COMPLETED: 'success' };

export function SalesReturnRegister() {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [q, setQ] = useState('');
  const { data = [], isLoading } = useQuery({ queryKey: ['sales-return-register'], queryFn: () => apiGet<any[]>('/sales/returns') });

  const rows = useMemo(() => {
    const lo = from ? new Date(from).getTime() : 0;
    const hi = to ? new Date(to).getTime() + 86_400_000 : Infinity;
    const needle = q.trim().toLowerCase();
    return data
      .filter((r) => { const t = new Date(r.returnDate).getTime(); return t >= lo && t < hi; })
      .flatMap((r) => r.items.map((i: any) => ({
        id: i.id, returnNumber: r.returnNumber, invoiceNumber: r.invoiceNumber, customer: r.customerName,
        jewelCode: i.tag?.tagNumber ?? 'Material', description: i.tag?.name ?? 'Loose metal', branch: i.tag?.branch?.name ?? r.branchName ?? '—',
        returnDate: r.returnDate, amount: Number(i.amount), credit: Number(i.amount), status: 'Posted',
        inspection: i.repairCase ? REPAIR_STATUS_LABEL[i.repairCase.status] ?? i.repairCase.status : INSPECTION_LABEL[r.inspectionStatus],
        inspectionKey: i.repairCase ? (i.repairCase.status === 'INSPECTION_PASSED' ? 'PASSED' : 'PENDING') : 'NOT_APPLICABLE',
        repairNumber: i.repairCase?.repairNumber ?? '',
      })))
      .filter((r: any) => !needle || [r.returnNumber, r.invoiceNumber, r.customer, r.jewelCode, r.description].some((v) => String(v ?? '').toLowerCase().includes(needle)));
  }, [data, from, to, q]);

  const columns: DataTableColumn[] = [
    { key: 'returnNumber', label: 'Return No.', width: 150, render: (r) => <Box component="span" sx={{ fontFamily: 'monospace', fontWeight: 700 }}>{r.returnNumber}</Box> },
    { key: 'invoiceNumber', label: 'Original Invoice', width: 150 },
    { key: 'customer', label: 'Customer', width: 170 },
    { key: 'jewelCode', label: 'Jewel Code', width: 130, render: (r) => <Box component="span" sx={{ fontFamily: 'monospace', fontWeight: 700, color: 'secondary.main' }}>{r.jewelCode}</Box> },
    { key: 'description', label: 'Description', width: 170 },
    { key: 'branch', label: 'Branch', width: 140 },
    { key: 'returnDate', label: 'Return Date', width: 120, sortValue: (r) => new Date(r.returnDate).getTime(), filterValue: (r) => day(r.returnDate), render: (r) => day(r.returnDate), csvValue: (r) => day(r.returnDate) },
    { key: 'amount', label: 'Return Amount', width: 140, align: 'right', sortValue: (r) => r.amount, render: (r) => inr(r.amount), csvValue: (r) => r.amount },
    { key: 'credit', label: 'Customer Credit / Refund', width: 170, align: 'right', sortValue: (r) => r.credit, render: (r) => inr(r.credit), csvValue: (r) => r.credit },
    { key: 'status', label: 'Return Status', width: 120 },
    {
      key: 'inspection', label: 'Inspection Status', width: 230, filterValue: (r) => r.inspection,
      render: (r) => <Chip size="small" variant="outlined" color={INSPECTION_COLOR[r.inspectionKey]} label={r.inspection} />, csvValue: (r) => r.inspection,
    },
    { key: 'repairNumber', label: 'Repair No.', width: 150, defaultHidden: true, render: (r) => r.repairNumber || '—' },
  ];

  return (
    <Box>
      <PageHeader title="Sales Return Register" subtitle="Which sales were returned, and what the customer was credited" />
      <Card sx={{ p: 1.5, mb: 1.5 }}>
        <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr 1fr', md: 'repeat(4, 1fr)' }, gap: 1.5, alignItems: 'center' }}>
          <DateField size="small" label="From" value={from} onChange={(e) => setFrom(e.target.value)} />
          <DateField size="small" label="To" value={to} onChange={(e) => setTo(e.target.value)} />
          <TextField size="small" label="Search" placeholder="Return, invoice, customer, jewel code" value={q} onChange={(e) => setQ(e.target.value)} InputLabelProps={{ shrink: true }} sx={{ gridColumn: { md: 'span 2' } }} />
        </Box>
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
          Transfers, inspection and repair of the returned piece are tracked in the Repair Register — not here.
        </Typography>
      </Card>
      <DataTable
        tableId="sales-return-register" columns={columns} rows={rows} isLoading={isLoading} getRowId={(r) => r.id}
        emptyLabel="No sales returns match these filters" sortable pageSizeOptions={[100, 200, 500]} maxHeight="calc(100vh - 330px)" csvFileName="sales-return-register"
      />
    </Box>
  );
}
