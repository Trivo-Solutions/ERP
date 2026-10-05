import { useMemo, useRef, useState } from 'react';
import {
  Box, Card, TableRow, TableCell, Typography, Chip, TextField, ToggleButton, ToggleButtonGroup, Alert, IconButton, Tooltip,
  Table, TableHead, TableBody, Button,
} from '@mui/material';
import { FileDownload } from '@mui/icons-material';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { apiGet } from '../../api/client';
import { PageHeader } from '../../components/common/PageHeader';
import { DataTable, DataTableColumn } from '../../components/common/DataTable';
import { SelectField } from '../../components/fields/SelectField';
import { DateField } from '../../components/fields/DateField';
import { exportToCsv } from '../../utils/exportToCsv';

// Sales Report. Summary = one row per invoice (a bill shared by two employees is still ONE row). Detailed = one row per
// invoice line, credited to the employee who made that sale — the view for employee-wise analysis and, later, commission.
// Both are the shared DataTable: right-click a header to show/hide columns, drag to reorder, per-column filters.

const money = (n: number) => '₹' + Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const mono = (v: React.ReactNode) => <Box component="span" sx={{ fontFamily: 'monospace' }}>{v}</Box>;
const dateOf = (d: string) => new Date(d).toLocaleDateString('en-IN');
const dateTimeOf = (r: { invoiceDate: string; createdAt: string }) =>
  `${dateOf(r.invoiceDate)} ${new Date(r.createdAt).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}`;

const PAYMENT_OPTIONS = [{ value: 'PAID', label: 'Paid' }, { value: 'PARTIAL', label: 'Partly paid' }, { value: 'UNPAID', label: 'Unpaid' }];
const STATUS_OPTIONS = ['DRAFT', 'ISSUED', 'PARTIALLY_PAID', 'PAID', 'OVERDUE'].map((s) => ({ value: s, label: s.replace('_', ' ') }));

type Row = Record<string, any>;

const moneyCol = (key: string, label: string, hidden = false): DataTableColumn => ({
  key, label, align: 'right', width: 130, defaultHidden: hidden, filterable: false,
  sortValue: (r) => Number(r[key] || 0), csvValue: (r) => Number(r[key] || 0), render: (r) => mono(money(r[key])),
});
const numCol = (key: string, label: string): DataTableColumn => ({
  key, label, align: 'right', width: 80, filterable: false,
  sortValue: (r) => Number(r[key] || 0), csvValue: (r) => Number(r[key] || 0), render: (r) => mono(Number(r[key] || 0).toFixed(2)),
});
const textCol = (key: string, label: string, width = 130, hidden = false): DataTableColumn => ({ key, label, width, defaultHidden: hidden });

const SUMMARY_COLUMNS: DataTableColumn[] = [
  {
    key: 'invoiceNumber', label: 'Invoice No', width: 130,
    render: (r) => <Box component="span" sx={{ fontFamily: 'monospace', fontWeight: 700, color: 'secondary.main' }}>{r.invoiceNumber}</Box>,
  },
  { key: 'dateTime', label: 'Date & Time', width: 150, filterValue: (r) => dateOf(r.invoiceDate), sortValue: (r) => new Date(r.invoiceDate).getTime(), csvValue: dateTimeOf, render: dateTimeOf },
  textCol('customer', 'Customer', 190),
  textCol('branch', 'Branch', 120),
  {
    key: 'salesEmployees', label: 'Sales Employees', width: 170,
    filterValue: (r) => (r.salesEmployees as string[]).join(', '), render: (r) => (r.salesEmployees as string[]).join(', ') || '—',
    csvValue: (r) => (r.salesEmployees as string[]).join(', '),
  },
  moneyCol('taxableAmount', 'Taxable Amount'), moneyCol('cgst', 'CGST'), moneyCol('sgst', 'SGST'), moneyCol('igst', 'IGST'),
  moneyCol('gstTotal', 'GST Total'), moneyCol('invoiceTotal', 'Invoice Total'),
  textCol('paymentStatus', 'Payment Status', 120), textCol('invoiceStatus', 'Invoice Status', 120),
];

const DETAIL_COLUMNS: DataTableColumn[] = [
  {
    key: 'invoiceNumber', label: 'Invoice No', width: 130,
    render: (r) => <Box component="span" sx={{ fontFamily: 'monospace', fontWeight: 700, color: 'secondary.main' }}>{r.invoiceNumber}</Box>,
  },
  { key: 'dateTime', label: 'Date & Time', width: 150, filterValue: (r) => dateOf(r.invoiceDate), sortValue: (r) => new Date(r.invoiceDate).getTime(), csvValue: dateTimeOf, render: dateTimeOf },
  textCol('branch', 'Branch', 120), textCol('customer', 'Customer', 190),
  {
    key: 'salesEmployee', label: 'Sales Employee', width: 150,
    render: (r) => (
      <Box component="span">
        {r.salesEmployee}
        {r.attributedBy === 'INVOICE' && <Tooltip title="Line left blank — credited to the bill's sales employee"><Box component="span" sx={{ color: 'text.secondary' }}> *</Box></Tooltip>}
      </Box>
    ),
    csvValue: (r) => r.salesEmployee,
  },
  textCol('jewelCode', 'Jewel Code / Tag No', 140), textCol('description', 'Item', 190),
  textCol('category', 'Category', 120), textCol('hsn', 'HSN', 90, true),
  { key: 'quantity', label: 'Qty', align: 'right', width: 70, filterable: false, sortValue: (r) => Number(r.quantity) },
  { key: 'grossWeight', label: 'Gross Wt', align: 'right', width: 100, filterable: false, sortValue: (r) => r.grossWeight, csvValue: (r) => r.grossWeight, render: (r) => mono(Number(r.grossWeight).toFixed(3)) },
  { key: 'netWeight', label: 'Net Wt', align: 'right', width: 100, filterable: false, sortValue: (r) => r.netWeight, csvValue: (r) => r.netWeight, render: (r) => mono(Number(r.netWeight).toFixed(3)) },
  { key: 'stoneWeight', label: 'Stone Wt', align: 'right', width: 100, filterable: false, sortValue: (r) => r.stoneWeight, csvValue: (r) => r.stoneWeight, render: (r) => mono(Number(r.stoneWeight).toFixed(3)) },
  textCol('karat', 'Karat', 80), textCol('huid', 'HUID', 110, true),
  textCol('subCategory', 'Sub Category', 120, true), textCol('collection', 'Collection', 120, true), textCol('stockType', 'Stock Type', 110, true),
  textCol('makeType', 'Make Type', 100, true), textCol('settingType', 'Setting', 100, true), textCol('size', 'Size', 80, true), textCol('manufacturer', 'Manufacturer', 140, true),
  moneyCol('metalRate', 'Metal Rate /g'), moneyCol('metalValue', 'Metal Value'),
  moneyCol('mcRate', 'MC Rate /g'), moneyCol('mcAmount', 'MC Amount'),
  numCol('vaPercent', 'VA %'), moneyCol('vaAmount', 'VA Amount'),
  moneyCol('stoneValue', 'Total Stone Cost'),
  moneyCol('grossAmount', 'Amount (before discount)'), moneyCol('discount', 'Discount'),
  moneyCol('taxableAmount', 'Total Taxable'), numCol('taxRate', 'GST %'),
  moneyCol('cgst', 'CGST'), moneyCol('sgst', 'SGST'), moneyCol('igst', 'IGST'), moneyCol('gst', 'GST'), moneyCol('lineTotal', 'Line Total'),
  moneyCol('returnedAmount', 'Returned', true), moneyCol('netTotal', 'Net Total', true), moneyCol('costPrice', 'Cost Price', true),
  textCol('lineStatus', 'Line Status', 100), textCol('invoiceStatus', 'Invoice Status', 120),
];

const sumRow = (rows: Row[], cols: DataTableColumn[], keys: string[], label: string) => {
  if (rows.length === 0) return null;
  return (
    <TableRow sx={{ '& td': { position: 'sticky', bottom: 0, bgcolor: 'background.paper', fontWeight: 700, borderTop: 2, borderColor: 'divider' } }}>
      {cols.map((c, i) => (
        <TableCell key={c.key} align={keys.includes(c.key) ? 'right' : 'left'} sx={{ whiteSpace: 'nowrap', fontFamily: keys.includes(c.key) ? 'monospace' : undefined }}>
          {keys.includes(c.key) ? money(rows.reduce((s, r) => s + Number(r[c.key] || 0), 0)) : i === 0 ? label : c.key === 'branch' ? '' : ''}
        </TableCell>
      ))}
    </TableRow>
  );
};

export function SalesReport() {
  const [view, setView] = useState<'summary' | 'detailed'>('summary');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [branchId, setBranchId] = useState('');
  const [invoiceNo, setInvoiceNo] = useState('');
  const [customer, setCustomer] = useState('');
  const [salesPersonId, setSalesPersonId] = useState('');
  const [paymentStatus, setPaymentStatus] = useState('');
  const [status, setStatus] = useState('');
  const exportRef = useRef<(() => void) | null>(null);

  const detailed = view === 'detailed';
  const params = useMemo(() => ({
    ...(from && { from }), ...(to && { to }), ...(branchId && { branchId }), ...(invoiceNo.trim() && { invoiceNo: invoiceNo.trim() }),
    ...(customer.trim() && { customer: customer.trim() }), ...(salesPersonId && { salesPersonId }),
    ...(paymentStatus && { paymentStatus }), ...(status && { status }),
  }), [from, to, branchId, invoiceNo, customer, salesPersonId, paymentStatus, status]);

  const { data, isLoading, isFetching } = useQuery({
    queryKey: ['sales-report', view, params],
    queryFn: () => apiGet<any>(detailed ? '/sales/reports/sales-detailed' : '/sales/reports/sales-summary', params),
    placeholderData: keepPreviousData,
  });

  const rows: Row[] = data?.rows ?? [];
  const branches: any[] = data?.branches ?? [];
  const employeeOptions: any[] = data?.employeeOptions ?? [];
  const totals = data?.totals ?? {};
  const employees: any[] = data?.employees ?? [];
  const reconciliation: any[] = data?.reconciliation ?? [];

  const exportReconciliation = () => exportToCsv('sales-report-reconciliation', [
    { header: 'Invoice No', value: (r: any) => r.invoiceNumber }, { header: 'Invoice Total', value: (r: any) => r.invoiceTotal },
    { header: 'Allocated To Lines', value: (r: any) => r.allocatedTotal }, { header: 'Other Charges / Round-off', value: (r: any) => r.nonLineAmount },
    { header: 'Difference', value: (r: any) => r.difference },
  ], reconciliation);

  return (
    <Box>
      <PageHeader title="Sales Report" />

      <Card sx={{ p: 1.5, mb: 1.5 }}>
        <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr 1fr', md: 'repeat(4, 1fr)' }, gap: 1.5, alignItems: 'center' }}>
          <DateField size="small" label="From Date" value={from} onChange={(e) => setFrom(e.target.value)} />
          <DateField size="small" label="To Date" value={to} onChange={(e) => setTo(e.target.value)} />
          <SelectField size="small" label="Branch" value={branchId} onChange={(e) => setBranchId(e.target.value)}
            emptyLabel="All Branches" options={branches.map((b) => ({ value: b.id, label: b.name }))} />
          <SelectField size="small" label="Sales Employee" value={salesPersonId} onChange={(e) => setSalesPersonId(e.target.value)}
            emptyLabel="All Employees" options={employeeOptions.map((e) => ({ value: e.id, label: e.name }))} />
          <TextField size="small" label="Invoice No" value={invoiceNo} onChange={(e) => setInvoiceNo(e.target.value)} InputLabelProps={{ shrink: true }} />
          <TextField size="small" label="Customer" placeholder="Name or code" value={customer} onChange={(e) => setCustomer(e.target.value)} InputLabelProps={{ shrink: true }} />
          <SelectField size="small" label="Payment Status" value={paymentStatus} onChange={(e) => setPaymentStatus(e.target.value)} emptyLabel="Any" options={PAYMENT_OPTIONS} />
          <SelectField size="small" label="Invoice Status" value={status} onChange={(e) => setStatus(e.target.value)} emptyLabel="Any" options={STATUS_OPTIONS} />
        </Box>
        <Box sx={{ display: 'flex', gap: 1.5, mt: 1.5, alignItems: 'center' }}>
          <ToggleButtonGroup size="small" exclusive value={view} onChange={(_, v) => v && setView(v)}>
            <ToggleButton value="summary">Summary</ToggleButton>
            <ToggleButton value="detailed">Detailed</ToggleButton>
          </ToggleButtonGroup>
          <Typography variant="caption" color="text.secondary">
            {detailed ? 'One row per sale line, credited to the employee who made it. * = line left blank, credited to the bill\'s employee.'
              : 'One row per invoice, however many employees share it.'}
            {' '}Right-click a column header to show/hide columns · drag to reorder{isFetching && !isLoading ? ' · refreshing…' : ''}
          </Typography>
          <Tooltip title="Export to Excel — downloads a CSV of the columns and rows currently shown">
            <span style={{ marginLeft: 'auto' }}>
              <IconButton aria-label="Export to Excel" disabled={rows.length === 0} onClick={() => exportRef.current?.()}
                sx={{ border: 1, borderColor: 'divider', borderRadius: 1, p: 0.75 }}>
                <FileDownload />
              </IconButton>
            </span>
          </Tooltip>
        </Box>
      </Card>

      {data?.truncated && (
        <Alert severity="warning" sx={{ mb: 1.5 }}>
          Showing the first {Number(data.limit).toLocaleString('en-IN')} rows only — narrow the dates, branch or employee to see the rest.
          {!detailed && ' The totals row at the bottom of the page below still covers every matching invoice.'}
        </Alert>
      )}

      {detailed && totals.discrepancyCount > 0 && (
        <Alert severity="error" sx={{ mb: 1.5 }}>
          {totals.discrepancyCount} invoice(s) do not reconcile — the lines plus other charges and round-off differ from the invoice total
          (see the Reconciliation table below). Investigate before relying on these figures.
        </Alert>
      )}

      <DataTable
        key={view}
        tableId={`sales-report-${view}`}
        columns={detailed ? DETAIL_COLUMNS : SUMMARY_COLUMNS}
        rows={rows}
        isLoading={isLoading}
        getRowId={(r) => r.id}
        emptyLabel="No sales match these filters"
        sortable
        pageSizeOptions={[100, 50, 200, 500]}
        maxHeight="calc(100vh - 420px)"
        csvFileName={detailed ? 'sales-report-detailed' : 'sales-report-summary'}
        exportRef={exportRef}
        footer={(filtered, cols) => detailed
          ? sumRow(filtered, cols, ['metalValue', 'mcAmount', 'vaAmount', 'stoneValue', 'grossAmount', 'discount', 'taxableAmount', 'cgst', 'sgst', 'igst', 'gst', 'lineTotal', 'returnedAmount', 'netTotal'], `Total · ${filtered.length} lines`)
          : sumRow(filtered, cols, ['taxableAmount', 'cgst', 'sgst', 'igst', 'gstTotal', 'invoiceTotal'], `Total · ${filtered.length} invoices`)}
      />

      {!detailed && totals.invoiceCount != null && (
        <Box sx={{ mt: 1, display: 'flex', gap: 3, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          <Typography variant="caption">All matching: <b>{totals.invoiceCount}</b> invoices</Typography>
          <Typography variant="caption">Taxable <b style={{ fontFamily: 'monospace' }}>{money(totals.taxableAmount)}</b></Typography>
          <Typography variant="caption">GST <b style={{ fontFamily: 'monospace' }}>{money(totals.gstTotal)}</b></Typography>
          <Typography variant="caption">Invoice total <b style={{ fontFamily: 'monospace' }}>{money(totals.invoiceTotal)}</b></Typography>
        </Box>
      )}

      {detailed && employees.length > 0 && (
        <Card sx={{ mt: 2, p: 1.5 }}>
          <Typography variant="subtitle2" sx={{ mb: 1 }}>Sales by employee</Typography>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Sales Employee</TableCell><TableCell align="right">Invoices</TableCell><TableCell align="right">Lines</TableCell>
                <TableCell align="right">Taxable</TableCell><TableCell align="right">GST</TableCell><TableCell align="right">Sales Amount</TableCell>
                <TableCell align="right">Returned</TableCell><TableCell align="right">Net Sales</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {employees.map((e) => (
                <TableRow key={e.salesEmployeeId ?? 'none'}>
                  <TableCell>{e.salesEmployee}</TableCell>
                  <TableCell align="right">{e.invoiceCount}</TableCell><TableCell align="right">{e.lineCount}</TableCell>
                  <TableCell align="right">{mono(money(e.taxableAmount))}</TableCell><TableCell align="right">{mono(money(e.gst))}</TableCell>
                  <TableCell align="right">{mono(money(e.salesAmount))}</TableCell>
                  <TableCell align="right">{mono(money(e.returnedAmount))}</TableCell><TableCell align="right">{mono(money(e.netSalesAmount))}</TableCell>
                </TableRow>
              ))}
              <TableRow sx={{ '& td': { fontWeight: 700, borderTop: 2, borderColor: 'divider' } }}>
                <TableCell>Total</TableCell>
                <TableCell align="right" colSpan={2}>{totals.invoiceCount} unique invoices</TableCell>
                <TableCell align="right">{mono(money(totals.taxableAmount))}</TableCell><TableCell align="right">{mono(money(totals.gst))}</TableCell>
                <TableCell align="right">{mono(money(totals.salesAmount))}</TableCell>
                <TableCell align="right">{mono(money(totals.returnedAmount))}</TableCell>
                <TableCell align="right">{mono(money(totals.salesAmount - totals.returnedAmount))}</TableCell>
              </TableRow>
            </TableBody>
          </Table>
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
            An invoice shared by two employees is counted once for each of them, and once in the unique-invoice total.
          </Typography>
        </Card>
      )}

      {detailed && reconciliation.length > 0 && (
        <Card sx={{ mt: 2, p: 1.5 }}>
          <Box sx={{ display: 'flex', alignItems: 'center', mb: 1 }}>
            <Typography variant="subtitle2">Reconciliation — invoice total vs. what the lines allocate</Typography>
            <Button size="small" sx={{ ml: 'auto' }} onClick={exportReconciliation}>Export CSV</Button>
          </Box>
          <Box sx={{ maxHeight: 280, overflow: 'auto' }}>
            <Table size="small" stickyHeader>
              <TableHead>
                <TableRow>
                  <TableCell>Invoice No</TableCell><TableCell align="right">Invoice Total</TableCell><TableCell align="right">Allocated To Lines</TableCell>
                  <TableCell align="right">Other Charges / Round-off</TableCell><TableCell align="right">Difference</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {reconciliation.map((r) => (
                  <TableRow key={r.invoiceId} sx={r.hasDiscrepancy ? { bgcolor: 'error.light' } : undefined}>
                    <TableCell sx={{ fontFamily: 'monospace' }}>{r.invoiceNumber}</TableCell>
                    <TableCell align="right">{mono(money(r.invoiceTotal))}</TableCell><TableCell align="right">{mono(money(r.allocatedTotal))}</TableCell>
                    <TableCell align="right">{mono(money(r.nonLineAmount))}</TableCell>
                    <TableCell align="right">{r.hasDiscrepancy ? <Chip size="small" color="error" label={money(r.difference)} /> : mono(money(r.difference))}</TableCell>
                  </TableRow>
                ))}
                <TableRow sx={{ '& td': { fontWeight: 700 } }}>
                  <TableCell>Total</TableCell>
                  <TableCell align="right">{mono(money(totals.invoiceTotal))}</TableCell><TableCell align="right">{mono(money(totals.allocatedTotal))}</TableCell>
                  <TableCell align="right">{mono(money(totals.nonLineAmount))}</TableCell><TableCell align="right">{mono(money(totals.difference))}</TableCell>
                </TableRow>
              </TableBody>
            </Table>
          </Box>
          <Typography variant="caption" color="text.secondary">
            Other charges and round-off belong to the bill, not to any one line, so they are shown separately; the difference should be zero.
          </Typography>
        </Card>
      )}
    </Box>
  );
}
