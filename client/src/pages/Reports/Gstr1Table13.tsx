import { useState, useMemo } from 'react';
import {
  Box, Card, Table, TableHead, TableBody, TableRow, TableCell, Typography, Divider,
  Grid, TextField, Alert, Chip, IconButton, Collapse,
  Accordion, AccordionSummary, AccordionDetails, InputAdornment, Tooltip,
  CircularProgress, TableContainer, Paper,
} from '@mui/material';
import {
  Download, KeyboardArrowDown, KeyboardArrowUp, ExpandMore, Search,
  WarningAmber, CheckCircleOutline, InfoOutlined, ErrorOutline,
} from '@mui/icons-material';
import { useQuery } from '@tanstack/react-query';
import { apiGet } from '../../api/client';
import { PageHeader, PageActions } from '../../components/common/PageHeader';
import { exportToCsv } from '../../utils/exportToCsv';
import { defaultGstFrom, defaultGstTo } from '../../utils/date';
import { useAuthStore } from '../../store/auth.store';

export type Table13DocumentCategory =
  | 'OUTWARD_INVOICE'
  | 'CREDIT_NOTE'
  | 'OUTWARD_DEBIT_NOTE'
  | 'DELIVERY_CHALLAN'
  | 'RECEIPT_VOUCHER'
  | 'PAYMENT_VOUCHER'
  | 'REFUND_VOUCHER'
  | 'OTHER';

export type Table13DiagnosticCode =
  | 'UNPARSEABLE_DOCUMENT_NUMBER'
  | 'DUPLICATE_DOCUMENT_ID'
  | 'DUPLICATE_DOCUMENT_SERIAL'
  | 'MISSING_SELLER_REGISTRATION'
  | 'DOCUMENT_FY_MISMATCH'
  | 'UNEXPLAINED_SEQUENCE_GAP'
  | 'LEGACY_SERIES'
  | 'UNSUPPORTED_DOCUMENT_TYPE'
  | 'INVALID_DOCUMENT_STATUS';

export interface Table13Diagnostic {
  code: Table13DiagnosticCode | string;
  severity: 'ERROR' | 'WARNING' | 'INFO';
  message: string;
  category?: Table13DocumentCategory | string;
  sellerRegistrationId?: string | null;
  seriesKey?: string;
  documentId?: string;
  documentNumber?: string;
  previousSerial?: number;
  nextSerial?: number;
  missingFrom?: number;
  missingTo?: number;
  missingCount?: number;
  serial?: number;
  conflictingDocumentIds?: string[];
  conflictingDocumentNumbers?: string[];
  encodedFinancialYear?: number | null;
  dateFinancialYear?: number | null;
}

export interface Table13SeriesResult {
  category: Table13DocumentCategory | string;
  sellerRegistrationId: string | null;
  seriesKey: string;
  prefix: string;
  financialYear: number | null;

  from: string;
  to: string;
  fromDocumentNumber: string;
  toDocumentNumber: string;
  fromSerial: number;
  toSerial: number;

  totalDocuments: number;
  cancelledDocuments: number;
  netIssued: number;

  documentCount: number;

  filingEligible: boolean;

  diagnostics: Table13Diagnostic[];

  branchIds?: string[];
}

export interface Table13AggregationSummary {
  seriesCount: number;
  filingEligibleSeries: number;
  nonFilingEligibleSeries: number;
  documentCount: number;
  cancelledDocumentCount: number;
  netIssued?: number;
}

export interface Table13ReportMeta {
  gstRegistrationId: string;
  period: {
    from: string | Date;
    to: string | Date;
    fromUtc?: string | Date;
    toUtc?: string | Date;
  };
  branchId: string | null;
  isPartialBranchSeries: boolean;
  salesInvoicesConsidered: number;
  creditNotesConsidered: number;
}

export interface Gstr1Table13Response {
  series?: Table13SeriesResult[];
  summary?: Table13AggregationSummary;
  diagnostics?: Table13Diagnostic[];
  meta?: Table13ReportMeta;

  engineResult?: {
    series: Table13SeriesResult[];
    summary: Table13AggregationSummary;
    diagnostics: Table13Diagnostic[];
  };
  metadata?: Table13ReportMeta;
}

export function formatCategory(cat: string): string {
  switch (cat) {
    case 'OUTWARD_INVOICE':
      return 'Outward Invoice';
    case 'CREDIT_NOTE':
      return 'Credit Note';
    case 'OUTWARD_DEBIT_NOTE':
      return 'Debit Note';
    case 'DELIVERY_CHALLAN':
      return 'Delivery Challan';
    case 'RECEIPT_VOUCHER':
      return 'Receipt Voucher';
    case 'PAYMENT_VOUCHER':
      return 'Payment Voucher';
    case 'REFUND_VOUCHER':
      return 'Refund Voucher';
    default:
      return cat?.replace(/_/g, ' ') || 'Other';
  }
}

export function formatFy(fy: number | null | undefined): string {
  if (!fy) return '—';
  const str = String(fy);
  if (str.length === 4) {
    const start = str.slice(0, 2);
    const end = str.slice(2, 4);
    return `20${start}-${end}`;
  }
  return String(fy);
}

export function formatRegistrationLabel(r: any): string {
  const gstin = r.gstin || '';
  const legal = r.legalName || '';
  const trade = r.tradeName && r.tradeName !== legal ? r.tradeName : '';
  if (trade) {
    return `${gstin} — ${legal} (${trade})`;
  }
  return legal ? `${gstin} — ${legal}` : gstin;
}

export function getDiagnosticNeutralExplanation(diag: Table13Diagnostic): string {
  if (diag.code === 'UNEXPLAINED_SEQUENCE_GAP') {
    return 'A sequence gap was detected in the available document numbers. Review the source records before filing.';
  }
  return diag.message || diag.code;
}

interface Gstr1Table13Props {
  initialGstRegistrationId?: string;
  initialExpandedAll?: boolean;
}

export function Gstr1Table13({
  initialGstRegistrationId = '',
  initialExpandedAll = false,
}: Gstr1Table13Props) {
  const user = useAuthStore((s) => s.user);
  const [from, setFrom] = useState(defaultGstFrom);
  const [to, setTo] = useState(defaultGstTo);
  const [branchId, setBranchId] = useState('');
  const [gstRegistrationId, setGstRegistrationId] = useState(initialGstRegistrationId);
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

  // Query Table 13 report only when gstRegistrationId is provided
  const { data, isLoading, error } = useQuery<Gstr1Table13Response>({
    queryKey: ['gstr1-table13', gstRegistrationId, from, to, branchId],
    queryFn: () =>
      apiGet<Gstr1Table13Response>('/finance/reports/gstr1-table13', {
        gstRegistrationId,
        from,
        to,
        ...(branchId ? { branchId } : {}),
      }),
    enabled: !!gstRegistrationId,
  });

  const series: Table13SeriesResult[] = useMemo(() => {
    return data?.series ?? data?.engineResult?.series ?? [];
  }, [data]);

  const diagnostics: Table13Diagnostic[] = useMemo(() => {
    return data?.diagnostics ?? data?.engineResult?.diagnostics ?? [];
  }, [data]);

  const summary: Table13AggregationSummary | undefined = useMemo(() => {
    const s = data?.summary ?? data?.engineResult?.summary;
    if (s) return s;
    if (series.length > 0) {
      const docCount = series.reduce((acc, r) => acc + (r.documentCount || 0), 0);
      const cancCount = series.reduce((acc, r) => acc + (r.cancelledDocuments || 0), 0);
      return {
        seriesCount: series.length,
        filingEligibleSeries: series.filter((r) => r.filingEligible).length,
        nonFilingEligibleSeries: series.filter((r) => !r.filingEligible).length,
        documentCount: docCount,
        cancelledDocumentCount: cancCount,
        netIssued: docCount - cancCount,
      };
    }
    return undefined;
  }, [data, series]);

  const meta: Table13ReportMeta | undefined = useMemo(() => {
    return data?.meta ?? data?.metadata;
  }, [data]);

  const toggleRow = (key: string) => {
    setExpandedRows((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const isRowExpanded = (key: string) => {
    return initialExpandedAll || !!expandedRows[key];
  };

  // Filtered diagnostics for diagnostics panel
  const filteredDiagnostics = useMemo(() => {
    if (!diagnosticFilter.trim()) return diagnostics;
    const q = diagnosticFilter.toLowerCase();
    return diagnostics.filter(
      (d) =>
        d.code?.toLowerCase().includes(q) ||
        d.message?.toLowerCase().includes(q) ||
        d.documentNumber?.toLowerCase().includes(q) ||
        d.seriesKey?.toLowerCase().includes(q)
    );
  }, [diagnostics, diagnosticFilter]);

  const handleExportCsv = () => {
    exportToCsv(
      'gstr1-table13',
      [
        { header: 'Document Type', value: (s: Table13SeriesResult) => formatCategory(s.category) },
        { header: 'GST Registration', value: (s: Table13SeriesResult) => s.sellerRegistrationId ?? '' },
        { header: 'Series / Prefix', value: (s: Table13SeriesResult) => s.prefix },
        { header: 'Financial Year', value: (s: Table13SeriesResult) => formatFy(s.financialYear) },
        { header: 'From Document Number', value: (s: Table13SeriesResult) => s.fromDocumentNumber || s.from },
        { header: 'To Document Number', value: (s: Table13SeriesResult) => s.toDocumentNumber || s.to },
        { header: 'From Serial', value: (s: Table13SeriesResult) => s.fromSerial },
        { header: 'To Serial', value: (s: Table13SeriesResult) => s.toSerial },
        { header: 'Document Count', value: (s: Table13SeriesResult) => s.documentCount },
        { header: 'Cancelled Documents', value: (s: Table13SeriesResult) => s.cancelledDocuments },
        { header: 'Net Issued Documents', value: (s: Table13SeriesResult) => s.netIssued },
        { header: 'Filing Eligibility', value: (s: Table13SeriesResult) => s.filingEligible ? 'Eligible' : 'Requires Review' },
        { header: 'Diagnostics Count', value: (s: Table13SeriesResult) => s.diagnostics?.length || 0 },
        { header: 'Diagnostics', value: (s: Table13SeriesResult) => (s.diagnostics || []).map((d) => d.code).join('; ') },
      ],
      series
    );
  };

  // Safe net issued calculation from summary
  const netIssuedDocs = useMemo(() => {
    if (!summary) return 0;
    if (summary.netIssued !== undefined) return summary.netIssued;
    return (summary.documentCount || 0) - (summary.cancelledDocumentCount || 0);
  }, [summary]);

  return (
    <Box>
      <PageHeader
        title="GSTR-1 — Table 13: Documents Issued"
        breadcrumbs={[
          { label: 'Reports', path: '/reports/gst-summary' },
          { label: 'GSTR-1 Table 13' },
        ]}
      />

      <Box sx={{ mb: 2 }}>
        <Typography variant="h5" fontWeight={700}>
          GSTR-1 — Table 13: Documents Issued
        </Typography>
        <Typography variant="body2" color="text.secondary">
          Documents issued, cancelled and sequence diagnostics
        </Typography>
      </Box>

      {/* Critical Partial-Series Warning or GSTIN-wide Status Notice */}
      {meta && (
        meta.isPartialBranchSeries ? (
          <Alert severity="warning" icon={<WarningAmber />} sx={{ mb: 2 }}>
            This is a branch-restricted operational view. Document series and sequence-gap information may represent only a partial view of the GST registration's complete series.
          </Alert>
        ) : (
          <Alert severity="info" icon={<InfoOutlined />} sx={{ mb: 2 }}>
            Complete GSTIN-level document series view for the selected period.
          </Alert>
        )
      )}

      {/* Status Alerts */}
      {error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          Failed to load Table 13 report: {error instanceof Error ? error.message : 'Please check your connection and query parameters.'}
        </Alert>
      )}

      {activeRegistrations.length === 0 && (
        <Alert severity="warning" sx={{ mb: 2 }}>
          No active GST registration configured.
        </Alert>
      )}

      {activeRegistrations.length > 0 && !gstRegistrationId && series.length === 0 && (
        <Alert severity="info" sx={{ mb: 2 }}>
          Please select a GST Registration to view Table 13 data.
        </Alert>
      )}

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
                series.length > 0
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

      {/* KPI Cards: 6 required KPI cards */}
      <Grid container spacing={2} sx={{ mb: 2 }}>
        <Grid item xs={6} sm={4} md={2}>
          <Card sx={{ p: 2, height: '100%' }}>
            <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              Series Count
            </Typography>
            <Typography variant="h5" fontWeight={700} sx={{ color: 'primary.main', mt: 0.5 }}>
              {isLoading ? '...' : (summary?.seriesCount ?? 0)}
            </Typography>
            <Typography variant="caption" color="text.secondary">
              Total document series
            </Typography>
          </Card>
        </Grid>
        <Grid item xs={6} sm={4} md={2}>
          <Card sx={{ p: 2, height: '100%' }}>
            <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              Filing-Eligible Series
            </Typography>
            <Typography variant="h5" fontWeight={700} sx={{ color: 'success.main', mt: 0.5 }}>
              {isLoading ? '...' : (summary?.filingEligibleSeries ?? 0)}
            </Typography>
            <Typography variant="caption" color="text.secondary">
              Clean contiguous series
            </Typography>
          </Card>
        </Grid>
        <Grid item xs={6} sm={4} md={2}>
          <Card sx={{ p: 2, height: '100%' }}>
            <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              Non-Filing-Eligible Series
            </Typography>
            <Typography
              variant="h5"
              fontWeight={700}
              sx={{ color: (summary?.nonFilingEligibleSeries ?? 0) > 0 ? 'warning.main' : 'text.secondary', mt: 0.5 }}
            >
              {isLoading ? '...' : (summary?.nonFilingEligibleSeries ?? 0)}
            </Typography>
            <Typography variant="caption" color="text.secondary">
              Requires review
            </Typography>
          </Card>
        </Grid>
        <Grid item xs={6} sm={4} md={2}>
          <Card sx={{ p: 2, height: '100%' }}>
            <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              Documents
            </Typography>
            <Typography variant="h5" fontWeight={700} sx={{ color: 'info.main', mt: 0.5 }}>
              {isLoading ? '...' : (summary?.documentCount ?? 0)}
            </Typography>
            <Typography variant="caption" color="text.secondary">
              Total documents recorded
            </Typography>
          </Card>
        </Grid>
        <Grid item xs={6} sm={4} md={2}>
          <Card sx={{ p: 2, height: '100%' }}>
            <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              Cancelled Documents
            </Typography>
            <Typography variant="h5" fontWeight={700} sx={{ color: 'error.main', mt: 0.5 }}>
              {isLoading ? '...' : (summary?.cancelledDocumentCount ?? 0)}
            </Typography>
            <Typography variant="caption" color="text.secondary">
              Void / cancelled records
            </Typography>
          </Card>
        </Grid>
        <Grid item xs={6} sm={4} md={2}>
          <Card sx={{ p: 2, height: '100%' }}>
            <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              Net Issued Documents
            </Typography>
            <Typography variant="h5" fontWeight={700} sx={{ color: 'text.primary', mt: 0.5 }}>
              {isLoading ? '...' : netIssuedDocs}
            </Typography>
            <Typography variant="caption" color="text.secondary">
              Issued less cancelled
            </Typography>
          </Card>
        </Grid>
      </Grid>

      {/* Main Series Table */}
      <TableContainer component={Paper} sx={{ mb: 3 }}>
        <Table size="small">
          <TableHead>
            <TableRow sx={{ backgroundColor: 'action.hover' }}>
              <TableCell width={48} />
              <TableCell sx={{ fontWeight: 600 }}>Document Type</TableCell>
              <TableCell sx={{ fontWeight: 600 }}>GST Registration</TableCell>
              <TableCell sx={{ fontWeight: 600 }}>Series / Prefix</TableCell>
              <TableCell sx={{ fontWeight: 600 }}>Financial Year</TableCell>
              <TableCell sx={{ fontWeight: 600 }}>From</TableCell>
              <TableCell sx={{ fontWeight: 600 }}>To</TableCell>
              <TableCell align="right" sx={{ fontWeight: 600 }}>Document Count</TableCell>
              <TableCell align="right" sx={{ fontWeight: 600 }}>Cancelled</TableCell>
              <TableCell align="center" sx={{ fontWeight: 600 }}>Filing Eligible</TableCell>
              <TableCell align="center" sx={{ fontWeight: 600 }}>Diagnostics</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {isLoading && (
              <TableRow>
                <TableCell colSpan={11} align="center" sx={{ py: 4 }}>
                  <CircularProgress size={24} sx={{ mr: 1, verticalAlign: 'middle' }} />
                  Loading GSTR-1 Table 13 report...
                </TableCell>
              </TableRow>
            )}

            {!isLoading && !gstRegistrationId && series.length === 0 && (
              <TableRow>
                <TableCell colSpan={11} align="center" sx={{ py: 4, color: 'text.secondary' }}>
                  Please select a GST Registration to view Table 13 data.
                </TableCell>
              </TableRow>
            )}

            {!isLoading && (gstRegistrationId || data) && series.length === 0 && (
              <TableRow>
                <TableCell colSpan={11} align="center" sx={{ py: 4, color: 'text.secondary' }}>
                  No Table 13 documents were found for the selected period/registration.
                </TableCell>
              </TableRow>
            )}

            {!isLoading &&
              series.map((s, idx) => {
                const rowKey = s.seriesKey || `${s.category}-${s.prefix}-${s.fromSerial}-${idx}`;
                const expanded = isRowExpanded(rowKey);
                const diagCount = s.diagnostics?.length || 0;

                return (
                  <RowItem
                    key={rowKey}
                    series={s}
                    expanded={expanded}
                    onToggle={() => toggleRow(rowKey)}
                    diagCount={diagCount}
                  />
                );
              })}
          </TableBody>
        </Table>
      </TableContainer>

      {/* Diagnostics Panel */}
      <Accordion defaultExpanded={diagnostics.length > 0} sx={{ mb: 3 }}>
        <AccordionSummary expandIcon={<ExpandMore />}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, width: '100%', pr: 2 }}>
            <Typography variant="subtitle1" fontWeight={700}>
              Diagnostics &amp; Data Quality
            </Typography>
            <Chip
              size="small"
              label={`${diagnostics.length} item${diagnostics.length === 1 ? '' : 's'}`}
              color={diagnostics.length > 0 ? 'warning' : 'success'}
            />
          </Box>
        </AccordionSummary>
        <AccordionDetails>
          <Box sx={{ mb: 2 }}>
            <TextField
              size="small"
              placeholder="Filter diagnostics by code, series, document number..."
              value={diagnosticFilter}
              onChange={(e) => setDiagnosticFilter(e.target.value)}
              InputProps={{
                startAdornment: (
                  <InputAdornment position="start">
                    <Search fontSize="small" />
                  </InputAdornment>
                ),
              }}
              sx={{ width: 340 }}
            />
          </Box>

          {filteredDiagnostics.length === 0 ? (
            <Alert severity="success" icon={<CheckCircleOutline />}>
              {diagnostics.length === 0
                ? 'No diagnostics detected. All documents and series conform to expected sequence and numbering rules.'
                : 'No diagnostics matching filter.'}
            </Alert>
          ) : (
            <TableContainer component={Paper} variant="outlined">
              <Table size="small">
                <TableHead>
                  <TableRow sx={{ backgroundColor: 'action.hover' }}>
                    <TableCell sx={{ fontWeight: 600 }}>Diagnostic Code</TableCell>
                    <TableCell sx={{ fontWeight: 600 }}>Severity</TableCell>
                    <TableCell sx={{ fontWeight: 600 }}>Series / Category</TableCell>
                    <TableCell sx={{ fontWeight: 600 }}>Document Reference</TableCell>
                    <TableCell sx={{ fontWeight: 600 }}>Observation &amp; Detail</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {filteredDiagnostics.map((d, dIdx) => (
                    <TableRow key={dIdx}>
                      <TableCell>
                        <Chip
                          size="small"
                          label={d.code}
                          color={
                            d.severity === 'ERROR'
                              ? 'error'
                              : d.severity === 'WARNING'
                              ? 'warning'
                              : 'default'
                          }
                          variant="outlined"
                          sx={{ fontFamily: 'monospace', fontWeight: 600 }}
                        />
                      </TableCell>
                      <TableCell>
                        <Typography variant="caption" sx={{ fontWeight: 600 }}>
                          {d.severity}
                        </Typography>
                      </TableCell>
                      <TableCell>
                        <Typography variant="body2" sx={{ fontFamily: 'monospace' }}>
                          {d.seriesKey || (d.category ? formatCategory(d.category) : '—')}
                        </Typography>
                      </TableCell>
                      <TableCell>
                        <Typography variant="body2" sx={{ fontFamily: 'monospace' }}>
                          {d.documentNumber || d.documentId || (d.missingFrom && d.missingTo ? `Serials ${d.missingFrom}–${d.missingTo}` : '—')}
                        </Typography>
                      </TableCell>
                      <TableCell>
                        <Typography variant="body2">
                          {getDiagnosticNeutralExplanation(d)}
                        </Typography>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
          )}
        </AccordionDetails>
      </Accordion>
    </Box>
  );
}

interface RowItemProps {
  series: Table13SeriesResult;
  expanded: boolean;
  onToggle: () => void;
  diagCount: number;
}

function RowItem({ series: s, expanded, onToggle, diagCount }: RowItemProps) {
  return (
    <>
      <TableRow hover sx={{ '& > *': { borderBottom: 'unset' } }}>
        <TableCell>
          <IconButton size="small" onClick={onToggle} aria-label={expanded ? 'collapse' : 'expand'}>
            {expanded ? <KeyboardArrowUp /> : <KeyboardArrowDown />}
          </IconButton>
        </TableCell>
        <TableCell sx={{ fontWeight: 500 }}>
          {formatCategory(s.category)}
        </TableCell>
        <TableCell sx={{ fontFamily: 'monospace', fontSize: '0.85rem' }}>
          {s.sellerRegistrationId || '—'}
        </TableCell>
        <TableCell sx={{ fontFamily: 'monospace', fontWeight: 600 }}>
          {s.prefix || '—'}
        </TableCell>
        <TableCell>
          {formatFy(s.financialYear)}
        </TableCell>
        <TableCell sx={{ fontFamily: 'monospace', fontWeight: 500 }}>
          {s.fromDocumentNumber || s.from}
        </TableCell>
        <TableCell sx={{ fontFamily: 'monospace', fontWeight: 500 }}>
          {s.toDocumentNumber || s.to}
        </TableCell>
        <TableCell align="right" sx={{ fontWeight: 600 }}>
          {s.documentCount}
        </TableCell>
        <TableCell align="right" sx={{ color: s.cancelledDocuments > 0 ? 'error.main' : 'text.secondary' }}>
          {s.cancelledDocuments}
        </TableCell>
        <TableCell align="center">
          <Chip
            size="small"
            icon={s.filingEligible ? <CheckCircleOutline fontSize="small" /> : <WarningAmber fontSize="small" />}
            label={s.filingEligible ? 'Eligible' : 'Requires Review'}
            color={s.filingEligible ? 'success' : 'warning'}
            variant={s.filingEligible ? 'outlined' : 'filled'}
          />
        </TableCell>
        <TableCell align="center">
          {diagCount > 0 ? (
            <Chip
              size="small"
              label={`${diagCount} issue${diagCount > 1 ? 's' : ''}`}
              color="warning"
              variant="outlined"
            />
          ) : (
            <Typography variant="caption" color="text.secondary">
              None
            </Typography>
          )}
        </TableCell>
      </TableRow>

      {/* Expanded Details Row */}
      <TableRow>
        <TableCell colSpan={11} sx={{ py: 0, px: 2 }}>
          <Collapse in={expanded} timeout="auto" unmountOnExit>
            <Box sx={{ py: 2, px: 1, backgroundColor: 'background.default', borderRadius: 1, my: 1 }}>
              <Typography variant="subtitle2" fontWeight={700} sx={{ mb: 1.5 }}>
                Series Diagnostics &amp; Range Details — {s.prefix} ({formatCategory(s.category)})
              </Typography>

              <Grid container spacing={2} sx={{ mb: 2 }}>
                <Grid item xs={12} sm={6} md={3}>
                  <Card variant="outlined" sx={{ p: 1.5 }}>
                    <Typography variant="caption" color="text.secondary" fontWeight={600}>
                      DOCUMENT &amp; SERIAL RANGE
                    </Typography>
                    <Typography variant="body2" sx={{ mt: 0.5, fontFamily: 'monospace' }}>
                      From: {s.fromDocumentNumber || s.from} (Serial #{s.fromSerial})
                    </Typography>
                    <Typography variant="body2" sx={{ fontFamily: 'monospace' }}>
                      To: {s.toDocumentNumber || s.to} (Serial #{s.toSerial})
                    </Typography>
                  </Card>
                </Grid>
                <Grid item xs={12} sm={6} md={3}>
                  <Card variant="outlined" sx={{ p: 1.5 }}>
                    <Typography variant="caption" color="text.secondary" fontWeight={600}>
                      DOCUMENT METRICS
                    </Typography>
                    <Typography variant="body2" sx={{ mt: 0.5 }}>
                      Total Documents: <strong>{s.totalDocuments}</strong>
                    </Typography>
                    <Typography variant="body2" color="error.main">
                      Cancelled Documents: <strong>{s.cancelledDocuments}</strong>
                    </Typography>
                    <Typography variant="body2" color="primary.main">
                      Net Issued: <strong>{s.netIssued}</strong>
                    </Typography>
                  </Card>
                </Grid>
                <Grid item xs={12} sm={6} md={3}>
                  <Card variant="outlined" sx={{ p: 1.5 }}>
                    <Typography variant="caption" color="text.secondary" fontWeight={600}>
                      FILING STATUS
                    </Typography>
                    <Box sx={{ mt: 0.5 }}>
                      <Chip
                        size="small"
                        label={s.filingEligible ? 'Eligible' : 'Requires Review'}
                        color={s.filingEligible ? 'success' : 'warning'}
                      />
                    </Box>
                    <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
                      {s.filingEligible
                        ? 'Series meets structural filing criteria.'
                        : 'Review diagnostics before statutory filing.'}
                    </Typography>
                  </Card>
                </Grid>
                <Grid item xs={12} sm={6} md={3}>
                  <Card variant="outlined" sx={{ p: 1.5 }}>
                    <Typography variant="caption" color="text.secondary" fontWeight={600}>
                      SEQUENCE SEPARATION
                    </Typography>
                    <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
                      Cancelled count represents {s.cancelledDocuments} void document(s).
                      Missing numbers (if any) represent sequence gaps, not cancellations.
                    </Typography>
                  </Card>
                </Grid>
              </Grid>

              {/* Series Diagnostics List */}
              {s.diagnostics && s.diagnostics.length > 0 ? (
                <Box sx={{ mt: 1 }}>
                  <Typography variant="caption" color="text.secondary" fontWeight={700} sx={{ textTransform: 'uppercase', mb: 1, display: 'block' }}>
                    Series Diagnostics ({s.diagnostics.length})
                  </Typography>
                  <TableContainer component={Paper} variant="outlined">
                    <Table size="small">
                      <TableHead>
                        <TableRow sx={{ backgroundColor: 'action.hover' }}>
                          <TableCell sx={{ fontWeight: 600 }}>Code</TableCell>
                          <TableCell sx={{ fontWeight: 600 }}>Severity</TableCell>
                          <TableCell sx={{ fontWeight: 600 }}>Missing Range / Reference</TableCell>
                          <TableCell sx={{ fontWeight: 600 }}>Explanation</TableCell>
                        </TableRow>
                      </TableHead>
                      <TableBody>
                        {s.diagnostics.map((d, dIdx) => (
                          <TableRow key={dIdx}>
                            <TableCell>
                              <Chip
                                size="small"
                                label={d.code}
                                color={
                                  d.severity === 'ERROR'
                                    ? 'error'
                                    : d.severity === 'WARNING'
                                    ? 'warning'
                                    : 'default'
                                }
                                variant="outlined"
                                sx={{ fontFamily: 'monospace', fontWeight: 600 }}
                              />
                            </TableCell>
                            <TableCell>
                              <Typography variant="caption" sx={{ fontWeight: 600 }}>
                                {d.severity}
                              </Typography>
                            </TableCell>
                            <TableCell>
                              {d.missingFrom && d.missingTo ? (
                                <Typography variant="body2" sx={{ fontFamily: 'monospace', color: 'warning.dark' }}>
                                  Serials {d.missingFrom} to {d.missingTo} ({d.missingCount} missing)
                                </Typography>
                              ) : d.documentNumber ? (
                                <Typography variant="body2" sx={{ fontFamily: 'monospace' }}>
                                  {d.documentNumber}
                                </Typography>
                              ) : (
                                '—'
                              )}
                            </TableCell>
                            <TableCell>
                              <Typography variant="body2">
                                {getDiagnosticNeutralExplanation(d)}
                              </Typography>
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </TableContainer>
                </Box>
              ) : (
                <Alert severity="success" icon={<CheckCircleOutline />} sx={{ mt: 1 }}>
                  No sequence gaps or formatting anomalies detected for this series.
                </Alert>
              )}
            </Box>
          </Collapse>
        </TableCell>
      </TableRow>
    </>
  );
}
