import React, { useState, useMemo } from 'react';
import {
  Box, Card, Table, TableHead, TableBody, TableRow, TableCell, Typography, Divider,
  Grid, TextField, Alert, Tabs, Tab, Chip, IconButton, Collapse,
  Accordion, AccordionSummary, AccordionDetails, InputAdornment, Tooltip,
  CircularProgress, Paper, TableContainer,
} from '@mui/material';
import {
  Download, KeyboardArrowDown, KeyboardArrowUp, ExpandMore, Search,
  WarningAmber, CheckCircleOutline, InfoOutlined, ErrorOutline,
  TrendingDown, TrendingUp, RemoveCircleOutline,
} from '@mui/icons-material';
import { useQuery } from '@tanstack/react-query';
import { apiGet } from '../../api/client';
import { PageHeader, PageActions } from '../../components/common/PageHeader';
import { defaultGstFrom, defaultGstTo, gstFinancialYear, formatLocalDate } from '../../utils/date';
import { useAuthStore } from '../../store/auth.store';
import {
  exportTable4Csv,
  exportTable5Csv,
  exportTable7Csv,
  exportTable9bCsv,
} from '../../utils/gstr1Csv';
import type {
  Gstr1OutwardResponse,
  Gstr1CreditNoteResponse,
  Gstr1B2bInvoiceRecord,
  Gstr1B2clInvoiceRecord,
  Gstr1B2csGroup,
  Gstr1CreditNoteReportDocument,
} from '../../types/gstr1';

// ─────────────────────────────────────────────────────────────────────────────
// Formatters
// ─────────────────────────────────────────────────────────────────────────────

export function money(n: number | null | undefined): string {
  if (n === null || n === undefined || isNaN(n)) return '₹0.00';
  const isNegative = n < 0;
  const abs = Math.abs(n).toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return isNegative ? `-₹${abs}` : `₹${abs}`;
}

export function formatQty(q: number | null | undefined): string {
  if (q === null || q === undefined || isNaN(q)) return '0';
  const isNegative = q < 0;
  const abs = Math.abs(q).toLocaleString('en-IN', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 3,
  });
  return isNegative ? `-${abs}` : abs;
}

export function formatRate(rate: number | null | undefined): string {
  if (rate === null || rate === undefined || isNaN(rate)) return '0%';
  return `${Number((rate * 100).toFixed(2))}%`.replace('.00%', '%');
}

export function formatLocalDateStr(d: string | Date | null | undefined): string {
  if (!d) return '—';
  if (typeof d === 'string') {
    return d.split('T')[0];
  }
  return d.toISOString().split('T')[0];
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

interface Gstr1Props {
  initialTab?: number;
  initialGstRegistrationId?: string;
}

export function Gstr1({ initialTab = 0, initialGstRegistrationId = '' }: Gstr1Props) {
  const user = useAuthStore((s) => s.user);

  // Filters State
  const currentFy = gstFinancialYear();
  const [selectedFy, setSelectedFy] = useState<string>(String(currentFy));
  const [from, setFrom] = useState<string>(defaultGstFrom);
  const [to, setTo] = useState<string>(defaultGstTo);
  const [branchId, setBranchId] = useState<string>('');
  const [gstRegistrationId, setGstRegistrationId] = useState<string>(initialGstRegistrationId);

  // Tabs State: 0 = Table 4, 1 = Table 5, 2 = Table 7, 3 = Table 9B
  const [activeTab, setActiveTab] = useState<number>(initialTab);

  // Table 9B Sub-tab: 0 = CDNR, 1 = CDNUR B2CL, 2 = CDNUR Export
  // CRITICAL: NO CDNUR B2CS!
  const [table9bSubTab, setTable9bSubTab] = useState<number>(0);

  // Expandable Row States
  const [expandedRows, setExpandedRows] = useState<Record<string, boolean>>({});

  // Search/Filter text for tables
  const [tableSearch, setTableSearch] = useState<string>('');

  const toggleRow = (key: string) => {
    setExpandedRows((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  // Handle FY Selection change
  const handleFyChange = (fyVal: string) => {
    setSelectedFy(fyVal);
    if (fyVal === 'custom') return;
    const fyNum = parseInt(fyVal, 10);
    if (!isNaN(fyNum)) {
      const fyStart = `${fyNum}-04-01`;
      const fyEnd = `${fyNum + 1}-03-31`;
      setFrom(fyStart);
      if (fyNum === currentFy) {
        setTo(formatLocalDate(new Date()));
      } else {
        setTo(fyEnd);
      }
    }
  };

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

  // Fetch GST registrations
  const { data: regData } = useQuery({
    queryKey: ['gst-registrations'],
    queryFn: () => apiGet<any>('/company/gst-registrations'),
  });
  const allRegistrations: any[] = (regData as any)?.data ?? regData ?? [];

  const activeRegistrations = useMemo(() => {
    return allRegistrations.filter((r: any) => r.isActive !== false);
  }, [allRegistrations]);

  // Auto-select primary registration if none selected yet
  React.useEffect(() => {
    if (!gstRegistrationId && activeRegistrations.length > 0) {
      const primary = activeRegistrations.find((r: any) => r.isPrimary) ?? activeRegistrations[0];
      if (primary) {
        setGstRegistrationId(primary.id);
      }
    }
  }, [activeRegistrations, gstRegistrationId]);

  // Query 1: Outward Supplies (Tables 4, 5, 7)
  const {
    data: outwardData,
    isLoading: isLoadingOutward,
    error: outwardError,
  } = useQuery<Gstr1OutwardResponse>({
    queryKey: ['gstr1-outward', gstRegistrationId, from, to, branchId],
    queryFn: () =>
      apiGet<Gstr1OutwardResponse>('/finance/reports/gstr1-outward', {
        gstRegistrationId,
        from,
        to,
        ...(branchId ? { branchId } : {}),
      }),
    enabled: !!gstRegistrationId && !!from && !!to,
  });

  // Query 2: Credit Notes (Table 9B)
  const {
    data: creditNotesData,
    isLoading: isLoadingCreditNotes,
    error: creditNotesError,
  } = useQuery<Gstr1CreditNoteResponse>({
    queryKey: ['gstr1-credit-notes', gstRegistrationId, from, to, branchId],
    queryFn: () =>
      apiGet<Gstr1CreditNoteResponse>('/finance/reports/gstr1-credit-notes', {
        gstRegistrationId,
        from,
        to,
        ...(branchId ? { branchId } : {}),
      }),
    enabled: !!gstRegistrationId && !!from && !!to,
  });

  // Filtered Table 4 rows
  const filteredB2b = useMemo(() => {
    const list = outwardData?.b2b ?? [];
    if (!tableSearch.trim()) return list;
    const q = tableSearch.toLowerCase();
    return list.filter(
      (r) =>
        r.invoiceNumber.toLowerCase().includes(q) ||
        r.buyerGstin.toLowerCase().includes(q) ||
        (r.placeOfSupply && r.placeOfSupply.toLowerCase().includes(q))
    );
  }, [outwardData?.b2b, tableSearch]);

  // Filtered Table 5 rows
  const filteredB2cl = useMemo(() => {
    const list = outwardData?.b2cl ?? [];
    if (!tableSearch.trim()) return list;
    const q = tableSearch.toLowerCase();
    return list.filter(
      (r) =>
        r.invoiceNumber.toLowerCase().includes(q) ||
        (r.placeOfSupply && r.placeOfSupply.toLowerCase().includes(q))
    );
  }, [outwardData?.b2cl, tableSearch]);

  // Filtered Table 7 groups
  const filteredB2cs = useMemo(() => {
    const list = outwardData?.b2cs ?? [];
    if (!tableSearch.trim()) return list;
    const q = tableSearch.toLowerCase();
    return list.filter(
      (r) =>
        r.placeOfSupply.toLowerCase().includes(q) ||
        (r.hsnCode && r.hsnCode.toLowerCase().includes(q)) ||
        (r.uqc && r.uqc.toLowerCase().includes(q))
    );
  }, [outwardData?.b2cs, tableSearch]);

  // Table 7 CA / Accountant Summary Totals from backend
  const b2csSummaryTotals = useMemo(() => {
    const groups = outwardData?.b2cs ?? [];
    let grossTaxable = 0;
    let cnTaxableRed = 0;
    let netTaxable = outwardData?.totals?.b2cs?.taxableValue ?? 0;

    let grossCgst = 0;
    let cnCgstRed = 0;
    let netCgst = outwardData?.totals?.b2cs?.cgst ?? 0;

    let grossSgst = 0;
    let cnSgstRed = 0;
    let netSgst = outwardData?.totals?.b2cs?.sgst ?? 0;

    let grossIgst = 0;
    let cnIgstRed = 0;
    let netIgst = outwardData?.totals?.b2cs?.igst ?? 0;

    let grossCess = 0;
    let cnCessRed = 0;
    let netCess = outwardData?.totals?.b2cs?.cess ?? 0;

    let grossQty = 0;
    let cnQtyRed = 0;
    let netQty = 0;

    let totalGrossRecords = 0;
    let totalCnRecords = 0;
    let negativeBucketCount = 0;

    for (const g of groups) {
      grossTaxable += g.grossTaxableValue || 0;
      cnTaxableRed += g.creditNoteTaxableReduction || 0;

      grossCgst += g.grossCgst || 0;
      cnCgstRed += g.creditNoteCgstReduction || 0;

      grossSgst += g.grossSgst || 0;
      cnSgstRed += g.creditNoteSgstReduction || 0;

      grossIgst += g.grossIgst || 0;
      cnIgstRed += g.creditNoteIgstReduction || 0;

      grossCess += g.grossCess || 0;
      cnCessRed += g.creditNoteCessReduction || 0;

      grossQty += g.grossQuantity || 0;
      cnQtyRed += g.creditNoteQuantityReduction || 0;
      netQty += g.quantity || 0;

      totalGrossRecords += g.recordCount || 0;
      totalCnRecords += g.creditNoteRecordCount || 0;

      if (!g.filingEligible || g.taxableValue < 0) {
        negativeBucketCount++;
      }
    }

    return {
      grossTaxable,
      cnTaxableRed,
      netTaxable,
      grossCgst,
      cnCgstRed,
      netCgst,
      grossSgst,
      cnSgstRed,
      netSgst,
      grossIgst,
      cnIgstRed,
      netIgst,
      grossCess,
      cnCessRed,
      netCess,
      grossQty,
      cnQtyRed,
      netQty,
      totalGrossRecords,
      totalCnRecords,
      negativeBucketCount,
    };
  }, [outwardData?.b2cs, outwardData?.totals?.b2cs]);

  // Filtered Table 9B rows
  const cdnrDocuments = useMemo(() => {
    const list = creditNotesData?.cdnr?.documents ?? [];
    if (!tableSearch.trim()) return list;
    const q = tableSearch.toLowerCase();
    return list.filter(
      (d) =>
        d.creditNoteNumber.toLowerCase().includes(q) ||
        d.originalInvoiceNumber.toLowerCase().includes(q) ||
        (d.buyerGstin && d.buyerGstin.toLowerCase().includes(q)) ||
        (d.placeOfSupply && d.placeOfSupply.toLowerCase().includes(q))
    );
  }, [creditNotesData?.cdnr?.documents, tableSearch]);

  const cdnurB2clDocuments = useMemo(() => {
    const list = creditNotesData?.cdnur?.b2cl?.documents ?? [];
    if (!tableSearch.trim()) return list;
    const q = tableSearch.toLowerCase();
    return list.filter(
      (d) =>
        d.creditNoteNumber.toLowerCase().includes(q) ||
        d.originalInvoiceNumber.toLowerCase().includes(q) ||
        (d.placeOfSupply && d.placeOfSupply.toLowerCase().includes(q))
    );
  }, [creditNotesData?.cdnur?.b2cl?.documents, tableSearch]);

  const cdnurExportDocuments = useMemo(() => {
    const list = creditNotesData?.cdnur?.export?.documents ?? [];
    if (!tableSearch.trim()) return list;
    const q = tableSearch.toLowerCase();
    return list.filter(
      (d) =>
        d.creditNoteNumber.toLowerCase().includes(q) ||
        d.originalInvoiceNumber.toLowerCase().includes(q)
    );
  }, [creditNotesData?.cdnur?.export?.documents, tableSearch]);

  // Export CSV Handler
  const handleExportCsv = () => {
    if (activeTab === 0) {
      exportTable4Csv(outwardData?.b2b ?? [], `gstr1-table4-b2b-${from}-to-${to}.csv`);
    } else if (activeTab === 1) {
      exportTable5Csv(outwardData?.b2cl ?? [], `gstr1-table5-b2cl-${from}-to-${to}.csv`);
    } else if (activeTab === 2) {
      exportTable7Csv(outwardData?.b2cs ?? [], `gstr1-table7-b2cs-${from}-to-${to}.csv`);
    } else if (activeTab === 3) {
      if (table9bSubTab === 0) {
        exportTable9bCsv(
          creditNotesData?.cdnr?.documents ?? [],
          'CDNR',
          `gstr1-table9b-cdnr-${from}-to-${to}.csv`
        );
      } else if (table9bSubTab === 1) {
        exportTable9bCsv(
          creditNotesData?.cdnur?.b2cl?.documents ?? [],
          'CDNUR_B2CL',
          `gstr1-table9b-cdnur-b2cl-${from}-to-${to}.csv`
        );
      } else {
        exportTable9bCsv(
          creditNotesData?.cdnur?.export?.documents ?? [],
          'CDNUR_EXPORT',
          `gstr1-table9b-cdnur-export-${from}-to-${to}.csv`
        );
      }
    }
  };

  const isCurrentTabLoading =
    activeTab === 3 ? isLoadingCreditNotes : isLoadingOutward;
  const currentTabError = activeTab === 3 ? creditNotesError : outwardError;

  return (
    <Box>
      <PageHeader
        title="GSTR-1 Return Filing Reports"
        breadcrumbs={[
          { label: 'Reports', path: '/reports/gst-summary' },
          { label: 'GSTR-1' },
        ]}
      />

      <Typography variant="h5" fontWeight={700} sx={{ mb: 1.5 }}>
        GSTR-1 Outward Supplies & Credit Notes
      </Typography>

      {/* Filter Card */}
      <Card sx={{ p: 2, mb: 3 }}>
        <Grid container spacing={2} alignItems="center">
          {/* GST Registration (Required) */}
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

          {/* Financial Year Quick Selector */}
          <Grid item xs={6} sm={3} md={2}>
            <TextField
              fullWidth
              size="small"
              select
              label="Financial Year"
              value={selectedFy}
              onChange={(e) => handleFyChange(e.target.value)}
              SelectProps={{ native: true }}
              InputLabelProps={{ shrink: true }}
            >
              <option value={String(currentFy)}>FY {currentFy}-{String(currentFy + 1).slice(2)}</option>
              <option value={String(currentFy - 1)}>FY {currentFy - 1}-{String(currentFy).slice(2)}</option>
              <option value={String(currentFy - 2)}>FY {currentFy - 2}-{String(currentFy - 1).slice(2)}</option>
              <option value="custom">Custom Range</option>
            </TextField>
          </Grid>

          {/* From Date */}
          <Grid item xs={6} sm={3} md={1.75}>
            <TextField
              fullWidth
              size="small"
              label="From Date"
              type="date"
              value={from}
              onChange={(e) => {
                setFrom(e.target.value);
                setSelectedFy('custom');
              }}
              InputLabelProps={{ shrink: true }}
            />
          </Grid>

          {/* To Date */}
          <Grid item xs={6} sm={3} md={1.75}>
            <TextField
              fullWidth
              size="small"
              label="To Date"
              type="date"
              value={to}
              onChange={(e) => {
                setTo(e.target.value);
                setSelectedFy('custom');
              }}
              InputLabelProps={{ shrink: true }}
            />
          </Grid>

          {/* Branch (Optional) */}
          <Grid item xs={6} sm={3} md={3}>
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
        </Grid>
      </Card>

      {/* No Registration Warning */}
      {!gstRegistrationId && (
        <Alert severity="warning" sx={{ mb: 3 }}>
          Please select a GST Registration above to load the GSTR-1 reports.
        </Alert>
      )}

      {/* Error Alert */}
      {currentTabError && (
        <Alert severity="error" sx={{ mb: 3 }}>
          Failed to load GSTR-1 report: {(currentTabError as any)?.message || 'An error occurred'}
        </Alert>
      )}

      {/* Main Tabs Navigation */}
      <Card sx={{ mb: 2 }}>
        <Box sx={{ borderBottom: 1, borderColor: 'divider', px: 2, display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap' }}>
          <Tabs
            value={activeTab}
            onChange={(_, val) => {
              setActiveTab(val);
              setTableSearch('');
            }}
            textColor="primary"
            indicatorColor="primary"
            variant="scrollable"
            scrollButtons="auto"
          >
            <Tab
              label={
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                  <span>Table 4 — B2B</span>
                  {outwardData?.b2b && (
                    <Chip size="small" label={outwardData.b2b.length} sx={{ height: 20, fontSize: '0.75rem' }} />
                  )}
                </Box>
              }
            />
            <Tab
              label={
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                  <span>Table 5 — B2CL</span>
                  {outwardData?.b2cl && (
                    <Chip size="small" label={outwardData.b2cl.length} sx={{ height: 20, fontSize: '0.75rem' }} />
                  )}
                </Box>
              }
            />
            <Tab
              label={
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                  <span>Table 7 — B2CS</span>
                  {outwardData?.b2cs && (
                    <Chip
                      size="small"
                      label={outwardData.b2cs.length}
                      color={b2csSummaryTotals.negativeBucketCount > 0 ? 'error' : 'default'}
                      sx={{ height: 20, fontSize: '0.75rem' }}
                    />
                  )}
                </Box>
              }
            />
            <Tab
              label={
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                  <span>Table 9B — Credit / Debit Notes</span>
                  {creditNotesData && (
                    <Chip
                      size="small"
                      label={
                        (creditNotesData.cdnr?.documents?.length || 0) +
                        (creditNotesData.cdnur?.b2cl?.documents?.length || 0) +
                        (creditNotesData.cdnur?.export?.documents?.length || 0)
                      }
                      sx={{ height: 20, fontSize: '0.75rem' }}
                    />
                  )}
                </Box>
              }
            />
          </Tabs>

          <Box sx={{ py: 1, display: 'flex', alignItems: 'center', gap: 2 }}>
            <TextField
              size="small"
              placeholder="Search in table..."
              value={tableSearch}
              onChange={(e) => setTableSearch(e.target.value)}
              InputProps={{
                startAdornment: (
                  <InputAdornment position="start">
                    <Search fontSize="small" />
                  </InputAdornment>
                ),
              }}
              sx={{ width: 220 }}
            />
            <PageActions
              actions={[
                {
                  label: 'Export CSV',
                  icon: <Download />,
                  onClick: handleExportCsv,
                },
              ]}
            />
          </Box>
        </Box>
      </Card>

      {/* ─────────────────────────────────────────────────────────────────────────
          TAB 0: TABLE 4 — B2B
          ───────────────────────────────────────────────────────────────────────── */}
      {activeTab === 0 && (
        <Box>
          {/* Table 4 Summary Bar */}
          <Card sx={{ p: 2, mb: 2, bgcolor: '#F8FAFC' }}>
            <Typography variant="subtitle2" color="text.secondary" fontWeight={700} sx={{ mb: 1 }}>
              Table 4 B2B Summary
            </Typography>
            <Grid container spacing={2}>
              <Grid item xs={6} sm={4} md={2}>
                <Typography variant="caption" color="text.secondary">Invoices</Typography>
                <Typography variant="body1" fontWeight={700} sx={{ fontFamily: 'monospace' }}>
                  {outwardData?.totals?.b2b?.invoiceCount ?? 0}
                </Typography>
              </Grid>
              <Grid item xs={6} sm={4} md={2}>
                <Typography variant="caption" color="text.secondary">Taxable Value</Typography>
                <Typography variant="body1" fontWeight={700} sx={{ fontFamily: 'monospace' }}>
                  {money(outwardData?.totals?.b2b?.taxableValue)}
                </Typography>
              </Grid>
              <Grid item xs={6} sm={4} md={2}>
                <Typography variant="caption" color="text.secondary">CGST</Typography>
                <Typography variant="body1" fontWeight={700} sx={{ fontFamily: 'monospace' }}>
                  {money(outwardData?.totals?.b2b?.cgst)}
                </Typography>
              </Grid>
              <Grid item xs={6} sm={4} md={2}>
                <Typography variant="caption" color="text.secondary">SGST</Typography>
                <Typography variant="body1" fontWeight={700} sx={{ fontFamily: 'monospace' }}>
                  {money(outwardData?.totals?.b2b?.sgst)}
                </Typography>
              </Grid>
              <Grid item xs={6} sm={4} md={2}>
                <Typography variant="caption" color="text.secondary">IGST</Typography>
                <Typography variant="body1" fontWeight={700} sx={{ fontFamily: 'monospace' }}>
                  {money(outwardData?.totals?.b2b?.igst)}
                </Typography>
              </Grid>
              <Grid item xs={6} sm={4} md={2}>
                <Typography variant="caption" color="text.secondary">Total Invoice Value</Typography>
                <Typography variant="body1" fontWeight={700} color="primary" sx={{ fontFamily: 'monospace' }}>
                  {money(outwardData?.totals?.b2b?.invoiceValue)}
                </Typography>
              </Grid>
            </Grid>
          </Card>

          {/* Table 4 Table */}
          <Card>
            <TableContainer>
              <Table size="small">
                <TableHead sx={{ bgcolor: '#F1F5F9' }}>
                  <TableRow>
                    <TableCell sx={{ width: 48 }} />
                    <TableCell>Recipient GSTIN</TableCell>
                    <TableCell>Invoice No.</TableCell>
                    <TableCell>Invoice Date</TableCell>
                    <TableCell>Place of Supply</TableCell>
                    <TableCell align="center">Rev. Charge</TableCell>
                    <TableCell align="right">Taxable Value</TableCell>
                    <TableCell align="right">CGST</TableCell>
                    <TableCell align="right">SGST</TableCell>
                    <TableCell align="right">IGST</TableCell>
                    <TableCell align="right">Cess</TableCell>
                    <TableCell align="right">Invoice Value</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {isCurrentTabLoading ? (
                    <TableRow>
                      <TableCell colSpan={12} align="center" sx={{ py: 6 }}>
                        <CircularProgress size={32} sx={{ mb: 1 }} />
                        <Typography variant="body2" color="text.secondary">Loading Table 4 B2B data...</Typography>
                      </TableCell>
                    </TableRow>
                  ) : filteredB2b.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={12} align="center" sx={{ py: 6 }}>
                        <Typography variant="body2" color="text.secondary">
                          No records found for the selected period.
                        </Typography>
                      </TableCell>
                    </TableRow>
                  ) : (
                    filteredB2b.map((inv) => {
                      const isExpanded = !!expandedRows[`b2b-${inv.invoiceId}`];
                      return (
                        <React.Fragment key={inv.invoiceId}>
                          <TableRow hover sx={{ '&:hover': { bgcolor: '#F8FAFC' } }}>
                            <TableCell>
                              <IconButton
                                size="small"
                                onClick={() => toggleRow(`b2b-${inv.invoiceId}`)}
                                title={isExpanded ? 'Collapse line details' : 'Expand line details'}
                              >
                                {isExpanded ? <KeyboardArrowUp fontSize="small" /> : <KeyboardArrowDown fontSize="small" />}
                              </IconButton>
                            </TableCell>
                            <TableCell sx={{ fontFamily: 'monospace', fontWeight: 700 }}>
                              {inv.buyerGstin}
                            </TableCell>
                            <TableCell sx={{ fontWeight: 600 }}>{inv.invoiceNumber}</TableCell>
                            <TableCell>{formatLocalDateStr(inv.invoiceDate)}</TableCell>
                            <TableCell>{inv.placeOfSupply ?? '—'}</TableCell>
                            <TableCell align="center">
                              <Chip
                                size="small"
                                label={inv.reverseCharge ? 'Yes' : 'No'}
                                color={inv.reverseCharge ? 'secondary' : 'default'}
                                sx={{ height: 20, fontSize: '0.7rem' }}
                              />
                            </TableCell>
                            <TableCell align="right" sx={{ fontFamily: 'monospace' }}>
                              {money(inv.totals.taxableValue)}
                            </TableCell>
                            <TableCell align="right" sx={{ fontFamily: 'monospace' }}>
                              {money(inv.totals.cgst)}
                            </TableCell>
                            <TableCell align="right" sx={{ fontFamily: 'monospace' }}>
                              {money(inv.totals.sgst)}
                            </TableCell>
                            <TableCell align="right" sx={{ fontFamily: 'monospace' }}>
                              {money(inv.totals.igst)}
                            </TableCell>
                            <TableCell align="right" sx={{ fontFamily: 'monospace' }}>
                              {money(inv.totals.cess)}
                            </TableCell>
                            <TableCell align="right" sx={{ fontFamily: 'monospace', fontWeight: 700 }}>
                              {money(inv.invoiceValue)}
                            </TableCell>
                          </TableRow>

                          {/* Line Item Breakdown */}
                          <TableRow>
                            <TableCell colSpan={12} sx={{ p: 0, borderBottom: isExpanded ? undefined : 'none' }}>
                              <Collapse in={isExpanded} timeout="auto" unmountOnExit>
                                <Box sx={{ py: 1.5, px: 4, bgcolor: '#FAFCFE' }}>
                                  <Typography variant="caption" fontWeight={700} color="text.secondary" sx={{ mb: 1, display: 'block' }}>
                                    Line Items & Tax Breakdown:
                                  </Typography>
                                  <Table size="small">
                                    <TableHead>
                                      <TableRow sx={{ bgcolor: '#EDF2F7' }}>
                                        <TableCell>HSN Code</TableCell>
                                        <TableCell>GST Rate</TableCell>
                                        <TableCell>UQC</TableCell>
                                        <TableCell align="right">Quantity</TableCell>
                                        <TableCell align="right">Taxable Value</TableCell>
                                        <TableCell align="right">CGST</TableCell>
                                        <TableCell align="right">SGST</TableCell>
                                        <TableCell align="right">IGST</TableCell>
                                        <TableCell align="right">Cess</TableCell>
                                      </TableRow>
                                    </TableHead>
                                    <TableBody>
                                      {inv.lines.map((ln, idx) => (
                                        <TableRow key={idx}>
                                          <TableCell sx={{ fontFamily: 'monospace' }}>{ln.hsnCode ?? '—'}</TableCell>
                                          <TableCell>{formatRate(ln.gstRate)}</TableCell>
                                          <TableCell>{ln.uqc ?? '—'}</TableCell>
                                          <TableCell align="right" sx={{ fontFamily: 'monospace' }}>{formatQty(ln.quantity)}</TableCell>
                                          <TableCell align="right" sx={{ fontFamily: 'monospace' }}>{money(ln.taxableValue)}</TableCell>
                                          <TableCell align="right" sx={{ fontFamily: 'monospace' }}>{money(ln.cgst)}</TableCell>
                                          <TableCell align="right" sx={{ fontFamily: 'monospace' }}>{money(ln.sgst)}</TableCell>
                                          <TableCell align="right" sx={{ fontFamily: 'monospace' }}>{money(ln.igst)}</TableCell>
                                          <TableCell align="right" sx={{ fontFamily: 'monospace' }}>{money(ln.cess)}</TableCell>
                                        </TableRow>
                                      ))}
                                    </TableBody>
                                  </Table>
                                </Box>
                              </Collapse>
                            </TableCell>
                          </TableRow>
                        </React.Fragment>
                      );
                    })
                  )}
                </TableBody>
              </Table>
            </TableContainer>
          </Card>
        </Box>
      )}

      {/* ─────────────────────────────────────────────────────────────────────────
          TAB 1: TABLE 5 — B2CL
          ───────────────────────────────────────────────────────────────────────── */}
      {activeTab === 1 && (
        <Box>
          {/* Table 5 Summary Bar */}
          <Card sx={{ p: 2, mb: 2, bgcolor: '#F8FAFC' }}>
            <Typography variant="subtitle2" color="text.secondary" fontWeight={700} sx={{ mb: 1 }}>
              Table 5 B2CL Summary (Large Inter-State Unregistered Invoices)
            </Typography>
            <Grid container spacing={2}>
              <Grid item xs={6} sm={3} md={2.4}>
                <Typography variant="caption" color="text.secondary">Invoices</Typography>
                <Typography variant="body1" fontWeight={700} sx={{ fontFamily: 'monospace' }}>
                  {outwardData?.totals?.b2cl?.invoiceCount ?? 0}
                </Typography>
              </Grid>
              <Grid item xs={6} sm={3} md={2.4}>
                <Typography variant="caption" color="text.secondary">Taxable Value</Typography>
                <Typography variant="body1" fontWeight={700} sx={{ fontFamily: 'monospace' }}>
                  {money(outwardData?.totals?.b2cl?.taxableValue)}
                </Typography>
              </Grid>
              <Grid item xs={6} sm={3} md={2.4}>
                <Typography variant="caption" color="text.secondary">IGST</Typography>
                <Typography variant="body1" fontWeight={700} sx={{ fontFamily: 'monospace' }}>
                  {money(outwardData?.totals?.b2cl?.igst)}
                </Typography>
              </Grid>
              <Grid item xs={6} sm={3} md={2.4}>
                <Typography variant="caption" color="text.secondary">Cess</Typography>
                <Typography variant="body1" fontWeight={700} sx={{ fontFamily: 'monospace' }}>
                  {money(outwardData?.totals?.b2cl?.cess)}
                </Typography>
              </Grid>
              <Grid item xs={6} sm={3} md={2.4}>
                <Typography variant="caption" color="text.secondary">Total Invoice Value</Typography>
                <Typography variant="body1" fontWeight={700} color="primary" sx={{ fontFamily: 'monospace' }}>
                  {money(outwardData?.totals?.b2cl?.invoiceValue)}
                </Typography>
              </Grid>
            </Grid>
          </Card>

          {/* Table 5 Table */}
          <Card>
            <TableContainer>
              <Table size="small">
                <TableHead sx={{ bgcolor: '#F1F5F9' }}>
                  <TableRow>
                    <TableCell sx={{ width: 48 }} />
                    <TableCell>Invoice No.</TableCell>
                    <TableCell>Invoice Date</TableCell>
                    <TableCell>Place of Supply</TableCell>
                    <TableCell align="right">Threshold</TableCell>
                    <TableCell align="right">Taxable Value</TableCell>
                    <TableCell align="right">IGST</TableCell>
                    <TableCell align="right">Cess</TableCell>
                    <TableCell align="right">Invoice Value</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {isCurrentTabLoading ? (
                    <TableRow>
                      <TableCell colSpan={9} align="center" sx={{ py: 6 }}>
                        <CircularProgress size={32} sx={{ mb: 1 }} />
                        <Typography variant="body2" color="text.secondary">Loading Table 5 B2CL data...</Typography>
                      </TableCell>
                    </TableRow>
                  ) : filteredB2cl.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={9} align="center" sx={{ py: 6 }}>
                        <Typography variant="body2" color="text.secondary">
                          No records found for the selected period.
                        </Typography>
                      </TableCell>
                    </TableRow>
                  ) : (
                    filteredB2cl.map((inv) => {
                      const isExpanded = !!expandedRows[`b2cl-${inv.invoiceId}`];
                      return (
                        <React.Fragment key={inv.invoiceId}>
                          <TableRow hover sx={{ '&:hover': { bgcolor: '#F8FAFC' } }}>
                            <TableCell>
                              <IconButton
                                size="small"
                                onClick={() => toggleRow(`b2cl-${inv.invoiceId}`)}
                                title={isExpanded ? 'Collapse line details' : 'Expand line details'}
                              >
                                {isExpanded ? <KeyboardArrowUp fontSize="small" /> : <KeyboardArrowDown fontSize="small" />}
                              </IconButton>
                            </TableCell>
                            <TableCell sx={{ fontWeight: 600 }}>{inv.invoiceNumber}</TableCell>
                            <TableCell>{formatLocalDateStr(inv.invoiceDate)}</TableCell>
                            <TableCell>{inv.placeOfSupply}</TableCell>
                            <TableCell align="right" sx={{ fontFamily: 'monospace' }}>
                              {money(inv.threshold)}
                            </TableCell>
                            <TableCell align="right" sx={{ fontFamily: 'monospace' }}>
                              {money(inv.totals.taxableValue)}
                            </TableCell>
                            <TableCell align="right" sx={{ fontFamily: 'monospace' }}>
                              {money(inv.totals.igst)}
                            </TableCell>
                            <TableCell align="right" sx={{ fontFamily: 'monospace' }}>
                              {money(inv.totals.cess)}
                            </TableCell>
                            <TableCell align="right" sx={{ fontFamily: 'monospace', fontWeight: 700 }}>
                              {money(inv.invoiceValue)}
                            </TableCell>
                          </TableRow>

                          {/* Line items collapse */}
                          <TableRow>
                            <TableCell colSpan={9} sx={{ p: 0, borderBottom: isExpanded ? undefined : 'none' }}>
                              <Collapse in={isExpanded} timeout="auto" unmountOnExit>
                                <Box sx={{ py: 1.5, px: 4, bgcolor: '#FAFCFE' }}>
                                  <Typography variant="caption" fontWeight={700} color="text.secondary" sx={{ mb: 1, display: 'block' }}>
                                    Line Items Breakdown:
                                  </Typography>
                                  <Table size="small">
                                    <TableHead>
                                      <TableRow sx={{ bgcolor: '#EDF2F7' }}>
                                        <TableCell>HSN Code</TableCell>
                                        <TableCell>GST Rate</TableCell>
                                        <TableCell>UQC</TableCell>
                                        <TableCell align="right">Quantity</TableCell>
                                        <TableCell align="right">Taxable Value</TableCell>
                                        <TableCell align="right">IGST</TableCell>
                                        <TableCell align="right">Cess</TableCell>
                                      </TableRow>
                                    </TableHead>
                                    <TableBody>
                                      {inv.lines.map((ln, idx) => (
                                        <TableRow key={idx}>
                                          <TableCell sx={{ fontFamily: 'monospace' }}>{ln.hsnCode ?? '—'}</TableCell>
                                          <TableCell>{formatRate(ln.gstRate)}</TableCell>
                                          <TableCell>{ln.uqc ?? '—'}</TableCell>
                                          <TableCell align="right" sx={{ fontFamily: 'monospace' }}>{formatQty(ln.quantity)}</TableCell>
                                          <TableCell align="right" sx={{ fontFamily: 'monospace' }}>{money(ln.taxableValue)}</TableCell>
                                          <TableCell align="right" sx={{ fontFamily: 'monospace' }}>{money(ln.igst)}</TableCell>
                                          <TableCell align="right" sx={{ fontFamily: 'monospace' }}>{money(ln.cess)}</TableCell>
                                        </TableRow>
                                      ))}
                                    </TableBody>
                                  </Table>
                                </Box>
                              </Collapse>
                            </TableCell>
                          </TableRow>
                        </React.Fragment>
                      );
                    })
                  )}
                </TableBody>
              </Table>
            </TableContainer>
          </Card>
        </Box>
      )}

      {/* ─────────────────────────────────────────────────────────────────────────
          TAB 2: TABLE 7 — B2CS (CRITICAL REQUIREMENT)
          Gross - Credit Note Reduction = Net
          ───────────────────────────────────────────────────────────────────────── */}
      {activeTab === 2 && (
        <Box>
          {/* Table 7 Diagnostics Alert */}
          {b2csSummaryTotals.negativeBucketCount > 0 && (
            <Alert severity="error" icon={<ErrorOutline />} sx={{ mb: 2 }}>
              <Typography variant="subtitle2" fontWeight={700}>
                ⚠ Filing not eligible
              </Typography>
              <Typography variant="body2">
                Negative net B2CS bucket detected ({b2csSummaryTotals.negativeBucketCount} bucket went negative after netting eligible Credit Notes).
                The negative net value is retained and displayed exactly as computed per statutory rules (never clamped to zero or hidden).
              </Typography>
            </Alert>
          )}

          {outwardData?.b2csCreditNoteDiagnostics && outwardData.b2csCreditNoteDiagnostics.length > 0 && (
            <Accordion sx={{ mb: 2, border: '1px solid #FED7AA', bgcolor: '#FFFBEB' }}>
              <AccordionSummary expandIcon={<ExpandMore />}>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                  <WarningAmber color="warning" />
                  <Typography variant="subtitle2" fontWeight={700}>
                    B2CS Net-off Diagnostics ({outwardData.b2csCreditNoteDiagnostics.length})
                  </Typography>
                </Box>
              </AccordionSummary>
              <AccordionDetails>
                <Table size="small">
                  <TableHead>
                    <TableRow>
                      <TableCell>Diagnostic Reason</TableCell>
                      <TableCell>Credit Note No.</TableCell>
                      <TableCell>Place of Supply</TableCell>
                      <TableCell>Rate</TableCell>
                      <TableCell>Details</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {outwardData.b2csCreditNoteDiagnostics.map((d, i) => (
                      <TableRow key={i}>
                        <TableCell>
                          <Chip
                            size="small"
                            label={d.reason}
                            color={d.reason === 'NEGATIVE_NET_B2CS_BUCKET' ? 'error' : 'warning'}
                            sx={{ height: 20, fontSize: '0.7rem' }}
                          />
                        </TableCell>
                        <TableCell sx={{ fontFamily: 'monospace' }}>{d.creditNoteNumber ?? d.creditNoteId ?? '—'}</TableCell>
                        <TableCell>{d.placeOfSupply ?? '—'}</TableCell>
                        <TableCell>{d.gstRate !== undefined ? formatRate(d.gstRate) : '—'}</TableCell>
                        <TableCell sx={{ fontSize: '0.85rem' }}>{d.detail}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </AccordionDetails>
            </Accordion>
          )}

          {/* CA / Accountant Friendly Summary Cards */}
          <Card sx={{ p: 2.5, mb: 3, bgcolor: '#F8FAFC', border: '1px solid #E2E8F0' }}>
            <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 2, flexWrap: 'wrap' }}>
              <Box>
                <Typography variant="h6" fontWeight={700}>
                  Table 7 B2CS Summary
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  Statutory Net-Off Rule: Gross Outward Supplies — Credit Note Reduction = Net Statutory B2CS
                </Typography>
              </Box>
              <Box sx={{ display: 'flex', gap: 1 }}>
                <Chip
                  size="small"
                  label={`Outward Lines: ${b2csSummaryTotals.totalGrossRecords}`}
                  variant="outlined"
                />
                <Chip
                  size="small"
                  label={`Credit Note Lines: ${b2csSummaryTotals.totalCnRecords}`}
                  variant="outlined"
                  color="secondary"
                />
              </Box>
            </Box>

            <Grid container spacing={2}>
              {/* Gross Taxable Value */}
              <Grid item xs={12} sm={4}>
                <Paper variant="outlined" sx={{ p: 2, bgcolor: '#FFFFFF', borderColor: '#CBD5E1' }}>
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 0.5 }}>
                    <TrendingUp fontSize="small" color="primary" />
                    <Typography variant="caption" fontWeight={700} color="text.secondary">
                      GROSS TAXABLE VALUE
                    </Typography>
                  </Box>
                  <Typography variant="h5" fontWeight={700} sx={{ fontFamily: 'monospace' }}>
                    {money(b2csSummaryTotals.grossTaxable)}
                  </Typography>
                  <Divider sx={{ my: 1 }} />
                  <Typography variant="caption" color="text.secondary">
                    CGST: {money(b2csSummaryTotals.grossCgst)} | SGST: {money(b2csSummaryTotals.grossSgst)} | IGST: {money(b2csSummaryTotals.grossIgst)}
                  </Typography>
                </Paper>
              </Grid>

              {/* Credit Note Reduction */}
              <Grid item xs={12} sm={4}>
                <Paper variant="outlined" sx={{ p: 2, bgcolor: '#FFF1F2', borderColor: '#FECDD3' }}>
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 0.5 }}>
                    <TrendingDown fontSize="small" color="error" />
                    <Typography variant="caption" fontWeight={700} color="error.dark">
                      LESS: CREDIT NOTE REDUCTION
                    </Typography>
                  </Box>
                  <Typography variant="h5" fontWeight={700} color="error.dark" sx={{ fontFamily: 'monospace' }}>
                    {money(b2csSummaryTotals.cnTaxableRed)}
                  </Typography>
                  <Divider sx={{ my: 1 }} />
                  <Typography variant="caption" color="error.dark">
                    CGST: {money(b2csSummaryTotals.cnCgstRed)} | SGST: {money(b2csSummaryTotals.cnSgstRed)} | IGST: {money(b2csSummaryTotals.cnIgstRed)}
                  </Typography>
                </Paper>
              </Grid>

              {/* Net Taxable Value */}
              <Grid item xs={12} sm={4}>
                <Paper
                  variant="outlined"
                  sx={{
                    p: 2,
                    bgcolor: b2csSummaryTotals.netTaxable < 0 ? '#FEF2F2' : '#F0FDF4',
                    borderColor: b2csSummaryTotals.netTaxable < 0 ? '#F87171' : '#BBF7D0',
                  }}
                >
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 0.5 }}>
                    <CheckCircleOutline fontSize="small" color={b2csSummaryTotals.netTaxable < 0 ? 'error' : 'success'} />
                    <Typography variant="caption" fontWeight={700} color={b2csSummaryTotals.netTaxable < 0 ? 'error.dark' : 'success.dark'}>
                      EQUALS: NET TAXABLE VALUE
                    </Typography>
                  </Box>
                  <Typography
                    variant="h5"
                    fontWeight={700}
                    color={b2csSummaryTotals.netTaxable < 0 ? 'error.main' : 'success.dark'}
                    sx={{ fontFamily: 'monospace' }}
                  >
                    {money(b2csSummaryTotals.netTaxable)}
                  </Typography>
                  <Divider sx={{ my: 1 }} />
                  <Typography variant="caption" color="text.secondary">
                    Net CGST: {money(b2csSummaryTotals.netCgst)} | Net SGST: {money(b2csSummaryTotals.netSgst)} | Net IGST: {money(b2csSummaryTotals.netIgst)}
                  </Typography>
                </Paper>
              </Grid>
            </Grid>
          </Card>

          {/* Table 7 Groups Table */}
          <Card>
            <TableContainer>
              <Table size="small">
                <TableHead sx={{ bgcolor: '#F1F5F9' }}>
                  <TableRow>
                    <TableCell sx={{ width: 44 }} />
                    <TableCell>Supply Type</TableCell>
                    <TableCell>Place of Supply</TableCell>
                    <TableCell align="right">Rate</TableCell>
                    <TableCell>HSN / UQC</TableCell>

                    {/* Taxable Value Group */}
                    <TableCell align="right" sx={{ bgcolor: '#E2E8F0', fontWeight: 700 }}>
                      Gross Taxable
                    </TableCell>
                    <TableCell align="right" sx={{ bgcolor: '#FFE4E6', color: 'error.dark', fontWeight: 700 }}>
                      CN Reduction
                    </TableCell>
                    <TableCell align="right" sx={{ bgcolor: '#DCFCE7', color: 'success.dark', fontWeight: 700 }}>
                      Net Taxable
                    </TableCell>

                    {/* Net Taxes */}
                    <TableCell align="right">Net IGST</TableCell>
                    <TableCell align="right">Net CGST</TableCell>
                    <TableCell align="right">Net SGST</TableCell>
                    <TableCell align="right">Net Cess</TableCell>
                    <TableCell align="center">Filing Status</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {isCurrentTabLoading ? (
                    <TableRow>
                      <TableCell colSpan={13} align="center" sx={{ py: 6 }}>
                        <CircularProgress size={32} sx={{ mb: 1 }} />
                        <Typography variant="body2" color="text.secondary">Loading Table 7 B2CS data...</Typography>
                      </TableCell>
                    </TableRow>
                  ) : filteredB2cs.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={13} align="center" sx={{ py: 6 }}>
                        <Typography variant="body2" color="text.secondary">
                          No records found for the selected period.
                        </Typography>
                      </TableCell>
                    </TableRow>
                  ) : (
                    filteredB2cs.map((grp, idx) => {
                      const rowKey = `b2cs-${idx}-${grp.placeOfSupply}-${grp.gstRate}`;
                      const isExpanded = !!expandedRows[rowKey];
                      const isNegative = grp.taxableValue < 0 || !grp.filingEligible;

                      return (
                        <React.Fragment key={rowKey}>
                          <TableRow
                            hover
                            sx={{
                              bgcolor: isNegative ? '#FEF2F2' : undefined,
                              '&:hover': { bgcolor: isNegative ? '#FEE2E2' : '#F8FAFC' },
                            }}
                          >
                            <TableCell>
                              <IconButton
                                size="small"
                                onClick={() => toggleRow(rowKey)}
                                title={isExpanded ? 'Collapse complete breakdown' : 'Expand complete Gross/Reduction/Net breakdown'}
                              >
                                {isExpanded ? <KeyboardArrowUp fontSize="small" /> : <KeyboardArrowDown fontSize="small" />}
                              </IconButton>
                            </TableCell>
                            <TableCell>
                              <Chip
                                size="small"
                                label={grp.isInterState ? 'Inter-State' : 'Intra-State'}
                                variant="outlined"
                                color={grp.isInterState ? 'primary' : 'default'}
                                sx={{ height: 20, fontSize: '0.7rem' }}
                              />
                            </TableCell>
                            <TableCell sx={{ fontWeight: 600 }}>{grp.placeOfSupply}</TableCell>
                            <TableCell align="right">{formatRate(grp.gstRate)}</TableCell>
                            <TableCell sx={{ fontFamily: 'monospace' }}>
                              {grp.hsnCode ?? '—'} {grp.uqc ? `(${grp.uqc})` : ''}
                            </TableCell>

                            {/* Gross Taxable Value */}
                            <TableCell align="right" sx={{ fontFamily: 'monospace', fontWeight: 600 }}>
                              {money(grp.grossTaxableValue)}
                            </TableCell>

                            {/* CN Reduction */}
                            <TableCell
                              align="right"
                              sx={{
                                fontFamily: 'monospace',
                                color: grp.creditNoteTaxableReduction > 0 ? 'error.main' : 'text.secondary',
                                fontWeight: grp.creditNoteTaxableReduction > 0 ? 600 : 400,
                              }}
                            >
                              {grp.creditNoteTaxableReduction > 0 ? `- ${money(grp.creditNoteTaxableReduction)}` : '₹0.00'}
                            </TableCell>

                            {/* Net Taxable Value */}
                            <TableCell
                              align="right"
                              sx={{
                                fontFamily: 'monospace',
                                fontWeight: 700,
                                color: grp.taxableValue < 0 ? 'error.main' : 'text.primary',
                              }}
                            >
                              {money(grp.taxableValue)}
                            </TableCell>

                            {/* Net Taxes */}
                            <TableCell align="right" sx={{ fontFamily: 'monospace' }}>{money(grp.igst)}</TableCell>
                            <TableCell align="right" sx={{ fontFamily: 'monospace' }}>{money(grp.cgst)}</TableCell>
                            <TableCell align="right" sx={{ fontFamily: 'monospace' }}>{money(grp.sgst)}</TableCell>
                            <TableCell align="right" sx={{ fontFamily: 'monospace' }}>{money(grp.cess)}</TableCell>

                            {/* Filing Status */}
                            <TableCell align="center">
                              {grp.filingEligible && grp.taxableValue >= 0 ? (
                                <Chip size="small" label="Eligible" color="success" sx={{ height: 20, fontSize: '0.7rem' }} />
                              ) : (
                                <Tooltip title="Negative net B2CS bucket detected. Filing not eligible until positive supplies balance out reductions.">
                                  <Chip
                                    size="small"
                                    icon={<ErrorOutline />}
                                    label="Ineligible"
                                    color="error"
                                    sx={{ height: 20, fontSize: '0.7rem' }}
                                  />
                                </Tooltip>
                              )}
                            </TableCell>
                          </TableRow>

                          {/* Complete Gross / Reduction / Net Matrix */}
                          <TableRow>
                            <TableCell colSpan={13} sx={{ p: 0, borderBottom: isExpanded ? undefined : 'none' }}>
                              <Collapse in={isExpanded} timeout="auto" unmountOnExit>
                                <Box sx={{ py: 2, px: 4, bgcolor: '#F8FAFC' }}>
                                  <Typography variant="subtitle2" fontWeight={700} sx={{ mb: 1.5 }}>
                                    Complete Statutory Gross vs. Reduction Matrix:
                                  </Typography>
                                  <Table size="small" sx={{ border: '1px solid #E2E8F0', bgcolor: '#FFFFFF' }}>
                                    <TableHead>
                                      <TableRow sx={{ bgcolor: '#F1F5F9' }}>
                                        <TableCell>Metric</TableCell>
                                        <TableCell align="right">Gross Outward Supplies</TableCell>
                                        <TableCell align="right" sx={{ color: 'error.main' }}>Less: Credit Note Reduction</TableCell>
                                        <TableCell align="right" sx={{ fontWeight: 700 }}>Equals: Net Statutory Value</TableCell>
                                      </TableRow>
                                    </TableHead>
                                    <TableBody>
                                      <TableRow>
                                        <TableCell sx={{ fontWeight: 600 }}>Taxable Value</TableCell>
                                        <TableCell align="right" sx={{ fontFamily: 'monospace' }}>{money(grp.grossTaxableValue)}</TableCell>
                                        <TableCell align="right" sx={{ fontFamily: 'monospace', color: 'error.main' }}>- {money(grp.creditNoteTaxableReduction)}</TableCell>
                                        <TableCell align="right" sx={{ fontFamily: 'monospace', fontWeight: 700 }}>{money(grp.taxableValue)}</TableCell>
                                      </TableRow>
                                      <TableRow>
                                        <TableCell sx={{ fontWeight: 600 }}>IGST</TableCell>
                                        <TableCell align="right" sx={{ fontFamily: 'monospace' }}>{money(grp.grossIgst)}</TableCell>
                                        <TableCell align="right" sx={{ fontFamily: 'monospace', color: 'error.main' }}>- {money(grp.creditNoteIgstReduction)}</TableCell>
                                        <TableCell align="right" sx={{ fontFamily: 'monospace', fontWeight: 700 }}>{money(grp.igst)}</TableCell>
                                      </TableRow>
                                      <TableRow>
                                        <TableCell sx={{ fontWeight: 600 }}>CGST</TableCell>
                                        <TableCell align="right" sx={{ fontFamily: 'monospace' }}>{money(grp.grossCgst)}</TableCell>
                                        <TableCell align="right" sx={{ fontFamily: 'monospace', color: 'error.main' }}>- {money(grp.creditNoteCgstReduction)}</TableCell>
                                        <TableCell align="right" sx={{ fontFamily: 'monospace', fontWeight: 700 }}>{money(grp.cgst)}</TableCell>
                                      </TableRow>
                                      <TableRow>
                                        <TableCell sx={{ fontWeight: 600 }}>SGST</TableCell>
                                        <TableCell align="right" sx={{ fontFamily: 'monospace' }}>{money(grp.grossSgst)}</TableCell>
                                        <TableCell align="right" sx={{ fontFamily: 'monospace', color: 'error.main' }}>- {money(grp.creditNoteSgstReduction)}</TableCell>
                                        <TableCell align="right" sx={{ fontFamily: 'monospace', fontWeight: 700 }}>{money(grp.sgst)}</TableCell>
                                      </TableRow>
                                      <TableRow>
                                        <TableCell sx={{ fontWeight: 600 }}>Cess</TableCell>
                                        <TableCell align="right" sx={{ fontFamily: 'monospace' }}>{money(grp.grossCess)}</TableCell>
                                        <TableCell align="right" sx={{ fontFamily: 'monospace', color: 'error.main' }}>- {money(grp.creditNoteCessReduction)}</TableCell>
                                        <TableCell align="right" sx={{ fontFamily: 'monospace', fontWeight: 700 }}>{money(grp.cess)}</TableCell>
                                      </TableRow>
                                      <TableRow>
                                        <TableCell sx={{ fontWeight: 600 }}>Quantity ({grp.uqc ?? 'Units'})</TableCell>
                                        <TableCell align="right" sx={{ fontFamily: 'monospace' }}>{formatQty(grp.grossQuantity)}</TableCell>
                                        <TableCell align="right" sx={{ fontFamily: 'monospace', color: 'error.main' }}>- {formatQty(grp.creditNoteQuantityReduction)}</TableCell>
                                        <TableCell align="right" sx={{ fontFamily: 'monospace', fontWeight: 700 }}>{formatQty(grp.quantity)}</TableCell>
                                      </TableRow>
                                      <TableRow sx={{ bgcolor: '#F8FAFC' }}>
                                        <TableCell sx={{ fontWeight: 600 }}>Record Count</TableCell>
                                        <TableCell align="right">{grp.recordCount} invoice lines</TableCell>
                                        <TableCell align="right" sx={{ color: 'error.main' }}>{grp.creditNoteRecordCount} credit note lines</TableCell>
                                        <TableCell align="right" sx={{ fontWeight: 700 }}>{grp.recordCount + grp.creditNoteRecordCount} total lines</TableCell>
                                      </TableRow>
                                    </TableBody>
                                  </Table>
                                </Box>
                              </Collapse>
                            </TableCell>
                          </TableRow>
                        </React.Fragment>
                      );
                    })
                  )}
                </TableBody>
              </Table>
            </TableContainer>
          </Card>
        </Box>
      )}

      {/* ─────────────────────────────────────────────────────────────────────────
          TAB 3: TABLE 9B — CREDIT / DEBIT NOTES (CDNR / CDNUR)
          CRITICAL: ABSOLUTELY NO CDNUR B2CS!
          ───────────────────────────────────────────────────────────────────────── */}
      {activeTab === 3 && (
        <Box>
          {/* Table 9B Sub-navigation */}
          <Box sx={{ borderBottom: 1, borderColor: 'divider', mb: 2 }}>
            <Tabs
              value={table9bSubTab}
              onChange={(_, val) => setTable9bSubTab(val)}
              textColor="primary"
              indicatorColor="primary"
            >
              <Tab
                label={
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                    <span>CDNR — Registered Recipients</span>
                    <Chip
                      size="small"
                      label={creditNotesData?.cdnr?.documents?.length || 0}
                      sx={{ height: 20, fontSize: '0.75rem' }}
                    />
                  </Box>
                }
              />
              <Tab
                label={
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                    <span>CDNUR — B2CL</span>
                    <Chip
                      size="small"
                      label={creditNotesData?.cdnur?.b2cl?.documents?.length || 0}
                      sx={{ height: 20, fontSize: '0.75rem' }}
                    />
                  </Box>
                }
              />
              <Tab
                label={
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                    <span>CDNUR — Export</span>
                    <Chip
                      size="small"
                      label={creditNotesData?.cdnur?.export?.documents?.length || 0}
                      sx={{ height: 20, fontSize: '0.75rem' }}
                    />
                  </Box>
                }
              />
            </Tabs>
          </Box>

          {/* Sub-tab 0: CDNR */}
          {table9bSubTab === 0 && (
            <Box>
              {/* CDNR Summary Card */}
              <Card sx={{ p: 2, mb: 2, bgcolor: '#F8FAFC' }}>
                <Typography variant="subtitle2" color="text.secondary" fontWeight={700} sx={{ mb: 1 }}>
                  CDNR Summary (Registered Credit / Debit Notes)
                </Typography>
                <Grid container spacing={2}>
                  <Grid item xs={6} sm={4} md={2}>
                    <Typography variant="caption" color="text.secondary">Documents</Typography>
                    <Typography variant="body1" fontWeight={700} sx={{ fontFamily: 'monospace' }}>
                      {creditNotesData?.cdnr?.summary?.documentCount ?? 0}
                    </Typography>
                  </Grid>
                  <Grid item xs={6} sm={4} md={2}>
                    <Typography variant="caption" color="text.secondary">Taxable Value</Typography>
                    <Typography variant="body1" fontWeight={700} sx={{ fontFamily: 'monospace' }}>
                      {money(creditNotesData?.cdnr?.summary?.taxableValue)}
                    </Typography>
                  </Grid>
                  <Grid item xs={6} sm={4} md={2}>
                    <Typography variant="caption" color="text.secondary">CGST</Typography>
                    <Typography variant="body1" fontWeight={700} sx={{ fontFamily: 'monospace' }}>
                      {money(creditNotesData?.cdnr?.summary?.cgst)}
                    </Typography>
                  </Grid>
                  <Grid item xs={6} sm={4} md={2}>
                    <Typography variant="caption" color="text.secondary">SGST</Typography>
                    <Typography variant="body1" fontWeight={700} sx={{ fontFamily: 'monospace' }}>
                      {money(creditNotesData?.cdnr?.summary?.sgst)}
                    </Typography>
                  </Grid>
                  <Grid item xs={6} sm={4} md={2}>
                    <Typography variant="caption" color="text.secondary">IGST</Typography>
                    <Typography variant="body1" fontWeight={700} sx={{ fontFamily: 'monospace' }}>
                      {money(creditNotesData?.cdnr?.summary?.igst)}
                    </Typography>
                  </Grid>
                  <Grid item xs={6} sm={4} md={2}>
                    <Typography variant="caption" color="text.secondary">Total Note Value</Typography>
                    <Typography variant="body1" fontWeight={700} color="primary" sx={{ fontFamily: 'monospace' }}>
                      {money(creditNotesData?.cdnr?.summary?.noteValue)}
                    </Typography>
                  </Grid>
                </Grid>
              </Card>

              {/* CDNR Table */}
              <Card>
                <TableContainer>
                  <Table size="small">
                    <TableHead sx={{ bgcolor: '#F1F5F9' }}>
                      <TableRow>
                        <TableCell sx={{ width: 44 }} />
                        <TableCell>Recipient GSTIN</TableCell>
                        <TableCell>Note No.</TableCell>
                        <TableCell>Note Date</TableCell>
                        <TableCell>Orig. Inv. No.</TableCell>
                        <TableCell>Orig. Inv. Date</TableCell>
                        <TableCell>Place of Supply</TableCell>
                        <TableCell align="right">Taxable Value</TableCell>
                        <TableCell align="right">CGST</TableCell>
                        <TableCell align="right">SGST</TableCell>
                        <TableCell align="right">IGST</TableCell>
                        <TableCell align="right">Cess</TableCell>
                        <TableCell align="right">Note Value</TableCell>
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {isCurrentTabLoading ? (
                        <TableRow>
                          <TableCell colSpan={13} align="center" sx={{ py: 6 }}>
                            <CircularProgress size={32} sx={{ mb: 1 }} />
                            <Typography variant="body2" color="text.secondary">Loading CDNR data...</Typography>
                          </TableCell>
                        </TableRow>
                      ) : cdnrDocuments.length === 0 ? (
                        <TableRow>
                          <TableCell colSpan={13} align="center" sx={{ py: 6 }}>
                            <Typography variant="body2" color="text.secondary">
                              No CDNR records found for the selected period.
                            </Typography>
                          </TableCell>
                        </TableRow>
                      ) : (
                        cdnrDocuments.map((doc) => {
                          const rowKey = `cdnr-${doc.creditNoteId}`;
                          const isExpanded = !!expandedRows[rowKey];
                          return (
                            <React.Fragment key={doc.creditNoteId}>
                              <TableRow hover>
                                <TableCell>
                                  <IconButton size="small" onClick={() => toggleRow(rowKey)}>
                                    {isExpanded ? <KeyboardArrowUp fontSize="small" /> : <KeyboardArrowDown fontSize="small" />}
                                  </IconButton>
                                </TableCell>
                                <TableCell sx={{ fontFamily: 'monospace', fontWeight: 700 }}>
                                  {doc.buyerGstin ?? '—'}
                                </TableCell>
                                <TableCell sx={{ fontWeight: 600 }}>{doc.creditNoteNumber}</TableCell>
                                <TableCell>{formatLocalDateStr(doc.creditNoteDate)}</TableCell>
                                <TableCell>{doc.originalInvoiceNumber}</TableCell>
                                <TableCell>{formatLocalDateStr(doc.originalInvoiceDate)}</TableCell>
                                <TableCell>{doc.placeOfSupply ?? '—'}</TableCell>
                                <TableCell align="right" sx={{ fontFamily: 'monospace' }}>{money(doc.taxableValue)}</TableCell>
                                <TableCell align="right" sx={{ fontFamily: 'monospace' }}>{money(doc.cgst)}</TableCell>
                                <TableCell align="right" sx={{ fontFamily: 'monospace' }}>{money(doc.sgst)}</TableCell>
                                <TableCell align="right" sx={{ fontFamily: 'monospace' }}>{money(doc.igst)}</TableCell>
                                <TableCell align="right" sx={{ fontFamily: 'monospace' }}>{money(doc.cess)}</TableCell>
                                <TableCell align="right" sx={{ fontFamily: 'monospace', fontWeight: 700 }}>
                                  {money(doc.noteValue)}
                                </TableCell>
                              </TableRow>

                              {/* Rate breakdown */}
                              <TableRow>
                                <TableCell colSpan={13} sx={{ p: 0, borderBottom: isExpanded ? undefined : 'none' }}>
                                  <Collapse in={isExpanded} timeout="auto" unmountOnExit>
                                    <Box sx={{ py: 1.5, px: 4, bgcolor: '#FAFCFE' }}>
                                      <Typography variant="caption" fontWeight={700} color="text.secondary" sx={{ mb: 1, display: 'block' }}>
                                        Rate Breakdown ({doc.reasonCode ? `Reason: ${doc.reasonCode} ${doc.reasonNotes ? `— ${doc.reasonNotes}` : ''}` : ''}):
                                      </Typography>
                                      <Table size="small">
                                        <TableHead>
                                          <TableRow sx={{ bgcolor: '#EDF2F7' }}>
                                            <TableCell>Rate</TableCell>
                                            <TableCell>HSN Code</TableCell>
                                            <TableCell>UQC</TableCell>
                                            <TableCell align="right">Quantity</TableCell>
                                            <TableCell align="right">Taxable Value</TableCell>
                                            <TableCell align="right">CGST</TableCell>
                                            <TableCell align="right">SGST</TableCell>
                                            <TableCell align="right">IGST</TableCell>
                                            <TableCell align="right">Cess</TableCell>
                                          </TableRow>
                                        </TableHead>
                                        <TableBody>
                                          {doc.rateBreakdown?.map((rb, idx) => (
                                            <TableRow key={idx}>
                                              <TableCell>{formatRate(rb.rate)}</TableCell>
                                              <TableCell sx={{ fontFamily: 'monospace' }}>{rb.hsnCode ?? '—'}</TableCell>
                                              <TableCell>{rb.uqc ?? '—'}</TableCell>
                                              <TableCell align="right" sx={{ fontFamily: 'monospace' }}>{formatQty(rb.quantity)}</TableCell>
                                              <TableCell align="right" sx={{ fontFamily: 'monospace' }}>{money(rb.taxableValue)}</TableCell>
                                              <TableCell align="right" sx={{ fontFamily: 'monospace' }}>{money(rb.cgst)}</TableCell>
                                              <TableCell align="right" sx={{ fontFamily: 'monospace' }}>{money(rb.sgst)}</TableCell>
                                              <TableCell align="right" sx={{ fontFamily: 'monospace' }}>{money(rb.igst)}</TableCell>
                                              <TableCell align="right" sx={{ fontFamily: 'monospace' }}>{money(rb.cess)}</TableCell>
                                            </TableRow>
                                          ))}
                                        </TableBody>
                                      </Table>
                                    </Box>
                                  </Collapse>
                                </TableCell>
                              </TableRow>
                            </React.Fragment>
                          );
                        })
                      )}
                    </TableBody>
                  </Table>
                </TableContainer>
              </Card>
            </Box>
          )}

          {/* Sub-tab 1: CDNUR — B2CL */}
          {table9bSubTab === 1 && (
            <Box>
              {/* CDNUR B2CL Summary Card */}
              <Card sx={{ p: 2, mb: 2, bgcolor: '#F8FAFC' }}>
                <Typography variant="subtitle2" color="text.secondary" fontWeight={700} sx={{ mb: 1 }}>
                  CDNUR — B2CL Summary (Unregistered Large Credit Notes)
                </Typography>
                <Grid container spacing={2}>
                  <Grid item xs={6} sm={3} md={2.4}>
                    <Typography variant="caption" color="text.secondary">Documents</Typography>
                    <Typography variant="body1" fontWeight={700} sx={{ fontFamily: 'monospace' }}>
                      {creditNotesData?.cdnur?.b2cl?.summary?.documentCount ?? 0}
                    </Typography>
                  </Grid>
                  <Grid item xs={6} sm={3} md={2.4}>
                    <Typography variant="caption" color="text.secondary">Taxable Value</Typography>
                    <Typography variant="body1" fontWeight={700} sx={{ fontFamily: 'monospace' }}>
                      {money(creditNotesData?.cdnur?.b2cl?.summary?.taxableValue)}
                    </Typography>
                  </Grid>
                  <Grid item xs={6} sm={3} md={2.4}>
                    <Typography variant="caption" color="text.secondary">IGST</Typography>
                    <Typography variant="body1" fontWeight={700} sx={{ fontFamily: 'monospace' }}>
                      {money(creditNotesData?.cdnur?.b2cl?.summary?.igst)}
                    </Typography>
                  </Grid>
                  <Grid item xs={6} sm={3} md={2.4}>
                    <Typography variant="caption" color="text.secondary">Cess</Typography>
                    <Typography variant="body1" fontWeight={700} sx={{ fontFamily: 'monospace' }}>
                      {money(creditNotesData?.cdnur?.b2cl?.summary?.cess)}
                    </Typography>
                  </Grid>
                  <Grid item xs={6} sm={3} md={2.4}>
                    <Typography variant="caption" color="text.secondary">Total Note Value</Typography>
                    <Typography variant="body1" fontWeight={700} color="primary" sx={{ fontFamily: 'monospace' }}>
                      {money(creditNotesData?.cdnur?.b2cl?.summary?.noteValue)}
                    </Typography>
                  </Grid>
                </Grid>
              </Card>

              {/* CDNUR B2CL Table */}
              <Card>
                <TableContainer>
                  <Table size="small">
                    <TableHead sx={{ bgcolor: '#F1F5F9' }}>
                      <TableRow>
                        <TableCell sx={{ width: 44 }} />
                        <TableCell>Note No.</TableCell>
                        <TableCell>Note Date</TableCell>
                        <TableCell>Orig. Inv. No.</TableCell>
                        <TableCell>Orig. Inv. Date</TableCell>
                        <TableCell>Place of Supply</TableCell>
                        <TableCell align="right">Taxable Value</TableCell>
                        <TableCell align="right">IGST</TableCell>
                        <TableCell align="right">Cess</TableCell>
                        <TableCell align="right">Note Value</TableCell>
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {isCurrentTabLoading ? (
                        <TableRow>
                          <TableCell colSpan={10} align="center" sx={{ py: 6 }}>
                            <CircularProgress size={32} sx={{ mb: 1 }} />
                            <Typography variant="body2" color="text.secondary">Loading CDNUR B2CL data...</Typography>
                          </TableCell>
                        </TableRow>
                      ) : cdnurB2clDocuments.length === 0 ? (
                        <TableRow>
                          <TableCell colSpan={10} align="center" sx={{ py: 6 }}>
                            <Typography variant="body2" color="text.secondary">
                              No CDNUR B2CL records found for the selected period.
                            </Typography>
                          </TableCell>
                        </TableRow>
                      ) : (
                        cdnurB2clDocuments.map((doc) => {
                          const rowKey = `cdnur-b2cl-${doc.creditNoteId}`;
                          const isExpanded = !!expandedRows[rowKey];
                          return (
                            <React.Fragment key={doc.creditNoteId}>
                              <TableRow hover>
                                <TableCell>
                                  <IconButton size="small" onClick={() => toggleRow(rowKey)}>
                                    {isExpanded ? <KeyboardArrowUp fontSize="small" /> : <KeyboardArrowDown fontSize="small" />}
                                  </IconButton>
                                </TableCell>
                                <TableCell sx={{ fontWeight: 600 }}>{doc.creditNoteNumber}</TableCell>
                                <TableCell>{formatLocalDateStr(doc.creditNoteDate)}</TableCell>
                                <TableCell>{doc.originalInvoiceNumber}</TableCell>
                                <TableCell>{formatLocalDateStr(doc.originalInvoiceDate)}</TableCell>
                                <TableCell>{doc.placeOfSupply ?? '—'}</TableCell>
                                <TableCell align="right" sx={{ fontFamily: 'monospace' }}>{money(doc.taxableValue)}</TableCell>
                                <TableCell align="right" sx={{ fontFamily: 'monospace' }}>{money(doc.igst)}</TableCell>
                                <TableCell align="right" sx={{ fontFamily: 'monospace' }}>{money(doc.cess)}</TableCell>
                                <TableCell align="right" sx={{ fontFamily: 'monospace', fontWeight: 700 }}>
                                  {money(doc.noteValue)}
                                </TableCell>
                              </TableRow>

                              {/* Rate breakdown */}
                              <TableRow>
                                <TableCell colSpan={10} sx={{ p: 0, borderBottom: isExpanded ? undefined : 'none' }}>
                                  <Collapse in={isExpanded} timeout="auto" unmountOnExit>
                                    <Box sx={{ py: 1.5, px: 4, bgcolor: '#FAFCFE' }}>
                                      <Typography variant="caption" fontWeight={700} color="text.secondary" sx={{ mb: 1, display: 'block' }}>
                                        Rate Breakdown ({doc.reasonCode ? `Reason: ${doc.reasonCode}` : ''}):
                                      </Typography>
                                      <Table size="small">
                                        <TableHead>
                                          <TableRow sx={{ bgcolor: '#EDF2F7' }}>
                                            <TableCell>Rate</TableCell>
                                            <TableCell>HSN Code</TableCell>
                                            <TableCell>UQC</TableCell>
                                            <TableCell align="right">Quantity</TableCell>
                                            <TableCell align="right">Taxable Value</TableCell>
                                            <TableCell align="right">IGST</TableCell>
                                            <TableCell align="right">Cess</TableCell>
                                          </TableRow>
                                        </TableHead>
                                        <TableBody>
                                          {doc.rateBreakdown?.map((rb, idx) => (
                                            <TableRow key={idx}>
                                              <TableCell>{formatRate(rb.rate)}</TableCell>
                                              <TableCell sx={{ fontFamily: 'monospace' }}>{rb.hsnCode ?? '—'}</TableCell>
                                              <TableCell>{rb.uqc ?? '—'}</TableCell>
                                              <TableCell align="right" sx={{ fontFamily: 'monospace' }}>{formatQty(rb.quantity)}</TableCell>
                                              <TableCell align="right" sx={{ fontFamily: 'monospace' }}>{money(rb.taxableValue)}</TableCell>
                                              <TableCell align="right" sx={{ fontFamily: 'monospace' }}>{money(rb.igst)}</TableCell>
                                              <TableCell align="right" sx={{ fontFamily: 'monospace' }}>{money(rb.cess)}</TableCell>
                                            </TableRow>
                                          ))}
                                        </TableBody>
                                      </Table>
                                    </Box>
                                  </Collapse>
                                </TableCell>
                              </TableRow>
                            </React.Fragment>
                          );
                        })
                      )}
                    </TableBody>
                  </Table>
                </TableContainer>
              </Card>
            </Box>
          )}

          {/* Sub-tab 2: CDNUR — Export */}
          {table9bSubTab === 2 && (
            <Box>
              {/* CDNUR Export Summary Card */}
              <Card sx={{ p: 2, mb: 2, bgcolor: '#F8FAFC' }}>
                <Typography variant="subtitle2" color="text.secondary" fontWeight={700} sx={{ mb: 1 }}>
                  CDNUR — Export Summary (Export Credit Notes)
                </Typography>
                <Grid container spacing={2}>
                  <Grid item xs={6} sm={3} md={2.4}>
                    <Typography variant="caption" color="text.secondary">Documents</Typography>
                    <Typography variant="body1" fontWeight={700} sx={{ fontFamily: 'monospace' }}>
                      {creditNotesData?.cdnur?.export?.summary?.documentCount ?? 0}
                    </Typography>
                  </Grid>
                  <Grid item xs={6} sm={3} md={2.4}>
                    <Typography variant="caption" color="text.secondary">Taxable Value</Typography>
                    <Typography variant="body1" fontWeight={700} sx={{ fontFamily: 'monospace' }}>
                      {money(creditNotesData?.cdnur?.export?.summary?.taxableValue)}
                    </Typography>
                  </Grid>
                  <Grid item xs={6} sm={3} md={2.4}>
                    <Typography variant="caption" color="text.secondary">IGST</Typography>
                    <Typography variant="body1" fontWeight={700} sx={{ fontFamily: 'monospace' }}>
                      {money(creditNotesData?.cdnur?.export?.summary?.igst)}
                    </Typography>
                  </Grid>
                  <Grid item xs={6} sm={3} md={2.4}>
                    <Typography variant="caption" color="text.secondary">Cess</Typography>
                    <Typography variant="body1" fontWeight={700} sx={{ fontFamily: 'monospace' }}>
                      {money(creditNotesData?.cdnur?.export?.summary?.cess)}
                    </Typography>
                  </Grid>
                  <Grid item xs={6} sm={3} md={2.4}>
                    <Typography variant="caption" color="text.secondary">Total Note Value</Typography>
                    <Typography variant="body1" fontWeight={700} color="primary" sx={{ fontFamily: 'monospace' }}>
                      {money(creditNotesData?.cdnur?.export?.summary?.noteValue)}
                    </Typography>
                  </Grid>
                </Grid>
              </Card>

              {/* CDNUR Export Table */}
              <Card>
                <TableContainer>
                  <Table size="small">
                    <TableHead sx={{ bgcolor: '#F1F5F9' }}>
                      <TableRow>
                        <TableCell sx={{ width: 44 }} />
                        <TableCell>Note No.</TableCell>
                        <TableCell>Note Date</TableCell>
                        <TableCell>Orig. Inv. No.</TableCell>
                        <TableCell>Orig. Inv. Date</TableCell>
                        <TableCell>Place of Supply</TableCell>
                        <TableCell align="right">Taxable Value</TableCell>
                        <TableCell align="right">IGST</TableCell>
                        <TableCell align="right">Cess</TableCell>
                        <TableCell align="right">Note Value</TableCell>
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {cdnurExportDocuments.length === 0 ? (
                        <TableRow>
                          <TableCell colSpan={10} align="center" sx={{ py: 6 }}>
                            <Typography variant="body2" color="text.secondary">
                              No export credit notes found for this period.
                            </Typography>
                          </TableCell>
                        </TableRow>
                      ) : (
                        cdnurExportDocuments.map((doc) => (
                          <TableRow key={doc.creditNoteId} hover>
                            <TableCell />
                            <TableCell sx={{ fontWeight: 600 }}>{doc.creditNoteNumber}</TableCell>
                            <TableCell>{formatLocalDateStr(doc.creditNoteDate)}</TableCell>
                            <TableCell>{doc.originalInvoiceNumber}</TableCell>
                            <TableCell>{formatLocalDateStr(doc.originalInvoiceDate)}</TableCell>
                            <TableCell>{doc.placeOfSupply ?? '—'}</TableCell>
                            <TableCell align="right" sx={{ fontFamily: 'monospace' }}>{money(doc.taxableValue)}</TableCell>
                            <TableCell align="right" sx={{ fontFamily: 'monospace' }}>{money(doc.igst)}</TableCell>
                            <TableCell align="right" sx={{ fontFamily: 'monospace' }}>{money(doc.cess)}</TableCell>
                            <TableCell align="right" sx={{ fontFamily: 'monospace', fontWeight: 700 }}>
                              {money(doc.noteValue)}
                            </TableCell>
                          </TableRow>
                        ))
                      )}
                    </TableBody>
                  </Table>
                </TableContainer>
              </Card>
            </Box>
          )}

          {/* Credit Notes Excluded & Diagnostics Accordion */}
          {((creditNotesData?.diagnostics && creditNotesData.diagnostics.length > 0) ||
            (creditNotesData?.excluded && creditNotesData.excluded.length > 0)) && (
            <Accordion sx={{ mt: 3, border: '1px solid #E2E8F0' }}>
              <AccordionSummary expandIcon={<ExpandMore />}>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                  <InfoOutlined color="info" />
                  <Typography variant="subtitle2" fontWeight={700}>
                    Credit Note Diagnostics & Excluded Records ({
                      (creditNotesData?.diagnostics?.length || 0) + (creditNotesData?.excluded?.length || 0)
                    })
                  </Typography>
                </Box>
              </AccordionSummary>
              <AccordionDetails>
                {creditNotesData?.diagnostics && creditNotesData.diagnostics.length > 0 && (
                  <Box sx={{ mb: 2 }}>
                    <Typography variant="caption" fontWeight={700} color="text.secondary" sx={{ mb: 1, display: 'block' }}>
                      Aggregation Diagnostics:
                    </Typography>
                    <Table size="small">
                      <TableHead>
                        <TableRow>
                          <TableCell>Credit Note No.</TableCell>
                          <TableCell>Reason</TableCell>
                          <TableCell>Detail</TableCell>
                        </TableRow>
                      </TableHead>
                      <TableBody>
                        {creditNotesData.diagnostics.map((d, i) => (
                          <TableRow key={i}>
                            <TableCell sx={{ fontFamily: 'monospace' }}>{d.creditNoteNumber ?? d.creditNoteId}</TableCell>
                            <TableCell>
                              <Chip size="small" label={d.reason} color="warning" sx={{ height: 20, fontSize: '0.7rem' }} />
                            </TableCell>
                            <TableCell sx={{ fontSize: '0.85rem' }}>{d.detail}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </Box>
                )}

                {creditNotesData?.excluded && creditNotesData.excluded.length > 0 && (
                  <Box>
                    <Typography variant="caption" fontWeight={700} color="text.secondary" sx={{ mb: 1, display: 'block' }}>
                      Excluded Credit Notes:
                    </Typography>
                    <Table size="small">
                      <TableHead>
                        <TableRow>
                          <TableCell>Credit Note No.</TableCell>
                          <TableCell>Date</TableCell>
                          <TableCell>Exclusion Reason</TableCell>
                        </TableRow>
                      </TableHead>
                      <TableBody>
                        {creditNotesData.excluded.map((e, i) => (
                          <TableRow key={i}>
                            <TableCell sx={{ fontFamily: 'monospace', fontWeight: 600 }}>{e.creditNoteNumber}</TableCell>
                            <TableCell>{formatLocalDateStr(e.creditNoteDate)}</TableCell>
                            <TableCell>
                              <Chip size="small" label={e.exclusionReason} color="default" sx={{ height: 20, fontSize: '0.7rem' }} />
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </Box>
                )}
              </AccordionDetails>
            </Accordion>
          )}
        </Box>
      )}
    </Box>
  );
}
