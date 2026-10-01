import { useState, useMemo } from 'react';
import {
  Box, Card, Table, TableHead, TableBody, TableRow, TableCell, Typography, Divider,
  Grid, TextField, Alert, Tabs, Tab, Chip, IconButton, Collapse,
  Accordion, AccordionSummary, AccordionDetails, InputAdornment, Tooltip,
} from '@mui/material';
import {
  Download, KeyboardArrowDown, KeyboardArrowUp, ExpandMore, Search,
  WarningAmber, CheckCircleOutline,
} from '@mui/icons-material';
import { useQuery } from '@tanstack/react-query';
import { apiGet } from '../../api/client';
import { PageHeader, PageActions } from '../../components/common/PageHeader';
import { exportToCsv } from '../../utils/exportToCsv';
import { defaultGstFrom, defaultGstTo } from '../../utils/date';
import { useAuthStore } from '../../store/auth.store';

export type Gstr1Table12ReportingTab = 'B2B_SUPPLIES' | 'B2C_SUPPLIES';

export interface Gstr1Table12Row {
  reportingTab: Gstr1Table12ReportingTab;
  hsnCode: string | null;
  description: string | null;
  uqc: string | null;
  gstRate: number;

  quantity: number;
  taxableValue: number;
  cgst: number;
  sgst: number;
  igst: number;
  cess: number;

  grossQuantity: number;
  creditNoteQuantityReduction: number;
  grossTaxableValue: number;
  creditNoteTaxableReduction: number;
  grossCgst: number;
  creditNoteCgstReduction: number;
  grossSgst: number;
  creditNoteSgstReduction: number;
  grossIgst: number;
  creditNoteIgstReduction: number;
  grossCess: number;
  creditNoteCessReduction: number;

  filingEligible: boolean;
  recordCount: number;
  creditNoteRecordCount: number;
}

export interface Gstr1Table12Diagnostic {
  code: string;
  reason: string;
  invoiceId?: string;
  invoiceNumber?: string | null;
  creditNoteId?: string;
  creditNoteNumber?: string | null;
  reportingTab?: Gstr1Table12ReportingTab;
  hsnCode?: string | null;
  gstRate?: number;
  uqc?: string | null;
}

export interface Gstr1Table12Response {
  rows: Gstr1Table12Row[];
  diagnostics: Gstr1Table12Diagnostic[];
  summary: {
    b2bRows: number;
    b2cRows: number;
    diagnosticCount: number;
  };
  meta: {
    gstRegistrationId: string;
    period: { from: string | Date; to: string | Date };
    invoicesConsidered: number;
    invoicesExcludedByScope: number;
    creditNotesConsidered: number;
    creditNotesExcludedByScope: number;
    hsnDigitCompliance: string;
  };
}

function money(n: number) {
  return '₹' + Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 });
}

function formatQty(q: number): string {
  if (q === null || q === undefined || isNaN(q)) return '0';
  return Number(q).toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 3 });
}

function formatRate(rate: number): string {
  if (rate === null || rate === undefined || isNaN(rate)) return '0%';
  return `${Number((rate * 100).toFixed(2))}%`.replace('.00%', '%');
}

function formatRegistrationLabel(r: any): string {
  const gstin = r.gstin || '';
  const legal = r.legalName || '';
  const trade = r.tradeName && r.tradeName !== legal ? r.tradeName : '';
  if (trade) {
    return `${gstin} — ${legal} (${trade})`;
  }
  return legal ? `${gstin} — ${legal}` : gstin;
}

interface Gstr1Table12Props {
  initialTab?: number;
  initialExpandedAll?: boolean;
}

export function Gstr1Table12({ initialTab = 0, initialExpandedAll = false }: Gstr1Table12Props) {
  const user = useAuthStore((s) => s.user);
  const [from, setFrom] = useState(defaultGstFrom);
  const [to, setTo] = useState(defaultGstTo);
  const [branchId, setBranchId] = useState('');
  const [gstRegistrationId, setGstRegistrationId] = useState('');
  const [activeTab, setActiveTab] = useState(initialTab);
  const [expandedRows, setExpandedRows] = useState<Record<string, boolean>>({});
  const [diagnosticFilter, setDiagnosticFilter] = useState('');

  // Fetch branches
  const { data: branchData } = useQuery({
    queryKey: ['branches'],
    queryFn: () => apiGet<any>('/tagging/branches'),
  });
  const allBranches: any[] = (branchData as any)?.data ?? branchData ?? [];

  const accessibleBranches = useMemo(() => {
    const active = allBranches.filter((b: any) => b.isActive !== false);
    if (!user?.branchAccess || user.branchAccess.allBranches) {
      return active;
    }
    const allowed = new Set(user.branchAccess.branchIds ?? []);
    return active.filter((b: any) => allowed.has(b.id));
  }, [allBranches, user?.branchAccess]);

  // Fetch company GST registrations
  const { data: regData } = useQuery({
    queryKey: ['gst-registrations'],
    queryFn: () => apiGet<any>('/company/gst-registrations'),
  });
  const allRegistrations: any[] = (regData as any)?.data ?? regData ?? [];

  const activeRegistrations = useMemo(() => {
    return allRegistrations.filter((r: any) => r.isActive !== false);
  }, [allRegistrations]);

  // Query Table 12 report only when gstRegistrationId is provided
  const { data, isLoading, error } = useQuery<Gstr1Table12Response>({
    queryKey: ['gstr1-table12', gstRegistrationId, from, to, branchId],
    queryFn: () =>
      apiGet<Gstr1Table12Response>('/finance/reports/gstr1-table12', {
        gstRegistrationId,
        from,
        to,
        ...(branchId ? { branchId } : {}),
      }),
    enabled: !!gstRegistrationId,
  });

  const rows: Gstr1Table12Row[] = data?.rows ?? [];
  const diagnostics: Gstr1Table12Diagnostic[] = data?.diagnostics ?? [];
  const summary = data?.summary ?? {
    b2bRows: rows.filter((r) => r.reportingTab === 'B2B_SUPPLIES').length,
    b2cRows: rows.filter((r) => r.reportingTab === 'B2C_SUPPLIES').length,
    diagnosticCount: diagnostics.length,
  };
  const meta = data?.meta;

  // Filter rows by active tab: 0 = B2B Supplies, 1 = B2C Supplies
  const currentTab = activeTab === 0 ? 'B2B_SUPPLIES' : 'B2C_SUPPLIES';
  const currentRows = useMemo(() => {
    return rows.filter((r) => r.reportingTab === currentTab);
  }, [rows, currentTab]);

  // Totals for current tab
  const currentTotals = useMemo(() => {
    return currentRows.reduce(
      (acc, r) => ({
        quantity: acc.quantity + (r.quantity || 0),
        taxableValue: acc.taxableValue + (r.taxableValue || 0),
        cgst: acc.cgst + (r.cgst || 0),
        sgst: acc.sgst + (r.sgst || 0),
        igst: acc.igst + (r.igst || 0),
        cess: acc.cess + (r.cess || 0),
      }),
      { quantity: 0, taxableValue: 0, cgst: 0, sgst: 0, igst: 0, cess: 0 }
    );
  }, [currentRows]);

  const totalTax = currentTotals.cgst + currentTotals.sgst + currentTotals.igst + currentTotals.cess;

  const toggleRow = (key: string) => {
    setExpandedRows((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const isRowExpanded = (key: string) => {
    return initialExpandedAll || !!expandedRows[key];
  };

  // Filtered diagnostics
  const filteredDiagnostics = useMemo(() => {
    if (!diagnosticFilter.trim()) return diagnostics;
    const q = diagnosticFilter.toLowerCase();
    return diagnostics.filter(
      (d) =>
        d.code?.toLowerCase().includes(q) ||
        d.reason?.toLowerCase().includes(q) ||
        d.invoiceNumber?.toLowerCase().includes(q) ||
        d.creditNoteNumber?.toLowerCase().includes(q) ||
        d.hsnCode?.toLowerCase().includes(q)
    );
  }, [diagnostics, diagnosticFilter]);

  const handleExportCsv = () => {
    const filename = activeTab === 0 ? 'gstr1-table12-b2b' : 'gstr1-table12-b2c';
    exportToCsv(
      filename,
      [
        { header: 'HSN', value: (r: Gstr1Table12Row) => r.hsnCode ?? '' },
        { header: 'Description', value: (r: Gstr1Table12Row) => r.description ?? '' },
        { header: 'UQC', value: (r: Gstr1Table12Row) => r.uqc ?? '' },
        { header: 'GST Rate', value: (r: Gstr1Table12Row) => formatRate(r.gstRate) },
        { header: 'Quantity', value: (r: Gstr1Table12Row) => r.quantity },
        { header: 'Taxable Value', value: (r: Gstr1Table12Row) => r.taxableValue },
        { header: 'CGST', value: (r: Gstr1Table12Row) => r.cgst },
        { header: 'SGST', value: (r: Gstr1Table12Row) => r.sgst },
        { header: 'IGST', value: (r: Gstr1Table12Row) => r.igst },
        { header: 'Cess', value: (r: Gstr1Table12Row) => r.cess },
      ],
      currentRows
    );
  };

  return (
    <Box>
      <PageHeader
        title="Table 12 — HSN-wise Summary"
        breadcrumbs={[
          { label: 'Reports', path: '/reports/gst-summary' },
          { label: 'GSTR-1 Table 12' },
        ]}
      />

      <Typography variant="h5" fontWeight={700} sx={{ mb: 1.5 }}>
        Table 12 — HSN-wise Summary
      </Typography>

      {/* AATO Status & General Info Notice */}
      <Alert severity="info" sx={{ mb: 2 }}>
        HSN digit compliance: Not determined — AATO configuration is not available.
      </Alert>

      {/* Filter Card */}
      <Card sx={{ p: 2, mb: 2 }}>
        <Grid container spacing={2} alignItems="center">
          <Grid item xs={12} sm={6} md={3.5}>
            <TextField
              fullWidth
              size="small"
              select
              label="GST Registration"
              value={gstRegistrationId}
              onChange={(e) => setGstRegistrationId(e.target.value)}
              SelectProps={{ native: true }}
              InputLabelProps={{ shrink: true }}
            >
              <option value="">Select GST Registration</option>
              {activeRegistrations.map((r: any) => (
                <option key={r.id} value={r.id}>
                  {formatRegistrationLabel(r)}
                </option>
              ))}
            </TextField>
          </Grid>
          <Grid item xs={6} sm={3} md={2}>
            <TextField
              fullWidth
              size="small"
              label="From"
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              InputLabelProps={{ shrink: true }}
            />
          </Grid>
          <Grid item xs={6} sm={3} md={2}>
            <TextField
              fullWidth
              size="small"
              label="To"
              type="date"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              InputLabelProps={{ shrink: true }}
            />
          </Grid>
          <Grid item xs={12} sm={6} md={2.5}>
            <TextField
              fullWidth
              size="small"
              select
              label="Branch"
              value={branchId}
              onChange={(e) => setBranchId(e.target.value)}
              SelectProps={{ native: true }}
              InputLabelProps={{ shrink: true }}
            >
              <option value="">All Branches</option>
              {accessibleBranches.map((b: any) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </TextField>
          </Grid>
          <Grid item sx={{ ml: 'auto', alignSelf: 'center' }}>
            <PageActions
              actions={
                currentRows.length > 0
                  ? [
                      {
                        label: 'Export CSV',
                        icon: <Download />,
                        onClick: handleExportCsv,
                      },
                    ]
                  : []
              }
            />
          </Grid>
        </Grid>
      </Card>

      {/* Summary KPI section */}
      <Grid container spacing={2} sx={{ mb: 2 }}>
        <Grid item xs={12} sm={4}>
          <Card sx={{ p: 2, height: '100%' }}>
            <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.08em' }}>
              B2B Rows
            </Typography>
            <Typography variant="h5" fontWeight={700} sx={{ color: 'primary.main', mt: 0.5 }}>
              {isLoading ? '...' : (summary?.b2bRows ?? 0)}
            </Typography>
            <Typography variant="caption" color="text.secondary">
              Table 12 — B2B Supplies
            </Typography>
          </Card>
        </Grid>
        <Grid item xs={12} sm={4}>
          <Card sx={{ p: 2, height: '100%' }}>
            <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.08em' }}>
              B2C Rows
            </Typography>
            <Typography variant="h5" fontWeight={700} sx={{ color: 'info.main', mt: 0.5 }}>
              {isLoading ? '...' : (summary?.b2cRows ?? 0)}
            </Typography>
            <Typography variant="caption" color="text.secondary">
              Table 12 — B2C Supplies
            </Typography>
          </Card>
        </Grid>
        <Grid item xs={12} sm={4}>
          <Card sx={{ p: 2, height: '100%' }}>
            <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.08em' }}>
              Diagnostics
            </Typography>
            <Typography
              variant="h5"
              fontWeight={700}
              sx={{ color: (summary?.diagnosticCount ?? 0) > 0 ? 'warning.main' : 'success.main', mt: 0.5 }}
            >
              {isLoading ? '...' : (summary?.diagnosticCount ?? 0)}
            </Typography>
            <Typography variant="caption" color="text.secondary">
              Data quality &amp; excluded items
            </Typography>
          </Card>
        </Grid>
      </Grid>

      {/* Error state */}
      {error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          Failed to load Table 12 report: {(error as any)?.message ?? 'An error occurred'}
        </Alert>
      )}

      {/* No active registrations configured */}
      {activeRegistrations.length === 0 && (
        <Alert severity="warning" sx={{ mb: 2 }}>
          No active GST registration configured. Please set up a GST registration to view Table 12 reports.
        </Alert>
      )}

      {/* No registration selected prompt */}
      {activeRegistrations.length > 0 && !gstRegistrationId && (
        <Alert severity="info" sx={{ mb: 2 }}>
          Please select a GST Registration to view Table 12 data.
        </Alert>
      )}

      {/* Tabs */}
      <Tabs
        value={activeTab}
        onChange={(_, val) => setActiveTab(val)}
        sx={{ mb: 2, borderBottom: 1, borderColor: 'divider' }}
      >
        <Tab label="Table 12 — B2B Supplies" />
        <Tab label="Table 12 — B2C Supplies" />
      </Tabs>

      {/* Main Report Table Card */}
      <Card sx={{ mb: 3 }}>
        <Box sx={{ overflowX: 'auto' }}>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell sx={{ width: 44 }} />
                <TableCell>HSN</TableCell>
                <TableCell>Description</TableCell>
                <TableCell>UQC</TableCell>
                <TableCell align="right">GST Rate</TableCell>
                <TableCell align="right">Quantity</TableCell>
                <TableCell align="right">Taxable Value</TableCell>
                <TableCell align="right">CGST</TableCell>
                <TableCell align="right">SGST</TableCell>
                <TableCell align="right">IGST</TableCell>
                <TableCell align="right">Cess</TableCell>
                <TableCell align="center">Filing Status</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {isLoading && (
                <TableRow>
                  <TableCell colSpan={12} align="center" sx={{ py: 4 }}>
                    Loading Table 12 report...
                  </TableCell>
                </TableRow>
              )}

              {!isLoading && gstRegistrationId && currentRows.length === 0 && (
                <TableRow>
                  <TableCell colSpan={12} align="center" sx={{ py: 4 }}>
                    No Table 12 data found for the selected registration, period and branch.
                  </TableCell>
                </TableRow>
              )}

              {!isLoading &&
                currentRows.map((r, index) => {
                  const rowKey = `${r.reportingTab}-${r.hsnCode}-${r.uqc}-${r.gstRate}-${index}`;
                  const expanded = isRowExpanded(rowKey);
                  return (
                    <RowItem
                      key={rowKey}
                      row={r}
                      expanded={expanded}
                      onToggle={() => toggleRow(rowKey)}
                    />
                  );
                })}
            </TableBody>
          </Table>
        </Box>
        <Divider />
        <Box
          sx={{
            p: 1.5,
            display: 'flex',
            justifyContent: 'flex-end',
            gap: 3,
            bgcolor: '#EEF1FA',
            flexWrap: 'wrap',
          }}
        >
          <Typography sx={{ fontFamily: 'monospace' }}>
            Qty: {formatQty(currentTotals.quantity)}
          </Typography>
          <Typography sx={{ fontFamily: 'monospace' }}>
            Taxable: {money(currentTotals.taxableValue)}
          </Typography>
          <Typography sx={{ fontFamily: 'monospace' }}>
            CGST: {money(currentTotals.cgst)}
          </Typography>
          <Typography sx={{ fontFamily: 'monospace' }}>
            SGST: {money(currentTotals.sgst)}
          </Typography>
          <Typography sx={{ fontFamily: 'monospace' }}>
            IGST: {money(currentTotals.igst)}
          </Typography>
          {currentTotals.cess > 0 && (
            <Typography sx={{ fontFamily: 'monospace' }}>
              Cess: {money(currentTotals.cess)}
            </Typography>
          )}
          <Typography fontWeight={700} sx={{ fontFamily: 'monospace' }}>
            Total Tax: {money(totalTax)}
          </Typography>
        </Box>
      </Card>

      {/* Diagnostics / Data Quality Section */}
      <Card sx={{ p: 2 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 1.5, flexWrap: 'wrap', gap: 1 }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <Typography variant="h6" fontWeight={700} sx={{ fontSize: 16 }}>
              Diagnostics &amp; Data Quality
            </Typography>
            <Chip
              label={`${diagnostics.length} issues`}
              size="small"
              color={diagnostics.length > 0 ? 'warning' : 'default'}
              sx={{ fontWeight: 600, fontSize: 11 }}
            />
          </Box>
          {diagnostics.length > 0 && (
            <TextField
              size="small"
              placeholder="Search diagnostics..."
              value={diagnosticFilter}
              onChange={(e) => setDiagnosticFilter(e.target.value)}
              InputProps={{
                startAdornment: (
                  <InputAdornment position="start">
                    <Search fontSize="small" />
                  </InputAdornment>
                ),
              }}
              sx={{ width: { xs: '100%', sm: 260 } }}
            />
          )}
        </Box>

        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 2 }}>
          Data-quality observations, excluded documents, and validation findings. Note that diagnostics indicate data-quality or reporting conditions, not automatically GST legal violations.
        </Typography>

        {diagnostics.length === 0 ? (
          <Box sx={{ py: 2, textAlign: 'center', color: 'text.secondary' }}>
            <CheckCircleOutline sx={{ color: 'success.main', fontSize: 32, mb: 0.5 }} />
            <Typography variant="body2">No data-quality issues or excluded items found.</Typography>
          </Box>
        ) : (
          <Box sx={{ overflowX: 'auto' }}>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>Code</TableCell>
                  <TableCell>Reason</TableCell>
                  <TableCell>Tab</TableCell>
                  <TableCell>HSN</TableCell>
                  <TableCell>Rate</TableCell>
                  <TableCell>UQC</TableCell>
                  <TableCell>Reference Document</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {filteredDiagnostics.map((d, i) => (
                  <TableRow key={i} hover>
                    <TableCell>
                      <Chip
                        label={d.code}
                        size="small"
                        color="warning"
                        variant="outlined"
                        sx={{ fontFamily: 'monospace', fontWeight: 600, fontSize: 11 }}
                      />
                    </TableCell>
                    <TableCell sx={{ fontSize: 13 }}>{d.reason}</TableCell>
                    <TableCell sx={{ fontSize: 12 }}>
                      {d.reportingTab ? (d.reportingTab === 'B2B_SUPPLIES' ? 'B2B' : 'B2C') : '—'}
                    </TableCell>
                    <TableCell sx={{ fontFamily: 'monospace', fontSize: 12 }}>{d.hsnCode ?? '—'}</TableCell>
                    <TableCell sx={{ fontSize: 12 }}>{d.gstRate !== undefined ? formatRate(d.gstRate) : '—'}</TableCell>
                    <TableCell sx={{ fontSize: 12 }}>{d.uqc ?? '—'}</TableCell>
                    <TableCell sx={{ fontFamily: 'monospace', fontSize: 12 }}>
                      {d.invoiceNumber
                        ? `Invoice: ${d.invoiceNumber}`
                        : d.creditNoteNumber
                        ? `Credit Note: ${d.creditNoteNumber}`
                        : '—'}
                    </TableCell>
                  </TableRow>
                ))}
                {filteredDiagnostics.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={7} align="center" sx={{ py: 2 }}>
                      No diagnostics match the search filter.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </Box>
        )}
      </Card>
    </Box>
  );
}

interface RowItemProps {
  row: Gstr1Table12Row;
  expanded: boolean;
  onToggle: () => void;
}

function RowItem({ row, expanded, onToggle }: RowItemProps) {
  const isFilingIneligible = row.filingEligible === false;

  return (
    <>
      <TableRow
        hover
        sx={{
          bgcolor: isFilingIneligible ? 'rgba(237, 108, 2, 0.04)' : undefined,
          '& > *': { borderBottom: expanded ? 'unset' : undefined },
        }}
      >
        <TableCell>
          <IconButton size="small" onClick={onToggle} aria-label="expand row">
            {expanded ? <KeyboardArrowUp fontSize="small" /> : <KeyboardArrowDown fontSize="small" />}
          </IconButton>
        </TableCell>
        <TableCell sx={{ fontFamily: 'monospace', fontWeight: 700 }}>
          {row.hsnCode ?? '—'}
        </TableCell>
        <TableCell sx={{ fontSize: 12, maxWidth: 220 }}>
          {row.description ?? '—'}
        </TableCell>
        <TableCell sx={{ fontFamily: 'monospace', fontSize: 12 }}>
          {row.uqc ?? '—'}
        </TableCell>
        <TableCell align="right">{formatRate(row.gstRate)}</TableCell>
        <TableCell align="right" sx={{ fontFamily: 'monospace' }}>
          {formatQty(row.quantity)}
        </TableCell>
        <TableCell align="right" sx={{ fontFamily: 'monospace' }}>
          {money(row.taxableValue)}
        </TableCell>
        <TableCell align="right" sx={{ fontFamily: 'monospace' }}>
          {row.cgst > 0 ? money(row.cgst) : '—'}
        </TableCell>
        <TableCell align="right" sx={{ fontFamily: 'monospace' }}>
          {row.sgst > 0 ? money(row.sgst) : '—'}
        </TableCell>
        <TableCell align="right" sx={{ fontFamily: 'monospace' }}>
          {row.igst > 0 ? money(row.igst) : '—'}
        </TableCell>
        <TableCell align="right" sx={{ fontFamily: 'monospace' }}>
          {row.cess > 0 ? money(row.cess) : '—'}
        </TableCell>
        <TableCell align="center">
          {isFilingIneligible ? (
            <Tooltip title="Filing ineligible — review data-quality diagnostics">
              <Chip
                label="Requires Attention"
                color="warning"
                size="small"
                icon={<WarningAmber fontSize="small" />}
                sx={{ fontWeight: 600, fontSize: 11 }}
              />
            </Tooltip>
          ) : (
            <Chip
              label="Eligible"
              color="success"
              variant="outlined"
              size="small"
              sx={{ fontWeight: 600, fontSize: 11 }}
            />
          )}
        </TableCell>
      </TableRow>

      {/* Expandable Credit Note breakdown row */}
      <TableRow>
        <TableCell sx={{ py: 0, px: 2 }} colSpan={12}>
          <Collapse in={expanded} timeout="auto" unmountOnExit>
            <Box sx={{ my: 1.5, p: 2, bgcolor: '#F8FAFC', borderRadius: 1.5, border: '1px solid #E2E8F0' }}>
              <Typography variant="subtitle2" fontWeight={700} sx={{ mb: 1, color: 'text.secondary' }}>
                Credit Note Transparency &amp; Net Breakdown
              </Typography>
              <Grid container spacing={2}>
                <Grid item xs={12} md={6}>
                  <Table size="small" sx={{ bgcolor: '#FFF', borderRadius: 1, border: '1px solid #E2E8F0' }}>
                    <TableHead>
                      <TableRow>
                        <TableCell>Metric</TableCell>
                        <TableCell align="right">Gross Outward</TableCell>
                        <TableCell align="right">Credit Note Reduction</TableCell>
                        <TableCell align="right" sx={{ fontWeight: 700 }}>Net Reported</TableCell>
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      <TableRow>
                        <TableCell>Quantity</TableCell>
                        <TableCell align="right" sx={{ fontFamily: 'monospace' }}>{formatQty(row.grossQuantity)}</TableCell>
                        <TableCell align="right" sx={{ fontFamily: 'monospace', color: 'error.main' }}>
                          {row.creditNoteQuantityReduction > 0 ? `-${formatQty(row.creditNoteQuantityReduction)}` : '0'}
                        </TableCell>
                        <TableCell align="right" sx={{ fontFamily: 'monospace', fontWeight: 700 }}>{formatQty(row.quantity)}</TableCell>
                      </TableRow>
                      <TableRow>
                        <TableCell>Taxable Value</TableCell>
                        <TableCell align="right" sx={{ fontFamily: 'monospace' }}>{money(row.grossTaxableValue)}</TableCell>
                        <TableCell align="right" sx={{ fontFamily: 'monospace', color: 'error.main' }}>
                          {row.creditNoteTaxableReduction > 0 ? `-${money(row.creditNoteTaxableReduction)}` : '₹0.00'}
                        </TableCell>
                        <TableCell align="right" sx={{ fontFamily: 'monospace', fontWeight: 700 }}>{money(row.taxableValue)}</TableCell>
                      </TableRow>
                      <TableRow>
                        <TableCell>CGST</TableCell>
                        <TableCell align="right" sx={{ fontFamily: 'monospace' }}>{money(row.grossCgst)}</TableCell>
                        <TableCell align="right" sx={{ fontFamily: 'monospace', color: 'error.main' }}>
                          {row.creditNoteCgstReduction > 0 ? `-${money(row.creditNoteCgstReduction)}` : '₹0.00'}
                        </TableCell>
                        <TableCell align="right" sx={{ fontFamily: 'monospace', fontWeight: 700 }}>{money(row.cgst)}</TableCell>
                      </TableRow>
                    </TableBody>
                  </Table>
                </Grid>
                <Grid item xs={12} md={6}>
                  <Table size="small" sx={{ bgcolor: '#FFF', borderRadius: 1, border: '1px solid #E2E8F0' }}>
                    <TableHead>
                      <TableRow>
                        <TableCell>Metric</TableCell>
                        <TableCell align="right">Gross Outward</TableCell>
                        <TableCell align="right">Credit Note Reduction</TableCell>
                        <TableCell align="right" sx={{ fontWeight: 700 }}>Net Reported</TableCell>
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      <TableRow>
                        <TableCell>SGST</TableCell>
                        <TableCell align="right" sx={{ fontFamily: 'monospace' }}>{money(row.grossSgst)}</TableCell>
                        <TableCell align="right" sx={{ fontFamily: 'monospace', color: 'error.main' }}>
                          {row.creditNoteSgstReduction > 0 ? `-${money(row.creditNoteSgstReduction)}` : '₹0.00'}
                        </TableCell>
                        <TableCell align="right" sx={{ fontFamily: 'monospace', fontWeight: 700 }}>{money(row.sgst)}</TableCell>
                      </TableRow>
                      <TableRow>
                        <TableCell>IGST</TableCell>
                        <TableCell align="right" sx={{ fontFamily: 'monospace' }}>{money(row.grossIgst)}</TableCell>
                        <TableCell align="right" sx={{ fontFamily: 'monospace', color: 'error.main' }}>
                          {row.creditNoteIgstReduction > 0 ? `-${money(row.creditNoteIgstReduction)}` : '₹0.00'}
                        </TableCell>
                        <TableCell align="right" sx={{ fontFamily: 'monospace', fontWeight: 700 }}>{money(row.igst)}</TableCell>
                      </TableRow>
                      <TableRow>
                        <TableCell>Cess</TableCell>
                        <TableCell align="right" sx={{ fontFamily: 'monospace' }}>{money(row.grossCess)}</TableCell>
                        <TableCell align="right" sx={{ fontFamily: 'monospace', color: 'error.main' }}>
                          {row.creditNoteCessReduction > 0 ? `-${money(row.creditNoteCessReduction)}` : '₹0.00'}
                        </TableCell>
                        <TableCell align="right" sx={{ fontFamily: 'monospace', fontWeight: 700 }}>{money(row.cess)}</TableCell>
                      </TableRow>
                    </TableBody>
                  </Table>
                </Grid>
              </Grid>
              <Box sx={{ mt: 1.5, display: 'flex', gap: 3, color: 'text.secondary', fontSize: 12 }}>
                <Typography variant="caption">Outward supply records: <strong>{row.recordCount}</strong></Typography>
                <Typography variant="caption">Credit Note reduction records: <strong>{row.creditNoteRecordCount}</strong></Typography>
              </Box>
            </Box>
          </Collapse>
        </TableCell>
      </TableRow>
    </>
  );
}
