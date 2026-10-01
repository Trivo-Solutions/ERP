import { useEffect, useState } from 'react';
import {
  Box, Card, Table, TableHead, TableBody, TableRow, TableCell, Button, Grid, Dialog,
  DialogTitle, DialogContent, DialogActions, TextField, Chip, Switch, FormControlLabel, IconButton,
  MenuItem, FormGroup, Checkbox, Typography, Divider, Stack,
} from '@mui/material';
import { Add, Edit, ContentCopy, Visibility } from '@mui/icons-material';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm, Controller } from 'react-hook-form';
import { useSnackbar } from 'notistack';
import { apiGet, apiPost, apiPut } from '../../api/client';
import { PageHeader } from '../../components/common/PageHeader';
import { PermissionGate } from '../../components/auth/PermissionGate';
import { useAuthStore } from '../../store/auth.store';
import { printCreditNote } from '../../utils/printCreditNote';

const SELLER_FIELDS = [
  'seller.legalName', 'seller.tradeName', 'seller.gstin', 'seller.stateCode',
  'seller.address', 'seller.city', 'seller.district', 'seller.pincode', 'seller.country',
];
const BUYER_FIELDS = [
  'buyer.name', 'buyer.gstin', 'buyer.pan', 'buyer.address', 'buyer.city',
  'buyer.state', 'buyer.stateCode', 'buyer.pincode', 'buyer.phone', 'buyer.email',
];
const REFERENCE_FIELDS = [
  'creditNote.number', 'creditNote.date', 'creditNote.status',
  'originalInvoice.number', 'originalInvoice.date', 'salesReturn.number',
  'creditNote.reasonCode', 'creditNote.reasonNotes',
];
const TOTALS_FIELDS = [
  'totals.taxableValue', 'totals.cgst', 'totals.sgst', 'totals.igst', 'totals.totalTax', 'totals.grandTotal',
];
const ITEM_COLUMNS = [
  'srNo', 'description', 'productCode', 'hsnCode', 'quantity', 'uom',
  'grossWeight', 'stoneWeight', 'netWeight', 'karat', 'taxRate',
  'taxableValue', 'cgstAmount', 'sgstAmount', 'igstAmount', 'lineTotalTax', 'totalValue',
];

function labelize(f: string) {
  return f.split('.').pop()!.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase()).trim();
}

function CheckboxList({ options, value, onChange }: { options: string[]; value: string[]; onChange: (v: string[]) => void }) {
  return (
    <FormGroup row sx={{ gap: 0 }}>
      {options.map((opt) => (
        <FormControlLabel
          key={opt}
          sx={{ width: { xs: '50%', sm: '33%' }, m: 0 }}
          control={
            <Checkbox
              size="small"
              checked={value.includes(opt)}
              onChange={(e) => {
                onChange(e.target.checked ? [...value, opt] : value.filter((v) => v !== opt));
              }}
            />
          }
          label={<Typography variant="body2">{labelize(opt)}</Typography>}
        />
      ))}
    </FormGroup>
  );
}

function sampleCreditNote(layout: any) {
  return {
    creditNoteNumber: 'CN-2026-000001',
    creditNoteDate: new Date().toISOString(),
    financialYear: 2026,
    status: 'ISSUED',
    originalInvoiceNumber: 'INV-2026-000042',
    originalInvoiceDate: new Date(Date.now() - 7 * 86400000).toISOString(),
    reasonCode: 'POST_SALE_DISCOUNT',
    reasonNotes: 'Agreed 5% festival discount adjustment',
    placeOfSupply: '24',
    taxableAmount: 10000,
    cgst: 150,
    sgst: 150,
    igst: 0,
    totalTax: 300,
    totalAmount: 10300,
    sellerLegalName: 'Sample Jewellers Pvt Ltd',
    sellerTradeName: 'Sample Jewellers',
    sellerStateCode: '24',
    sellerAddress: '1 Jewellery Street, Zaveri Bazaar',
    sellerCity: 'Ahmedabad',
    sellerDistrict: 'Ahmedabad',
    sellerPincode: '380001',
    gstin: '24SAMPLE1234F1Z5',
    buyerName: 'Sample Valued Customer',
    buyerGstin: '24CUST1234E1Z9',
    buyerPan: 'CUST1234E',
    buyerAddress: '42 Marine Drive',
    buyerCity: 'Ahmedabad',
    buyerState: 'Gujarat',
    client: { clientCode: 'CLT-0042', phone: '+91 98765 43210' },
    items: [
      {
        description: 'Gold Chain 22K (Discount Adjustment)',
        productCode: 'CHN001',
        karat: '22K',
        grossWeight: 12.5,
        netWeight: 12.5,
        uom: 'PCS',
        taxRate: 0.03,
        taxableValue: 10000,
        cgstAmount: 150,
        sgstAmount: 150,
        igstAmount: 0,
        totalValue: 10300,
        hsnCode: { code: '7113' },
      },
    ],
    printTemplate: layout,
  };
}

function TemplateDialog({ open, template, onClose }: { open: boolean; template?: any; onClose: () => void }) {
  const { enqueueSnackbar } = useSnackbar();
  const qc = useQueryClient();
  const isEdit = !!template;

  const { data: branchData } = useQuery({ queryKey: ['sales-branches'], queryFn: () => apiGet<any>('/sales/branches') });
  const branches: any[] = (branchData as any)?.data ?? branchData ?? [];
  const { data: defaultLayoutData } = useQuery({
    queryKey: ['credit-note-template-default-layout'],
    queryFn: () => apiGet<any>('/sales/credit-note-templates/default-layout'),
    enabled: !isEdit,
  });

  const [layout, setLayout] = useState<any>(template?.layout);

  useEffect(() => {
    if (!isEdit && (defaultLayoutData as any)?.data) setLayout((defaultLayoutData as any).data);
    else if (!isEdit && defaultLayoutData?.sections) setLayout(defaultLayoutData);
  }, [defaultLayoutData, isEdit]);

  const { control, handleSubmit } = useForm({
    defaultValues: {
      name: template?.name ?? '',
      description: template?.description ?? '',
      branchId: template?.branchId ?? '',
      isDefault: template?.isDefault ?? false,
      isActive: template?.isActive ?? true,
    },
  });

  const mutation = useMutation({
    mutationFn: (data: any) => {
      const body = { ...data, branchId: data.branchId || null, layout };
      return isEdit
        ? apiPut(`/sales/credit-note-templates/${template.id}`, body)
        : apiPost('/sales/credit-note-templates', body);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['credit-note-templates'] });
      enqueueSnackbar(isEdit ? 'Template updated' : 'Template created', { variant: 'success' });
      onClose();
    },
    onError: (e: any) => enqueueSnackbar(e.response?.data?.error ?? 'Save failed', { variant: 'error' }),
  });

  if (!layout) return null;

  const updateSection = (sec: string, field: string, val: any) => {
    setLayout((prev: any) => ({
      ...prev,
      sections: {
        ...prev.sections,
        [sec]: {
          ...prev.sections?.[sec],
          [field]: val,
        },
      },
    }));
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="md" fullWidth>
      <DialogTitle>{isEdit ? 'Edit Credit Note Template' : 'New Credit Note Template'}</DialogTitle>
      <form onSubmit={handleSubmit((d) => mutation.mutate(d))}>
        <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 2.5 }}>
          <Grid container spacing={2}>
            <Grid item xs={12} sm={6}>
              <Controller
                name="name"
                control={control}
                rules={{ required: true }}
                render={({ field }) => <TextField {...field} label="Template Name" size="small" fullWidth required />}
              />
            </Grid>
            <Grid item xs={12} sm={6}>
              <Controller
                name="branchId"
                control={control}
                render={({ field }) => (
                  <TextField {...field} select label="Branch Scope" size="small" fullWidth helperText="Leave empty for Company-wide">
                    <MenuItem value="">Company-wide</MenuItem>
                    {branches.map((b) => (
                      <MenuItem key={b.id} value={b.id}>
                        {b.name}
                      </MenuItem>
                    ))}
                  </TextField>
                )}
              />
            </Grid>
            <Grid item xs={12}>
              <Controller
                name="description"
                control={control}
                render={({ field }) => <TextField {...field} label="Description" size="small" fullWidth />}
              />
            </Grid>
            <Grid item xs={6}>
              <Controller
                name="isDefault"
                control={control}
                render={({ field: { value, onChange } }) => (
                  <FormControlLabel control={<Switch checked={value} onChange={onChange} />} label="Company Default Template" />
                )}
              />
            </Grid>
            <Grid item xs={6}>
              <Controller
                name="isActive"
                control={control}
                render={({ field: { value, onChange } }) => (
                  <FormControlLabel control={<Switch checked={value} onChange={onChange} />} label="Active" />
                )}
              />
            </Grid>
          </Grid>

          <Divider />
          <Typography variant="subtitle2" fontWeight={700}>
            Section 1: Header & Company Details
          </Typography>
          <TextField
            size="small"
            label="Document Header Title"
            value={layout.sections?.header?.title ?? 'Credit Note'}
            onChange={(e) => updateSection('header', 'title', e.target.value)}
          />
          <CheckboxList
            options={SELLER_FIELDS}
            value={layout.sections?.seller?.fields ?? []}
            onChange={(v) => updateSection('seller', 'fields', v)}
          />

          <Divider />
          <Typography variant="subtitle2" fontWeight={700}>
            Section 2: Customer (Bill To)
          </Typography>
          <CheckboxList
            options={BUYER_FIELDS}
            value={layout.sections?.buyer?.fields ?? []}
            onChange={(v) => updateSection('buyer', 'fields', v)}
          />

          <Divider />
          <Typography variant="subtitle2" fontWeight={700}>
            Section 3: Reference & Statutory
          </Typography>
          <CheckboxList
            options={REFERENCE_FIELDS}
            value={layout.sections?.reference?.fields ?? []}
            onChange={(v) => updateSection('reference', 'fields', v)}
          />

          <Divider />
          <Typography variant="subtitle2" fontWeight={700}>
            Section 4: Item Table Columns
          </Typography>
          <CheckboxList
            options={ITEM_COLUMNS}
            value={layout.sections?.items?.columns ?? []}
            onChange={(v) => updateSection('items', 'columns', v)}
          />

          <Divider />
          <Typography variant="subtitle2" fontWeight={700}>
            Section 5: Totals & Tax Summary
          </Typography>
          <CheckboxList
            options={TOTALS_FIELDS}
            value={layout.sections?.totals?.fields ?? []}
            onChange={(v) => updateSection('totals', 'fields', v)}
          />

          <Divider />
          <Typography variant="subtitle2" fontWeight={700}>
            Section 6: Terms & Signatory
          </Typography>
          <TextField
            size="small"
            fullWidth
            label="Statutory Terms / Remarks Text"
            value={layout.sections?.footer?.termsText ?? ''}
            onChange={(e) => updateSection('footer', 'termsText', e.target.value)}
          />
          <FormControlLabel
            control={
              <Switch
                checked={layout.sections?.footer?.showSignatory !== false}
                onChange={(e) => updateSection('footer', 'showSignatory', e.target.checked)}
              />
            }
            label="Show Authorized Signatory Box"
          />
        </DialogContent>
        <DialogActions sx={{ p: 2, justifyContent: 'space-between' }}>
          <Button startIcon={<Visibility />} onClick={() => printCreditNote(sampleCreditNote(layout))}>
            Preview Layout
          </Button>
          <Stack direction="row" spacing={1}>
            <Button onClick={onClose}>Cancel</Button>
            <Button type="submit" variant="contained" disabled={mutation.isPending}>
              Save Template
            </Button>
          </Stack>
        </DialogActions>
      </form>
    </Dialog>
  );
}

export function CreditNoteTemplatesPage() {
  const { enqueueSnackbar } = useSnackbar();
  const qc = useQueryClient();
  const hasPermission = useAuthStore((s) => s.hasPermission);

  const [dialog, setDialog] = useState<{ open: boolean; template?: any }>({ open: false });

  const { data: templatesData, isLoading } = useQuery({
    queryKey: ['credit-note-templates'],
    queryFn: () => apiGet<any[]>('/sales/credit-note-templates'),
  });

  const templates: any[] = (templatesData as any)?.data ?? templatesData ?? [];

  const duplicateMutation = useMutation({
    mutationFn: (id: string) => apiPost(`/sales/credit-note-templates/${id}/duplicate`, {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['credit-note-templates'] });
      enqueueSnackbar('Template duplicated', { variant: 'success' });
    },
    onError: (e: any) => enqueueSnackbar(e.response?.data?.error ?? 'Duplicate failed', { variant: 'error' }),
  });

  return (
    <Box>
      <PageHeader
        title="Credit Note Templates"
        subtitle="Configure presentation layouts for Credit Note printing"
        actions={
          hasPermission('creditNoteTemplate:create')
            ? [{ label: 'New Template', icon: <Add />, onClick: () => setDialog({ open: true }) }]
            : []
        }
      />

      <Card sx={{ mt: 2 }}>
        <Table size="small">
          <TableHead sx={{ bgcolor: '#F8F9FA' }}>
            <TableRow>
              <TableCell sx={{ fontWeight: 700 }}>Name</TableCell>
              <TableCell sx={{ fontWeight: 700 }}>Branch</TableCell>
              <TableCell sx={{ fontWeight: 700 }}>Default</TableCell>
              <TableCell sx={{ fontWeight: 700 }}>Active</TableCell>
              <TableCell sx={{ fontWeight: 700 }}>Description</TableCell>
              <TableCell align="right" sx={{ fontWeight: 700 }}>Actions</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {isLoading && (
              <TableRow>
                <TableCell colSpan={6} align="center" sx={{ py: 4 }}>
                  Loading templates...
                </TableCell>
              </TableRow>
            )}
            {!isLoading && templates.length === 0 && (
              <TableRow>
                <TableCell colSpan={6} align="center" sx={{ py: 4, color: 'text.secondary' }}>
                  No custom templates configured. The safe built-in fallback layout is currently in use.
                </TableCell>
              </TableRow>
            )}
            {templates.map((t) => (
              <TableRow key={t.id}>
                <TableCell sx={{ fontWeight: 600 }}>{t.name}</TableCell>
                <TableCell>{t.branch?.name ?? <Typography variant="caption" color="text.secondary">Company-wide</Typography>}</TableCell>
                <TableCell>{t.isDefault ? <Chip label="Default" size="small" color="success" /> : '—'}</TableCell>
                <TableCell>{t.isActive ? <Chip label="Active" size="small" color="primary" /> : <Chip label="Inactive" size="small" />}</TableCell>
                <TableCell sx={{ fontSize: 12, color: 'text.secondary' }}>{t.description || '—'}</TableCell>
                <TableCell align="right">
                  <Stack direction="row" spacing={0.5} justifyContent="flex-end">
                    <IconButton size="small" title="Preview" onClick={() => printCreditNote(sampleCreditNote(t.layout))}>
                      <Visibility fontSize="small" />
                    </IconButton>
                    <PermissionGate permission="creditNoteTemplate:create">
                      <IconButton size="small" title="Duplicate" onClick={() => duplicateMutation.mutate(t.id)}>
                        <ContentCopy fontSize="small" />
                      </IconButton>
                    </PermissionGate>
                    <PermissionGate permission="creditNoteTemplate:edit">
                      <IconButton size="small" title="Edit" onClick={() => setDialog({ open: true, template: t })}>
                        <Edit fontSize="small" />
                      </IconButton>
                    </PermissionGate>
                  </Stack>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>

      {dialog.open && (
        <TemplateDialog
          open={dialog.open}
          template={dialog.template}
          onClose={() => setDialog({ open: false })}
        />
      )}
    </Box>
  );
}
