import { useEffect, useRef, useState } from 'react';
import {
  Box, Card, CardContent, Table, TableHead, TableBody, TableRow, TableCell, Typography,
  Button, Grid, MenuItem, TextField, Stack, Chip, CircularProgress, Divider, InputAdornment,
} from '@mui/material';
import { Add, QrCodeScanner, CheckCircle, ArrowBack } from '@mui/icons-material';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useSnackbar } from 'notistack';
import { apiGet, apiPost } from '../../api/client';
import { PageHeader } from '../../components/common/PageHeader';
import { StatusChip } from '../../components/common/StatusChip';

// E3: a physical stock count for one branch. Report-only — completing an audit never changes a
// tag's status or branch; missing/unexpected findings are a list for staff to act on separately
// (via Tags & Inventory's retire action, or a branch transfer), not an automatic side effect.

function StartAuditCard({ onStarted }: { onStarted: (auditId: string) => void }) {
  const { enqueueSnackbar } = useSnackbar();
  const qc = useQueryClient();
  const [branchId, setBranchId] = useState('');

  const { data: branches } = useQuery({ queryKey: ['branches'], queryFn: () => apiGet<any>('/tagging/branches') });
  const branchList: any[] = (branches as any)?.data ?? branches ?? [];

  const mutation = useMutation({
    mutationFn: () => apiPost<any>('/tagging/audits', { branchId }),
    onSuccess: (audit: any) => {
      qc.invalidateQueries({ queryKey: ['stock-audits'] });
      enqueueSnackbar(`Audit ${audit.auditNumber} started — ${audit.summary.expectedCount} pieces expected`, { variant: 'success' });
      onStarted(audit.id);
    },
    onError: (e: any) => enqueueSnackbar(e.response?.data?.error ?? 'Failed to start audit', { variant: 'error' }),
  });

  return (
    <Card sx={{ mb: 2 }}>
      <CardContent>
        <Typography variant="subtitle1" fontWeight={700} sx={{ mb: 1.5 }}>Start a New Audit</Typography>
        <Stack direction="row" spacing={1.5} alignItems="center">
          <TextField select size="small" label="Branch" value={branchId}
            onChange={(e) => setBranchId(e.target.value)} sx={{ minWidth: 240 }}>
            {branchList.map((b: any) => <MenuItem key={b.id} value={b.id}>{b.name}</MenuItem>)}
          </TextField>
          <Button variant="contained" startIcon={<Add />} disabled={!branchId || mutation.isPending}
            onClick={() => mutation.mutate()}>
            Start Audit
          </Button>
        </Stack>
      </CardContent>
    </Card>
  );
}

function AuditDetail({ auditId, onBack }: { auditId: string; onBack: () => void }) {
  const { enqueueSnackbar } = useSnackbar();
  const qc = useQueryClient();
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const { data: audit, isLoading } = useQuery({
    queryKey: ['stock-audit', auditId],
    queryFn: () => apiGet<any>(`/tagging/audits/${auditId}`),
  });

  useEffect(() => { if (audit?.status === 'IN_PROGRESS') inputRef.current?.focus(); }, [audit?.status]);

  const { data: results, isFetching } = useQuery({
    queryKey: ['audit-scan-search', query],
    queryFn: () => apiGet<any[]>('/tagging/tags/search', { q: query, status: 'ALL' }),
    enabled: query.trim().length >= 1 && audit?.status === 'IN_PROGRESS',
  });
  const matches: any[] = results ?? [];

  const scanMutation = useMutation({
    mutationFn: (tagId: string) => apiPost<any>(`/tagging/audits/${auditId}/scan`, { tagId }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['stock-audit', auditId] });
      qc.invalidateQueries({ queryKey: ['stock-audits'] });
      setQuery('');
      inputRef.current?.focus();
    },
    onError: (e: any) => enqueueSnackbar(e.response?.data?.error ?? 'Failed to scan', { variant: 'error' }),
  });

  const completeMutation = useMutation({
    mutationFn: () => apiPost<any>(`/tagging/audits/${auditId}/complete`, {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['stock-audit', auditId] });
      qc.invalidateQueries({ queryKey: ['stock-audits'] });
      enqueueSnackbar('Audit completed', { variant: 'success' });
    },
    onError: (e: any) => enqueueSnackbar(e.response?.data?.error ?? 'Failed to complete audit', { variant: 'error' }),
  });

  // Auto-scan when exactly one match — the common case for a real barcode/tag-number scan.
  useEffect(() => {
    if (matches.length === 1 && audit?.status === 'IN_PROGRESS' && !scanMutation.isPending) {
      scanMutation.mutate(matches[0].id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matches, audit?.status]);

  if (isLoading || !audit) {
    return <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}><CircularProgress /></Box>;
  }

  const missing = audit.items.filter((i: any) => i.expected && !i.found);
  const unexpected = audit.items.filter((i: any) => !i.expected && i.found);
  const found = audit.items.filter((i: any) => i.found);

  return (
    <Box>
      <Button startIcon={<ArrowBack />} onClick={onBack} sx={{ mb: 2 }}>Back to Audits</Button>

      <Card sx={{ mb: 2 }}>
        <CardContent>
          <Stack direction="row" justifyContent="space-between" alignItems="center">
            <Box>
              <Typography variant="h6" fontWeight={700} sx={{ fontFamily: 'monospace', color: '#44C47A' }}>
                {audit.auditNumber}
              </Typography>
              <Typography variant="body2" color="text.secondary">
                {audit.branch?.name} · started by {audit.startedBy?.name} on {new Date(audit.startedAt).toLocaleString('en-IN')}
              </Typography>
            </Box>
            <StatusChip status={audit.status} size="medium" />
          </Stack>

          <Divider sx={{ my: 2 }} />

          <Grid container spacing={2}>
            <Grid item xs={6} sm={3}>
              <Typography variant="caption" color="text.secondary">Expected</Typography>
              <Typography variant="h5" fontWeight={900}>{audit.summary.expectedCount}</Typography>
            </Grid>
            <Grid item xs={6} sm={3}>
              <Typography variant="caption" color="text.secondary">Found</Typography>
              <Typography variant="h5" fontWeight={900} color="success.main">{audit.summary.foundCount}</Typography>
            </Grid>
            <Grid item xs={6} sm={3}>
              <Typography variant="caption" color="text.secondary">Missing</Typography>
              <Typography variant="h5" fontWeight={900} color={audit.summary.missingCount > 0 ? 'error.main' : 'text.primary'}>
                {audit.summary.missingCount}
              </Typography>
            </Grid>
            <Grid item xs={6} sm={3}>
              <Typography variant="caption" color="text.secondary">Unexpected</Typography>
              <Typography variant="h5" fontWeight={900} color={audit.summary.unexpectedCount > 0 ? 'warning.main' : 'text.primary'}>
                {audit.summary.unexpectedCount}
              </Typography>
            </Grid>
          </Grid>

          {audit.status === 'IN_PROGRESS' && (
            <>
              <Divider sx={{ my: 2 }} />
              <TextField
                inputRef={inputRef} fullWidth autoFocus
                placeholder="Scan barcode, or type tag number / name / HUID..."
                value={query} onChange={(e) => setQuery(e.target.value)}
                InputProps={{
                  startAdornment: <InputAdornment position="start"><QrCodeScanner /></InputAdornment>,
                  endAdornment: isFetching || scanMutation.isPending
                    ? <InputAdornment position="end"><CircularProgress size={18} /></InputAdornment> : undefined,
                }}
              />
              {query.trim().length >= 1 && matches.length > 1 && (
                <Box sx={{ mt: 1, maxHeight: 240, overflow: 'auto', border: '1px solid', borderColor: 'divider', borderRadius: 1 }}>
                  {matches.map((m: any) => (
                    <Box key={m.id} onClick={() => scanMutation.mutate(m.id)}
                      sx={{ p: 1, cursor: 'pointer', '&:hover': { bgcolor: 'action.hover' } }}>
                      <Stack direction="row" justifyContent="space-between">
                        <Typography variant="body2" sx={{ fontFamily: 'monospace' }}>{m.tagNumber} — {m.name}</Typography>
                        <StatusChip status={m.status} />
                      </Stack>
                    </Box>
                  ))}
                </Box>
              )}
              <Button variant="contained" color="success" startIcon={<CheckCircle />} sx={{ mt: 2 }}
                disabled={completeMutation.isPending} onClick={() => completeMutation.mutate()}>
                Complete Audit
              </Button>
            </>
          )}
        </CardContent>
      </Card>

      {audit.status === 'COMPLETED' && missing.length > 0 && (
        <Card sx={{ mb: 2 }}>
          <CardContent>
            <Typography variant="subtitle1" fontWeight={700} color="error.main" sx={{ mb: 1 }}>Missing</Typography>
            <Table size="small">
              <TableBody>
                {missing.map((i: any) => (
                  <TableRow key={i.id}>
                    <TableCell sx={{ fontFamily: 'monospace' }}>{i.tag.tagNumber}</TableCell>
                    <TableCell>{i.tag.name}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {audit.status === 'COMPLETED' && unexpected.length > 0 && (
        <Card sx={{ mb: 2 }}>
          <CardContent>
            <Typography variant="subtitle1" fontWeight={700} color="warning.main" sx={{ mb: 1 }}>Unexpected</Typography>
            <Table size="small">
              <TableBody>
                {unexpected.map((i: any) => (
                  <TableRow key={i.id}>
                    <TableCell sx={{ fontFamily: 'monospace' }}>{i.tag.tagNumber}</TableCell>
                    <TableCell>{i.tag.name}</TableCell>
                    <TableCell><StatusChip status={i.tag.status} /></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardContent>
          <Typography variant="subtitle1" fontWeight={700} sx={{ mb: 1 }}>Found ({found.length})</Typography>
          <Table size="small">
            <TableBody>
              {found.map((i: any) => (
                <TableRow key={i.id}>
                  <TableCell sx={{ fontFamily: 'monospace' }}>{i.tag.tagNumber}</TableCell>
                  <TableCell>{i.tag.name}</TableCell>
                  <TableCell sx={{ fontSize: 12 }}>{new Date(i.foundAt).toLocaleTimeString('en-IN')}</TableCell>
                </TableRow>
              ))}
              {found.length === 0 && <TableRow><TableCell align="center" sx={{ py: 3 }}>Nothing scanned yet</TableCell></TableRow>}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </Box>
  );
}

export function StockAudit() {
  const [selectedAuditId, setSelectedAuditId] = useState('');

  const { data: audits, isLoading } = useQuery({
    queryKey: ['stock-audits'],
    queryFn: () => apiGet<any[]>('/tagging/audits'),
  });
  const auditList: any[] = audits ?? [];

  if (selectedAuditId) {
    return (
      <Box>
        <PageHeader title="Stock Audit" />
        <AuditDetail auditId={selectedAuditId} onBack={() => setSelectedAuditId('')} />
      </Box>
    );
  }

  return (
    <Box>
      <PageHeader title="Stock Audit" />

      <StartAuditCard onStarted={setSelectedAuditId} />

      <Card>
        <Box sx={{ overflowX: 'auto' }}>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Audit #</TableCell>
                <TableCell>Branch</TableCell>
                <TableCell>Started</TableCell>
                <TableCell>Status</TableCell>
                <TableCell align="right">Expected</TableCell>
                <TableCell align="right">Found</TableCell>
                <TableCell align="right">Missing</TableCell>
                <TableCell align="right">Unexpected</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {isLoading ? (
                <TableRow><TableCell colSpan={8} align="center" sx={{ py: 4 }}>Loading...</TableCell></TableRow>
              ) : auditList.map((a: any) => (
                <TableRow key={a.id} hover sx={{ cursor: 'pointer' }} onClick={() => setSelectedAuditId(a.id)}>
                  <TableCell sx={{ fontFamily: 'monospace', fontWeight: 700, color: '#44C47A', fontSize: 12 }}>{a.auditNumber}</TableCell>
                  <TableCell>{a.branch?.name}</TableCell>
                  <TableCell sx={{ fontSize: 12 }}>{new Date(a.startedAt).toLocaleDateString('en-IN')}</TableCell>
                  <TableCell><StatusChip status={a.status} /></TableCell>
                  <TableCell align="right" sx={{ fontFamily: 'monospace' }}>{a.summary.expectedCount}</TableCell>
                  <TableCell align="right" sx={{ fontFamily: 'monospace' }}>{a.summary.foundCount}</TableCell>
                  <TableCell align="right">
                    {a.summary.missingCount > 0 ? <Chip label={a.summary.missingCount} size="small" color="error" /> : '—'}
                  </TableCell>
                  <TableCell align="right">
                    {a.summary.unexpectedCount > 0 ? <Chip label={a.summary.unexpectedCount} size="small" color="warning" /> : '—'}
                  </TableCell>
                </TableRow>
              ))}
              {!isLoading && auditList.length === 0 && (
                <TableRow><TableCell colSpan={8} align="center" sx={{ py: 4 }}>No stock audits yet</TableCell></TableRow>
              )}
            </TableBody>
          </Table>
        </Box>
      </Card>
    </Box>
  );
}
