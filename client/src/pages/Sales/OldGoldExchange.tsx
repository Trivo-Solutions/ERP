import { useMemo, useRef, useState } from 'react';
import {
  Box, Card, Table, TableHead, TableBody, TableRow, TableCell, Typography, Button, Grid, TextField,
  Dialog, DialogTitle, DialogContent, DialogActions, Chip,
} from '@mui/material';
import { Savings, FileDownload } from '@mui/icons-material';
import { useQuery } from '@tanstack/react-query';
import { apiGet } from '../../api/client';
import { PageHeader } from '../../components/common/PageHeader';
import { SelectField } from '../../components/fields/SelectField';
import { useAuthStore } from '../../store/auth.store';
import { exportToCsv } from '../../utils/exportToCsv';
import { MaterialPurchaseDialog } from './MaterialPurchaseDialog';
import {
  EMPTY_FILTERS, RegisterFilters, SUPPORTED_MATERIALS, PURCHASE_TYPES, purchaseTypeLabel, MATERIAL_PURCHASE_CSV_COLUMNS, buildListParams, materialLabel, purchaseDetailItems,
} from './materialPurchaseRegister';

const fmt = (n: number) => '₹' + Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });
const mono = { fontFamily: 'monospace' } as const;

// Material Purchase register (user-facing name for the OldGoldExchange rows that carry a tested-purity snapshot).
// New purchases go through the one existing MaterialPurchaseDialog -> createMaterialPurchase(); this page only lists,
// filters, inspects (read-only) and exports. Every figure is the server's stored value.
export function MaterialPurchaseTable({ rows, onOpen }: { rows: any[]; onOpen: (x: any) => void }) {
  return (
    <Card>
      <Box sx={{ overflowX: 'auto' }}>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>Date &amp; Time</TableCell>
              <TableCell>Purchase No.</TableCell>
              <TableCell>Customer</TableCell>
              <TableCell>Material</TableCell>
              <TableCell>Purchase Type</TableCell>
              <TableCell align="right">Gross Weight</TableCell>
              <TableCell align="right">Tested Purity</TableCell>
              <TableCell align="right">Fine Weight</TableCell>
              <TableCell align="right">Base Rate</TableCell>
              <TableCell align="right">Effective Rate</TableCell>
              <TableCell align="right">Purchase Value</TableCell>
              <TableCell align="right">Store Credit</TableCell>
              <TableCell>Branch</TableCell>
              <TableCell>Created By</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {rows.map((x) => (
              <TableRow key={x.id} hover sx={{ cursor: 'pointer' }} onClick={() => onOpen(x)}>
                <TableCell sx={{ fontSize: 12 }}>{new Date(x.createdAt ?? x.exchangeDate).toLocaleString('en-IN')}</TableCell>
                <TableCell sx={{ ...mono, fontWeight: 700, fontSize: 12 }}>{x.exchangeNumber}</TableCell>
                <TableCell>{x.client?.name}</TableCell>
                <TableCell>{materialLabel(x.metalType)}</TableCell>
                <TableCell>{purchaseTypeLabel(x)}</TableCell>
                <TableCell align="right" sx={mono}>{Number(x.grossWeight).toFixed(3)} g</TableCell>
                <TableCell align="right" sx={mono}>{Number(x.testedPurityPercent).toFixed(2)}%</TableCell>
                <TableCell align="right" sx={mono}>{Number(x.fineWeight).toFixed(4)} g</TableCell>
                <TableCell align="right" sx={mono}>{fmt(Number(x.baseRate24K))}</TableCell>
                <TableCell align="right" sx={mono}>{fmt(Number(x.effectivePurchaseRate))}</TableCell>
                <TableCell align="right" sx={{ ...mono, fontWeight: 700 }}>{fmt(Number(x.valuedAmount))}</TableCell>
                <TableCell align="right" sx={{ ...mono, color: x.reversedAt ? 'text.secondary' : 'success.main' }}>
                  {x.reversedAt ? 'Reversed' : fmt(Number(x.creditCreated ?? x.valuedAmount))}
                </TableCell>
                <TableCell>{x.branch?.name}</TableCell>
                <TableCell>{x.createdByName ?? '—'}</TableCell>
              </TableRow>
            ))}
            {rows.length === 0 && (
              <TableRow><TableCell colSpan={14} align="center" sx={{ py: 4 }}>No material purchases found</TableCell></TableRow>
            )}
          </TableBody>
        </Table>
      </Box>
    </Card>
  );
}

export function MaterialPurchaseDetails({ purchase, onClose }: { purchase: any | null; onClose: () => void }) {
  const x = purchase;
  const items = x ? purchaseDetailItems(x) : [];
  return (
    <Dialog open={!!x} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>Material Purchase {x?.exchangeNumber}</DialogTitle>
      <DialogContent>
        {x?.reversedAt && (
          <Chip color="warning" size="small" sx={{ mb: 1 }}
            label={`Reversed ${new Date(x.reversedAt).toLocaleString('en-IN')}${x.reversalReason ? ` — ${x.reversalReason}` : ''}`} />
        )}
        <Grid container spacing={1}>
          {items.map(([k, v]) => (
            <Grid item xs={12} sm={6} key={k}>
              <Typography variant="caption" color="text.secondary">{k}</Typography>
              <Typography variant="body2" sx={mono}>{v}</Typography>
            </Grid>
          ))}
        </Grid>
      </DialogContent>
      <DialogActions><Button onClick={onClose}>Close</Button></DialogActions>
    </Dialog>
  );
}

export function OldGoldExchange() {
  // Same gates as before: the page needs sales:view (route guard); buying needs invoice:create (POST permission).
  const canRecord = useAuthStore((s) => s.hasPermission('invoice:create'));
  const [filters, setFilters] = useState<RegisterFilters>(EMPTY_FILTERS);
  const [purchaseOpen, setPurchaseOpen] = useState(false);
  const [selected, setSelected] = useState<any | null>(null);
  const setF = (k: keyof RegisterFilters, v: string) => setFilters((p) => ({ ...p, [k]: v }));

  const params = buildListParams(filters);
  const { data } = useQuery({
    queryKey: ['material-purchases', params],
    queryFn: () => apiGet<any>('/sales/material-purchases', params),
  });
  const rows: any[] = (data as any)?.data ?? data ?? [];

  const { data: clients } = useQuery({ queryKey: ['clients-list'], queryFn: () => apiGet<any>('/orders/clients') });
  const clientList: any[] = (clients as any)?.clients ?? (clients as any)?.data ?? clients ?? [];
  const { data: branches } = useQuery({ queryKey: ['sales-branches'], queryFn: () => apiGet<any[]>('/sales/branches') });
  const branchList: any[] = (branches as any)?.data ?? branches ?? [];

  // Creators seen so far (a filtered list would otherwise shrink its own option list).
  const creators = useRef(new Map<string, string>());
  rows.forEach((r) => { if (r.createdById && r.createdByName) creators.current.set(r.createdById, r.createdByName); });
  const creatorOptions = useMemo(
    () => [...creators.current.entries()].map(([value, label]) => ({ value, label })),
    [rows], // eslint-disable-line react-hooks/exhaustive-deps
  );

  return (
    <Box>
      <PageHeader title="Material Purchase" subtitle="Material Purchase Register — history" actions={canRecord ? [
        { label: '+ New Material Purchase', icon: <Savings />, onClick: () => setPurchaseOpen(true) },
      ] : undefined} />
      {/* The one existing purchase dialog; it invalidates ['material-purchases'] itself, which refreshes this register. */}
      <MaterialPurchaseDialog open={purchaseOpen} onClose={() => setPurchaseOpen(false)} />
      <MaterialPurchaseDetails purchase={selected} onClose={() => setSelected(null)} />

      <Card sx={{ mb: 2, p: 2 }}>
        <Grid container spacing={1.5} alignItems="center">
          <Grid item xs={6} sm={3} md={2}>
            <TextField fullWidth size="small" type="date" label="Date From" value={filters.from}
              InputLabelProps={{ shrink: true }} onChange={(e) => setF('from', e.target.value)} />
          </Grid>
          <Grid item xs={6} sm={3} md={2}>
            <TextField fullWidth size="small" type="date" label="Date To" value={filters.to}
              InputLabelProps={{ shrink: true }} onChange={(e) => setF('to', e.target.value)} />
          </Grid>
          <Grid item xs={12} sm={6} md={2}>
            <SelectField size="small" label="Customer" value={filters.clientId} emptyLabel="All"
              onChange={(e) => setF('clientId', e.target.value)}
              options={clientList.map((c: any) => ({ value: c.id, label: `${c.clientCode} — ${c.name}` }))} />
          </Grid>
          <Grid item xs={6} sm={3} md={2}>
            <SelectField size="small" label="Material" value={filters.metalType} emptyLabel="All"
              onChange={(e) => setF('metalType', e.target.value)} options={SUPPORTED_MATERIALS} />
          </Grid>
          <Grid item xs={6} sm={3} md={2}>
            <SelectField size="small" label="Purchase Type" value={filters.purchaseType} emptyLabel="All"
              onChange={(e) => setF('purchaseType', e.target.value)} options={PURCHASE_TYPES} />
          </Grid>
          <Grid item xs={6} sm={3} md={2}>
            <SelectField size="small" label="Branch" value={filters.branchId} emptyLabel="All"
              onChange={(e) => setF('branchId', e.target.value)}
              options={branchList.map((b: any) => ({ value: b.id, label: b.name }))} />
          </Grid>
          <Grid item xs={6} sm={3} md={2}>
            <TextField fullWidth size="small" label="Purchase No." value={filters.exchangeNumber}
              InputLabelProps={{ shrink: true }} onChange={(e) => setF('exchangeNumber', e.target.value)} />
          </Grid>
          <Grid item xs={6} sm={3} md={2}>
            <SelectField size="small" label="Created By" value={filters.createdById} emptyLabel="All"
              onChange={(e) => setF('createdById', e.target.value)} options={creatorOptions} />
          </Grid>
          <Grid item xs="auto">
            <Button size="small" onClick={() => setFilters(EMPTY_FILTERS)}>Clear</Button>
          </Grid>
          <Grid item xs="auto">
            <Button size="small" variant="outlined" startIcon={<FileDownload />} disabled={rows.length === 0}
              onClick={() => exportToCsv('material-purchases', MATERIAL_PURCHASE_CSV_COLUMNS, rows)}>
              Export CSV
            </Button>
          </Grid>
        </Grid>
      </Card>

      <Typography variant="h6" sx={{ mb: 1 }}>Material Purchase History</Typography>
      <MaterialPurchaseTable rows={rows} onOpen={setSelected} />
    </Box>
  );
}
