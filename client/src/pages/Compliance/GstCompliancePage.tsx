import { useState, useMemo } from 'react';
import {
  Box, Card, CardContent, Typography, Grid, TextField, Button, Table, TableHead,
  TableBody, TableRow, TableCell, Chip, Dialog, DialogTitle, DialogContent,
  DialogActions, FormControl, InputLabel, Select, MenuItem, Tabs, Tab, Alert,
  Divider, Switch, FormControlLabel, InputAdornment, IconButton, Tooltip,
} from '@mui/material';
import {
  Verified, WarningAmber, History, CheckCircle, ErrorOutline,
  InfoOutlined, Edit, Refresh, Policy, Rule, FactCheck,
} from '@mui/icons-material';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useSnackbar } from 'notistack';
import { apiGet, apiPost } from '../../api/client';
import { PageHeader } from '../../components/common/PageHeader';
import { PermissionGate } from '../../components/auth/PermissionGate';
import { useAuthStore } from '../../store/auth.store';

export interface CompanyGstRegistration {
  id: string;
  gstin: string;
  legalName: string;
  tradeName?: string | null;
  stateCode: string;
  isPrimary: boolean;
  isActive: boolean;
}

export interface AatoRecord {
  id: string;
  companyId: string;
  gstRegistrationId: string;
  financialYear: string;
  turnover: number;
  precedingTurnover: number | null;
  source: string;
  verificationStatus: string;
  verifiedDate: string | null;
  verifiedBy: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AatoApiResponse {
  aato: AatoRecord | null;
  precedingAato: {
    financialYear: string;
    turnover: number | null;
    source: string | null;
    verificationStatus: string | null;
  } | null;
  financialYear: string;
  precedingFinancialYear: string;
}

export interface AatoHistoryItem {
  id: string;
  aatoId: string;
  gstRegistrationId: string;
  financialYear: string;
  turnover: number;
  precedingTurnover: number | null;
  source: string;
  verificationStatus: string;
  verifiedDate: string | null;
  notes: string | null;
  action: string;
  changedBy: string | null;
  createdAt: string;
}

export interface ComplianceIssue {
  code: string;
  field: string;
  message: string;
}

export interface ComplianceValidationResponse {
  valid: boolean;
  errors: ComplianceIssue[];
  warnings: ComplianceIssue[];
  info: ComplianceIssue[];
  metadata?: {
    gstin?: {
      valid: boolean;
      stateCode?: string;
      pan?: string;
    };
    hsnSac?: {
      code: string;
      codeType: string;
      description: string | null;
      gstRate: number | null;
      defaultUqc: string | null;
      existsInMaster: boolean;
      isActive: boolean;
      digitLength: number;
    };
    uqc?: {
      valid: boolean;
      canonicalCode: string | null;
    };
    aatoThreshold?: {
      aato: number | null;
      threshold: number;
      exceeds5Cr: boolean;
      mandatedMinHsnDigits: number | null;
      state?: string;
      status?: string;
      precedingTurnover?: number | null;
      precedingVerificationStatus?: string | null;
      currentTurnover?: number | null;
      supplyType?: string | null;
    };
  };
}

const AATO_SOURCES = ['MANUAL', 'GST_PORTAL', 'IMPORT', 'SYSTEM_CALCULATED', 'OTHER'] as const;

function formatInr(val?: number | null): string {
  if (val === undefined || val === null) return '—';
  return '₹ ' + Number(val).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function computeDefaultFinancialYear(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth(); // 0 = Jan, 2 = Mar, 3 = Apr
  const startYear = month >= 3 ? year : year - 1;
  const endYearShort = (startYear + 1) % 100;
  return `${startYear}-${endYearShort < 10 ? '0' + endYearShort : endYearShort}`;
}

const FY_OPTIONS = [
  '2026-27',
  '2025-26',
  '2024-25',
  '2023-24',
  '2022-23',
  '2021-22',
];

export function GstCompliancePage() {
  const { enqueueSnackbar } = useSnackbar();
  const qc = useQueryClient();
  const currentFy = useMemo(() => computeDefaultFinancialYear(), []);

  const [activeTab, setActiveTab] = useState<'AATO' | 'VALIDATOR'>('AATO');
  const [selectedRegId, setSelectedRegId] = useState<string>('');
  const [selectedFy, setSelectedFy] = useState<string>(currentFy);

  // Modal edit state
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [formTurnover, setFormTurnover] = useState<string>('');
  const [formPrecedingTurnover, setFormPrecedingTurnover] = useState<string>('');
  const [formSource, setFormSource] = useState<string>('MANUAL');
  const [formVerified, setFormVerified] = useState<boolean>(false);
  const [formNotes, setFormNotes] = useState<string>('');

  // Interactive Validator state
  const [valGstin, setValGstin] = useState<string>('');
  const [valHsn, setValHsn] = useState<string>('7113');
  const [valCodeType, setValCodeType] = useState<'HSN' | 'SAC'>('HSN');
  const [valSupplyType, setValSupplyType] = useState<'' | 'B2B' | 'B2C'>('');
  const [valUqc, setValUqc] = useState<string>('GMS');
  const [valTurnover, setValTurnover] = useState<string>('');
  const [valTurnoverVerified, setValTurnoverVerified] = useState<boolean>(false);

  // 1. Fetch GST Registrations
  const { data: registrations = [], isLoading: loadingRegs } = useQuery<CompanyGstRegistration[]>({
    queryKey: ['gst-registrations'],
    queryFn: () => apiGet('/company/gst-registrations'),
  });

  // Ensure selected registration defaults to primary active or first active
  const activeReg = useMemo(() => {
    if (!registrations.length) return null;
    if (selectedRegId) {
      const match = registrations.find((r) => r.id === selectedRegId);
      if (match) return match;
    }
    const primary = registrations.find((r) => r.isPrimary && r.isActive) || registrations.find((r) => r.isActive) || registrations[0];
    return primary ?? null;
  }, [registrations, selectedRegId]);

  const effectiveRegId = activeReg?.id ?? '';

  // 2. Fetch AATO for selected registration and FY
  const {
    data: aatoData,
    isLoading: loadingAato,
    refetch: refetchAato,
  } = useQuery<AatoApiResponse>({
    queryKey: ['gst-aato', effectiveRegId, selectedFy],
    queryFn: () =>
      apiGet(`/gst/aato?gstRegistrationId=${effectiveRegId}&financialYear=${selectedFy}`),
    enabled: !!effectiveRegId,
  });

  // 3. Fetch AATO History
  const { data: aatoHistory = [], isLoading: loadingHistory } = useQuery<AatoHistoryItem[]>({
    queryKey: ['gst-aato-history', effectiveRegId, selectedFy],
    queryFn: () =>
      apiGet(`/gst/aato/history?gstRegistrationId=${effectiveRegId}&financialYear=${selectedFy}`),
    enabled: !!effectiveRegId,
  });

  // 4. Save AATO Mutation
  const saveMutation = useMutation({
    mutationFn: (data: any) => apiPost('/gst/aato', data),
    onSuccess: () => {
      enqueueSnackbar('AATO record saved successfully', { variant: 'success' });
      qc.invalidateQueries({ queryKey: ['gst-aato', effectiveRegId, selectedFy] });
      qc.invalidateQueries({ queryKey: ['gst-aato-history', effectiveRegId, selectedFy] });
      setEditDialogOpen(false);
    },
    onError: (err: any) => {
      const msg = err.response?.data?.error ?? err.message ?? 'Failed to save AATO';
      enqueueSnackbar(msg, { variant: 'error' });
    },
  });

  // 5. Compliance Validation Query
  const {
    data: complianceResult,
    isLoading: loadingCompliance,
    refetch: runValidation,
  } = useQuery<ComplianceValidationResponse>({
    queryKey: ['gst-compliance-val', valGstin, valHsn, valCodeType, valSupplyType, valUqc, valTurnover, valTurnoverVerified, effectiveRegId, selectedFy],
    queryFn: () =>
      apiPost('/gst/compliance/validate', {
        gstin: valGstin || undefined,
        hsnCode: valHsn || undefined,
        codeType: valCodeType,
        supplyType: valSupplyType || undefined,
        uqc: valUqc || undefined,
        financialYear: selectedFy,
        precedingTurnover: valTurnover ? Number(valTurnover) : (aatoData?.precedingAato?.turnover ?? undefined),
        precedingVerificationStatus: valTurnover
          ? (valTurnoverVerified ? 'VERIFIED' : 'UNVERIFIED')
          : (aatoData?.precedingAato?.verificationStatus ?? undefined),
        currentTurnover: aatoData?.aato?.turnover ?? undefined,
        gstRegistrationId: effectiveRegId || undefined,
      }),
    enabled: activeTab === 'VALIDATOR',
  });

  const handleOpenEdit = () => {
    if (aatoData?.aato) {
      setFormTurnover(String(aatoData.aato.turnover));
      setFormPrecedingTurnover(aatoData.aato.precedingTurnover != null ? String(aatoData.aato.precedingTurnover) : '');
      setFormSource(aatoData.aato.source);
      setFormVerified(aatoData.aato.verificationStatus === 'VERIFIED');
      setFormNotes(aatoData.aato.notes ?? '');
    } else {
      setFormTurnover('');
      setFormPrecedingTurnover('');
      setFormSource('MANUAL');
      setFormVerified(false);
      setFormNotes('');
    }
    setEditDialogOpen(true);
  };

  const handleSaveAato = (e: React.FormEvent) => {
    e.preventDefault();
    if (!effectiveRegId) {
      enqueueSnackbar('Please select a GST registration first', { variant: 'warning' });
      return;
    }
    const turnoverNum = parseFloat(formTurnover);
    if (isNaN(turnoverNum) || turnoverNum < 0) {
      enqueueSnackbar('Please enter a valid non-negative turnover amount', { variant: 'error' });
      return;
    }
    const precNum = formPrecedingTurnover ? parseFloat(formPrecedingTurnover) : null;

    saveMutation.mutate({
      gstRegistrationId: effectiveRegId,
      financialYear: selectedFy,
      turnover: turnoverNum,
      precedingTurnover: precNum,
      source: formSource,
      verificationStatus: formVerified ? 'VERIFIED' : 'UNVERIFIED',
      notes: formNotes || null,
    });
  };

  return (
    <Box sx={{ p: 3, maxWidth: 1400, mx: 'auto' }}>
      <PageHeader
        title="GST Compliance & AATO"
        subtitle="Annual Aggregate Turnover (AATO) management, HSN/SAC statutory compliance, UQC validation, and GSTIN verification"
      />

      {/* Primary Navigation Tabs */}
      <Tabs
        value={activeTab}
        onChange={(_, val) => setActiveTab(val)}
        sx={{ borderBottom: 1, borderColor: 'divider', mb: 3 }}
      >
        <Tab icon={<Policy sx={{ mr: 1 }} />} iconPosition="start" label="AATO Management" value="AATO" />
        <Tab icon={<FactCheck sx={{ mr: 1 }} />} iconPosition="start" label="Statutory Compliance Checker" value="VALIDATOR" />
      </Tabs>

      {/* Global Filter Bar for Registration & FY */}
      <Card variant="outlined" sx={{ mb: 3, p: 2, bgcolor: 'background.paper' }}>
        <Grid container spacing={2} alignItems="center">
          <Grid item xs={12} sm={6} md={5}>
            <FormControl fullWidth size="small">
              <InputLabel id="gstin-select-label">GST Registration</InputLabel>
              <Select
                labelId="gstin-select-label"
                value={activeReg?.id ?? ''}
                label="GST Registration"
                onChange={(e) => setSelectedRegId(e.target.value)}
              >
                {registrations.map((r) => (
                  <MenuItem key={r.id} value={r.id}>
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                      <Typography fontWeight={600} sx={{ fontFamily: 'monospace' }}>
                        {r.gstin}
                      </Typography>
                      <Typography variant="body2" color="text.secondary">
                        — {r.tradeName || r.legalName}
                      </Typography>
                      {r.isPrimary && <Chip label="Primary" size="small" color="primary" sx={{ height: 20, fontSize: 10 }} />}
                      {!r.isActive && <Chip label="Inactive" size="small" color="default" sx={{ height: 20, fontSize: 10 }} />}
                    </Box>
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
          </Grid>

          <Grid item xs={6} sm={3} md={3}>
            <FormControl fullWidth size="small">
              <InputLabel id="fy-select-label">Financial Year (FY)</InputLabel>
              <Select
                labelId="fy-select-label"
                value={selectedFy}
                label="Financial Year (FY)"
                onChange={(e) => setSelectedFy(e.target.value)}
              >
                {FY_OPTIONS.map((fy) => (
                  <MenuItem key={fy} value={fy}>
                    {fy} {fy === currentFy ? '(Current)' : ''}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
          </Grid>

          <Grid item xs={6} sm={3} md={4} sx={{ display: 'flex', justifyContent: 'flex-end', gap: 1 }}>
            <Tooltip title="Refresh AATO data">
              <IconButton onClick={() => refetchAato()} size="small" sx={{ border: '1px solid', borderColor: 'divider' }}>
                <Refresh fontSize="small" />
              </IconButton>
            </Tooltip>
            {activeTab === 'AATO' && (
              <PermissionGate permission="gst:registration_edit">
                <Button
                  variant="contained"
                  startIcon={<Edit />}
                  onClick={handleOpenEdit}
                  disabled={!effectiveRegId || loadingAato}
                >
                  {aatoData?.aato ? 'Edit AATO' : 'Record AATO'}
                </Button>
              </PermissionGate>
            )}
          </Grid>
        </Grid>
      </Card>

      {/* TAB 1: AATO MANAGEMENT */}
      {activeTab === 'AATO' && (
        <Box>
          <Grid container spacing={3} sx={{ mb: 3 }}>
            {/* Current FY AATO Card */}
            <Grid item xs={12} md={6}>
              <Card variant="outlined" sx={{ height: '100%', borderColor: aatoData?.aato?.verificationStatus === 'VERIFIED' ? 'success.main' : 'divider' }}>
                <CardContent>
                  <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', mb: 1 }}>
                    <Box>
                      <Typography variant="overline" color="text.secondary" fontWeight={700}>
                        Current Financial Year (Informational Context)
                      </Typography>
                      <Typography variant="h5" fontWeight={700} color="primary.main">
                        FY {selectedFy}
                      </Typography>
                    </Box>
                    <Box sx={{ display: 'flex', gap: 1 }}>
                      {aatoData?.aato?.verificationStatus === 'VERIFIED' ? (
                        <Chip
                          icon={<CheckCircle fontSize="small" />}
                          label="VERIFIED"
                          color="success"
                          size="small"
                          sx={{ fontWeight: 600 }}
                        />
                      ) : (
                        <Chip
                          icon={<WarningAmber fontSize="small" />}
                          label="UNVERIFIED"
                          color="warning"
                          size="small"
                          sx={{ fontWeight: 600 }}
                        />
                      )}
                      <Chip
                        label={aatoData?.aato?.source ?? 'NOT_SET'}
                        size="small"
                        variant="outlined"
                      />
                    </Box>
                  </Box>

                  <Typography variant="body2" color="text.secondary" sx={{ mt: 2 }}>
                    Annual Aggregate Turnover (AATO):
                  </Typography>
                  <Typography variant="h3" fontWeight={800} sx={{ my: 1, fontFamily: 'monospace' }}>
                    {formatInr(aatoData?.aato?.turnover)}
                  </Typography>
                  <Typography variant="caption" color="text.secondary" display="block">
                    Informational only — statutory HSN requirements are determined by Preceding FY AATO
                  </Typography>

                  <Divider sx={{ my: 2 }} />

                  <Grid container spacing={1} sx={{ fontSize: 13 }}>
                    <Grid item xs={6}>
                      <Typography variant="caption" color="text.secondary" display="block">Verified Date</Typography>
                      <Typography variant="body2" fontWeight={500}>
                        {aatoData?.aato?.verifiedDate ? new Date(aatoData.aato.verifiedDate).toLocaleDateString('en-IN') : '—'}
                      </Typography>
                    </Grid>
                    <Grid item xs={6}>
                      <Typography variant="caption" color="text.secondary" display="block">Verification Method</Typography>
                      <Typography variant="body2" fontWeight={500}>
                        {aatoData?.aato?.source || '—'}
                      </Typography>
                    </Grid>
                    <Grid item xs={12} sx={{ mt: 1 }}>
                      <Typography variant="caption" color="text.secondary" display="block">Notes</Typography>
                      <Typography variant="body2" color="text.secondary">
                        {aatoData?.aato?.notes || 'No statutory notes recorded.'}
                      </Typography>
                    </Grid>
                  </Grid>
                </CardContent>
              </Card>
            </Grid>

            {/* Preceding FY AATO Context Card */}
            <Grid item xs={12} md={6}>
              <Card variant="outlined" sx={{ height: '100%', bgcolor: 'action.hover' }}>
                <CardContent>
                  <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', mb: 1 }}>
                    <Box>
                      <Typography variant="overline" color="text.secondary" fontWeight={700}>
                        Preceding Financial Year Context
                      </Typography>
                      <Typography variant="h5" fontWeight={700}>
                        FY {aatoData?.precedingFinancialYear ?? '—'}
                      </Typography>
                    </Box>
                    {aatoData?.precedingAato?.verificationStatus && (
                      <Chip
                        label={aatoData.precedingAato.verificationStatus}
                        size="small"
                        color={aatoData.precedingAato.verificationStatus === 'VERIFIED' ? 'success' : 'default'}
                      />
                    )}
                  </Box>

                  <Typography variant="body2" color="text.secondary" sx={{ mt: 2 }}>
                    Preceding FY Aggregate Turnover:
                  </Typography>
                  <Typography variant="h3" fontWeight={800} sx={{ my: 1, fontFamily: 'monospace' }}>
                    {formatInr(aatoData?.precedingAato?.turnover)}
                  </Typography>

                  <Divider sx={{ my: 2 }} />

                  {/* Statutory HSN Compliance Threshold Notice */}
                  {(() => {
                    const precTurnover = aatoData?.precedingAato?.turnover;
                    const precStatus = aatoData?.precedingAato?.verificationStatus;
                    const isVerified = precStatus === 'VERIFIED';
                    const isOver5Cr = (precTurnover ?? 0) > 50000000;

                    if (precTurnover != null && isVerified) {
                      return (
                        <Alert severity={isOver5Cr ? 'info' : 'success'} icon={<Rule />} sx={{ mt: 1 }}>
                          <Typography variant="subtitle2" fontWeight={700}>
                            Statutory Rule (Notification No. 78/2020 – Central Tax)
                          </Typography>
                          <Typography variant="body2" sx={{ fontSize: 13, mt: 0.5 }}>
                            {isOver5Cr ? (
                              <>
                                Preceding FY ({aatoData?.precedingFinancialYear ?? '—'}) AATO exceeds ₹5 Crores (VERIFIED): <strong>6-digit HSN codes are mandatory</strong> on all outward invoices and GSTR-1 Table 12 filings.
                              </>
                            ) : (
                              <>
                                Preceding FY ({aatoData?.precedingFinancialYear ?? '—'}) AATO is up to ₹5 Crores (VERIFIED): <strong>Minimum 4-digit HSN codes</strong> are required for B2B supplies (optional for B2C).
                              </>
                            )}
                          </Typography>
                        </Alert>
                      );
                    } else if (precTurnover != null && !isVerified) {
                      return (
                        <Alert severity="warning" icon={<WarningAmber />} sx={{ mt: 1 }}>
                          <Typography variant="subtitle2" fontWeight={700}>
                            Preceding FY AATO Unverified
                          </Typography>
                          <Typography variant="body2" sx={{ fontSize: 13, mt: 0.5 }}>
                            Preceding FY ({aatoData?.precedingFinancialYear ?? '—'}) turnover is recorded ({formatInr(precTurnover)}) but <strong>UNVERIFIED</strong>. Statutory 4-digit vs 6-digit HSN requirement cannot be authoritatively determined until verified against portal returns.
                          </Typography>
                        </Alert>
                      );
                    } else {
                      return (
                        <Alert severity="warning" icon={<WarningAmber />} sx={{ mt: 1 }}>
                          <Typography variant="subtitle2" fontWeight={700}>
                            Preceding FY AATO Missing
                          </Typography>
                          <Typography variant="body2" sx={{ fontSize: 13, mt: 0.5 }}>
                            Preceding FY ({aatoData?.precedingFinancialYear ?? '—'}) AATO is not recorded. Under Notification No. 78/2020, statutory HSN digit requirements are based strictly on preceding FY turnover. Current FY turnover cannot be used as a statutory substitute.
                          </Typography>
                        </Alert>
                      );
                    }
                  })()}
                </CardContent>
              </Card>
            </Grid>
          </Grid>

          {/* AATO History Log Card */}
          <Card variant="outlined">
            <CardContent>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 2 }}>
                <History color="primary" />
                <Typography variant="h6" fontWeight={700}>
                  AATO Audit Trail & History
                </Typography>
              </Box>

              <Table size="small">
                <TableHead>
                  <TableRow sx={{ bgcolor: 'action.hover' }}>
                    <TableCell sx={{ fontWeight: 700 }}>Timestamp</TableCell>
                    <TableCell sx={{ fontWeight: 700 }}>Action</TableCell>
                    <TableCell sx={{ fontWeight: 700 }}>FY</TableCell>
                    <TableCell sx={{ fontWeight: 700 }} align="right">Turnover</TableCell>
                    <TableCell sx={{ fontWeight: 700 }} align="right">Preceding Turnover</TableCell>
                    <TableCell sx={{ fontWeight: 700 }}>Source</TableCell>
                    <TableCell sx={{ fontWeight: 700 }}>Status</TableCell>
                    <TableCell sx={{ fontWeight: 700 }}>Notes</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {aatoHistory.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={8} align="center" sx={{ py: 3, color: 'text.secondary' }}>
                        No audit history recorded for this registration and financial year.
                      </TableCell>
                    </TableRow>
                  ) : (
                    aatoHistory.map((h) => (
                      <TableRow key={h.id}>
                        <TableCell sx={{ fontFamily: 'monospace', fontSize: 12 }}>
                          {new Date(h.createdAt).toLocaleString('en-IN')}
                        </TableCell>
                        <TableCell>
                          <Chip
                            label={h.action}
                            size="small"
                            color={h.action === 'CREATE' ? 'primary' : h.action === 'VERIFY' ? 'success' : 'default'}
                            sx={{ fontSize: 11, height: 22 }}
                          />
                        </TableCell>
                        <TableCell sx={{ fontWeight: 600 }}>{h.financialYear}</TableCell>
                        <TableCell align="right" sx={{ fontFamily: 'monospace', fontWeight: 600 }}>
                          {formatInr(h.turnover)}
                        </TableCell>
                        <TableCell align="right" sx={{ fontFamily: 'monospace', color: 'text.secondary' }}>
                          {formatInr(h.precedingTurnover)}
                        </TableCell>
                        <TableCell>{h.source}</TableCell>
                        <TableCell>
                          <Chip
                            label={h.verificationStatus}
                            size="small"
                            color={h.verificationStatus === 'VERIFIED' ? 'success' : 'warning'}
                            sx={{ fontSize: 11, height: 22 }}
                          />
                        </TableCell>
                        <TableCell sx={{ fontSize: 12, color: 'text.secondary' }}>
                          {h.notes || '—'}
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </Box>
      )}

      {/* TAB 2: COMPLIANCE VALIDATOR */}
      {activeTab === 'VALIDATOR' && (
        <Box>
          <Grid container spacing={3}>
            {/* Input Form Column */}
            <Grid item xs={12} md={5}>
              <Card variant="outlined">
                <CardContent>
                  <Typography variant="h6" fontWeight={700} sx={{ mb: 2 }}>
                    Live Compliance Validator
                  </Typography>
                  <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
                    Test and verify GSTINs, HSN/SAC codes, and Unit Quantity Codes (UQC) against statutory rules and the local reference master.
                  </Typography>

                  <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                    <TextField
                      fullWidth
                      label="GSTIN"
                      placeholder="e.g. 24AAAAA0000A1Z8"
                      value={valGstin}
                      onChange={(e) => setValGstin(e.target.value.toUpperCase())}
                      helperText="15-character GSTIN format + checksum validation"
                      inputProps={{ maxLength: 15 }}
                    />

                    <Grid container spacing={1}>
                      <Grid item xs={6}>
                        <TextField
                          fullWidth
                          label="HSN / SAC Code"
                          placeholder="e.g. 7113"
                          value={valHsn}
                          onChange={(e) => setValHsn(e.target.value)}
                          helperText="2, 4, 6, or 8 digits"
                        />
                      </Grid>
                      <Grid item xs={3}>
                        <FormControl fullWidth>
                          <InputLabel id="code-type-label">Type</InputLabel>
                          <Select
                            labelId="code-type-label"
                            value={valCodeType}
                            label="Type"
                            onChange={(e) => setValCodeType(e.target.value as any)}
                          >
                            <MenuItem value="HSN">HSN</MenuItem>
                            <MenuItem value="SAC">SAC</MenuItem>
                          </Select>
                        </FormControl>
                      </Grid>
                      <Grid item xs={3}>
                        <FormControl fullWidth>
                          <InputLabel id="supply-type-label">Supply</InputLabel>
                          <Select
                            labelId="supply-type-label"
                            value={valSupplyType}
                            label="Supply"
                            onChange={(e) => setValSupplyType(e.target.value as any)}
                          >
                            <MenuItem value="">Auto</MenuItem>
                            <MenuItem value="B2B">B2B</MenuItem>
                            <MenuItem value="B2C">B2C</MenuItem>
                          </Select>
                        </FormControl>
                      </Grid>
                    </Grid>

                    <TextField
                      fullWidth
                      label="Unit Quantity Code (UQC)"
                      placeholder="e.g. GMS, PCS, NOS"
                      value={valUqc}
                      onChange={(e) => setValUqc(e.target.value.toUpperCase())}
                      helperText="Must match standard GST unit codes"
                      inputProps={{ maxLength: 10 }}
                    />

                    <TextField
                      fullWidth
                      label="Preceding FY Turnover Override (₹)"
                      placeholder={`Preceding FY: ${aatoData?.precedingAato?.turnover != null ? aatoData.precedingAato.turnover : 'Not recorded'}`}
                      value={valTurnover}
                      onChange={(e) => setValTurnover(e.target.value)}
                      helperText="Leave empty to use registration's saved preceding FY AATO (Notification No. 78/2020)"
                      InputProps={{
                        startAdornment: <InputAdornment position="start">₹</InputAdornment>,
                      }}
                    />

                    {valTurnover && (
                      <FormControlLabel
                        control={
                          <Switch
                            size="small"
                            checked={valTurnoverVerified}
                            onChange={(e) => setValTurnoverVerified(e.target.checked)}
                            color="success"
                          />
                        }
                        label={
                          <Typography variant="caption" fontWeight={600}>
                            {valTurnoverVerified ? 'Override marked VERIFIED' : 'Override marked UNVERIFIED'}
                          </Typography>
                        }
                      />
                    )}

                    <Button
                      variant="contained"
                      onClick={() => runValidation()}
                      disabled={loadingCompliance}
                      sx={{ mt: 1 }}
                    >
                      Run Statutory Validation
                    </Button>
                  </Box>
                </CardContent>
              </Card>
            </Grid>

            {/* Validation Outcome Column */}
            <Grid item xs={12} md={7}>
              <Card variant="outlined">
                <CardContent>
                  <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 2 }}>
                    <Typography variant="h6" fontWeight={700}>
                      Validation Results
                    </Typography>
                    {complianceResult && (
                      <Chip
                        icon={
                          !complianceResult.valid
                            ? <ErrorOutline />
                            : complianceResult.warnings.length > 0
                              ? <WarningAmber />
                              : <CheckCircle />
                        }
                        label={
                          !complianceResult.valid
                            ? 'STATUTORY ISSUES DETECTED'
                            : complianceResult.warnings.length > 0
                              ? 'COMPLIANT WITH WARNINGS'
                              : 'COMPLIANT'
                        }
                        color={
                          !complianceResult.valid
                            ? 'error'
                            : complianceResult.warnings.length > 0
                              ? 'warning'
                              : 'success'
                        }
                        sx={{ fontWeight: 700 }}
                      />
                    )}
                  </Box>

                  {/* Errors */}
                  {complianceResult?.errors && complianceResult.errors.length > 0 && (
                    <Box sx={{ mb: 2 }}>
                      <Typography variant="subtitle2" color="error.main" fontWeight={700} sx={{ display: 'flex', alignItems: 'center', gap: 0.5, mb: 1 }}>
                        <ErrorOutline fontSize="small" /> Statutory Errors ({complianceResult.errors.length})
                      </Typography>
                      {complianceResult.errors.map((err, idx) => (
                        <Alert severity="error" key={idx} sx={{ mb: 1, py: 0.5 }}>
                          <Typography variant="body2">
                            <strong>[{err.code}]</strong> <em>({err.field})</em>: {err.message}
                          </Typography>
                        </Alert>
                      ))}
                    </Box>
                  )}

                  {/* Warnings */}
                  {complianceResult?.warnings && complianceResult.warnings.length > 0 && (
                    <Box sx={{ mb: 2 }}>
                      <Typography variant="subtitle2" color="warning.main" fontWeight={700} sx={{ display: 'flex', alignItems: 'center', gap: 0.5, mb: 1 }}>
                        <WarningAmber fontSize="small" /> Compliance Warnings ({complianceResult.warnings.length})
                      </Typography>
                      {complianceResult.warnings.map((warn, idx) => (
                        <Alert severity="warning" key={idx} sx={{ mb: 1, py: 0.5 }}>
                          <Typography variant="body2">
                            <strong>[{warn.code}]</strong> <em>({warn.field})</em>: {warn.message}
                          </Typography>
                        </Alert>
                      ))}
                    </Box>
                  )}

                  {/* Info */}
                  {complianceResult?.info && complianceResult.info.length > 0 && (
                    <Box sx={{ mb: 2 }}>
                      <Typography variant="subtitle2" color="info.main" fontWeight={700} sx={{ display: 'flex', alignItems: 'center', gap: 0.5, mb: 1 }}>
                        <InfoOutlined fontSize="small" /> Statutory Information ({complianceResult.info.length})
                      </Typography>
                      {complianceResult.info.map((inf, idx) => (
                        <Alert severity="info" key={idx} sx={{ mb: 1, py: 0.5 }}>
                          <Typography variant="body2">
                            <strong>[{inf.code}]</strong> <em>({inf.field})</em>: {inf.message}
                          </Typography>
                        </Alert>
                      ))}
                    </Box>
                  )}

                  {complianceResult?.metadata?.hsnSac?.existsInMaster && (
                    <Card variant="outlined" sx={{ mt: 2, bgcolor: 'background.default' }}>
                      <CardContent sx={{ py: 1.5, '&:last-child': { pb: 1.5 } }}>
                        <Typography variant="caption" color="text.secondary" fontWeight={700}>
                          MASTER RECORD DETAILS
                        </Typography>
                        <Grid container spacing={1} sx={{ mt: 0.5, fontSize: 13 }}>
                          <Grid item xs={6}>
                            <strong>Description:</strong> {complianceResult.metadata.hsnSac.description ?? '—'}
                          </Grid>
                          <Grid item xs={3}>
                            <strong>GST Rate:</strong> {((complianceResult.metadata.hsnSac.gstRate ?? 0) * 100).toFixed(1)}%
                          </Grid>
                          <Grid item xs={3}>
                            <strong>Default UQC:</strong> {complianceResult.metadata.hsnSac.defaultUqc ?? '—'}
                          </Grid>
                        </Grid>
                      </CardContent>
                    </Card>
                  )}
                </CardContent>
              </Card>
            </Grid>
          </Grid>
        </Box>
      )}

      {/* Edit / Record AATO Modal Dialog */}
      <Dialog open={editDialogOpen} onClose={() => setEditDialogOpen(false)} maxWidth="sm" fullWidth>
        <form onSubmit={handleSaveAato}>
          <DialogTitle fontWeight={700}>
            {aatoData?.aato ? `Edit AATO for FY ${selectedFy}` : `Record AATO for FY ${selectedFy}`}
          </DialogTitle>
          <DialogContent sx={{ pt: 1 }}>
            <Box sx={{ mb: 2 }}>
              <Typography variant="body2" color="text.secondary">
                GST Registration: <strong>{activeReg?.gstin}</strong> ({activeReg?.tradeName || activeReg?.legalName})
              </Typography>
              <Typography variant="body2" color="text.secondary">
                Financial Year: <strong>{selectedFy}</strong> (Preceding: {aatoData?.precedingFinancialYear ?? '—'})
              </Typography>
            </Box>

            <Grid container spacing={2}>
              <Grid item xs={12}>
                <TextField
                  fullWidth
                  required
                  label="Annual Aggregate Turnover (AATO)"
                  placeholder="e.g. 12500000"
                  value={formTurnover}
                  onChange={(e) => setFormTurnover(e.target.value)}
                  InputProps={{
                    startAdornment: <InputAdornment position="start">₹</InputAdornment>,
                  }}
                  helperText="Total turnover across all business supplies for the FY"
                />
              </Grid>

              <Grid item xs={12}>
                <TextField
                  fullWidth
                  label={`Preceding FY (${aatoData?.precedingFinancialYear ?? 'Previous'}) Turnover`}
                  placeholder="Optional explicit override"
                  value={formPrecedingTurnover}
                  onChange={(e) => setFormPrecedingTurnover(e.target.value)}
                  InputProps={{
                    startAdornment: <InputAdornment position="start">₹</InputAdornment>,
                  }}
                  helperText="Leave empty to automatically inherit from preceding FY record"
                />
              </Grid>

              <Grid item xs={12} sm={6}>
                <FormControl fullWidth>
                  <InputLabel id="source-select-label">Data Source</InputLabel>
                  <Select
                    labelId="source-select-label"
                    value={formSource}
                    label="Data Source"
                    onChange={(e) => setFormSource(e.target.value)}
                  >
                    {AATO_SOURCES.map((src) => (
                      <MenuItem key={src} value={src}>{src}</MenuItem>
                    ))}
                  </Select>
                </FormControl>
              </Grid>

              <Grid item xs={12} sm={6} sx={{ display: 'flex', alignItems: 'center' }}>
                <FormControlLabel
                  control={
                    <Switch
                      checked={formVerified}
                      onChange={(e) => setFormVerified(e.target.checked)}
                      color="success"
                    />
                  }
                  label={formVerified ? 'Mark as VERIFIED' : 'UNVERIFIED'}
                />
              </Grid>

              {formSource === 'MANUAL' && formVerified && (
                <Grid item xs={12}>
                  <Alert severity="warning" sx={{ py: 0.5, fontSize: 12 }}>
                    Statutory Rule: Manual entries must only be marked VERIFIED if confirmed against filed GST returns or portal records.
                  </Alert>
                </Grid>
              )}

              <Grid item xs={12}>
                <TextField
                  fullWidth
                  multiline
                  rows={2}
                  label="Notes / Statutory Remarks"
                  placeholder="e.g. Verified from GSTR-9 annual return / Portal AATO window"
                  value={formNotes}
                  onChange={(e) => setFormNotes(e.target.value)}
                />
              </Grid>
            </Grid>
          </DialogContent>
          <DialogActions sx={{ p: 2 }}>
            <Button onClick={() => setEditDialogOpen(false)}>Cancel</Button>
            <Button type="submit" variant="contained" disabled={saveMutation.isPending}>
              {saveMutation.isPending ? 'Saving...' : 'Save AATO Record'}
            </Button>
          </DialogActions>
        </form>
      </Dialog>
    </Box>
  );
}
