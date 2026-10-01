import { useEffect, useState } from 'react';
import {
  Box, Card, Table, TableHead, TableBody, TableRow, TableCell, Button, Grid, Dialog,
  DialogTitle, DialogContent, DialogActions, TextField, Chip, Switch, FormControlLabel, IconButton,
  MenuItem, FormGroup, Checkbox, Typography, Divider,
} from '@mui/material';
import { Add, Edit, ContentCopy, Visibility } from '@mui/icons-material';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm, Controller } from 'react-hook-form';
import { useSnackbar } from 'notistack';
import { apiGet, apiPost, apiPut } from '../../api/client';
import { PageHeader } from '../../components/common/PageHeader';
import { PermissionGate } from '../../components/auth/PermissionGate';
import { useAuthStore } from '../../store/auth.store';
import { printInvoice } from '../../utils/printInvoice';

// G1 Part F/G/H/L — Tax Invoice Templates. A structured configuration editor (checkbox lists for
// which already-server-computed bound fields/columns show, in which sections), not a freeform
// drag-and-drop page builder — per the phase spec's own preference ("acceptable and preferable for
// G1"). Every checkbox option here is drawn from the SAME whitelist the server enforces at
// save-time (server/src/shared/taxInvoiceBoundFields.ts) — this page can only pick from
// already-computed values, never invent a new one.

const SELLER_FIELDS = ['seller.legalName', 'seller.tradeName', 'seller.gstin', 'seller.stateCode', 'seller.address', 'seller.city', 'seller.district', 'seller.pincode', 'seller.country'];
const BUYER_FIELDS = ['buyer.name', 'buyer.gstin', 'buyer.pan', 'buyer.address', 'buyer.city', 'buyer.state', 'buyer.stateCode', 'buyer.pincode', 'buyer.phone', 'buyer.email'];
const INVOICE_FIELDS = ['invoice.number', 'invoice.date', 'invoice.financialYear', 'invoice.type', 'invoice.placeOfSupply', 'invoice.reverseCharge', 'invoice.terms', 'invoice.salesPerson'];
const TOTALS_FIELDS = ['totals.subtotal', 'totals.taxableValue', 'totals.cgst', 'totals.sgst', 'totals.igst', 'totals.otherCharges', 'totals.discount', 'totals.roundOff', 'totals.grandTotal'];
const ITEM_COLUMNS = ['srNo', 'description', 'productCode', 'hsnCode', 'quantity', 'uom', 'grossWeight', 'stoneWeight', 'netWeight', 'rate', 'makingCharge', 'lineDiscountAmount', 'taxableValue', 'cgstAmount', 'sgstAmount', 'igstAmount', 'lineTotalTax', 'totalPrice'];

function labelize(f: string) {
  return f.split('.').pop()!.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase()).trim();
}

function CheckboxList({ options, value, onChange }: { options: string[]; value: string[]; onChange: (v: string[]) => void }) {
  return (
    <FormGroup row sx={{ gap: 0 }}>
      {options.map((opt) => (
        <FormControlLabel key={opt} sx={{ width: '33%', m: 0 }}
          control={<Checkbox size="small" checked={value.includes(opt)} onChange={(e) => {
            onChange(e.target.checked ? [...value, opt] : value.filter((v) => v !== opt));
          }} />}
          label={<Typography variant="body2">{labelize(opt)}</Typography>} />
      ))}
    </FormGroup>
  );
}

function sampleInvoice(layout: any) {
  return {
    invoiceNumber: 'INV-2026-000001', invoiceDate: new Date().toISOString(), invoiceType: 'RETAIL',
    subtotal: 50000, discountAmount: 500, otherCharges: 0, taxAmount: 1500, roundOff: 0.5, totalAmount: 51000.5,
    paidAmount: 51000.5, balanceDue: 0, terms: 'Payment due on receipt', notes: '',
    salesPerson: { name: 'Sample Sales Executive' },
    client: { name: 'Sample Customer', gstNumber: '27SAMPL1234E1Z9', panNumber: 'SAMPL1234E', address: 'Sample Address', city: 'Sample City', state: 'Maharashtra' },
    taxDetails: {
      gstin: '24SAMPLE1234F1Z5', placeOfSupply: '27', reverseCharge: false,
      taxableAmount: 49500, cgst: 750, sgst: 750, igst: 0, irn: null,
      sellerLegalName: 'Sample Jewellers Pvt Ltd', sellerTradeName: 'Sample Jewellers', sellerStateCode: '24',
      sellerAddress: '1 Sample Street', sellerCity: 'Sample City', sellerDistrict: 'Sample District', sellerPincode: '380001', sellerCountry: 'India',
      buyerName: 'Sample Customer', buyerGstin: '27SAMPL1234E1Z9', buyerPan: 'SAMPL1234E', buyerAddress: 'Sample Address',
      buyerCity: 'Sample City', buyerState: 'Maharashtra', buyerStateCode: '27',
    },
    items: [
      { description: 'Gold Ring 22K', productCode: 'RRNG00001', huid: 'AB12CD34', quantity: 1, netGoldWeight: 8.5,
        stoneWeight: 0, grossWeight: 8.5, uom: 'PCS', goldRate: 5800, makingCharge: 2000, taxRate: 0.03,
        taxableValue: 49500, lineDiscountAmount: 500, cgstAmount: 750, sgstAmount: 750, igstAmount: 0, lineTotalTax: 1500, totalPrice: 51000,
        hsnCode: { code: '7113' }, category: { name: 'Rings' } },
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
  const { data: defaultLayoutData } = useQuery({ queryKey: ['tax-invoice-template-default-layout'], queryFn: () => apiGet<any>('/sales/tax-invoice-templates/default-layout'), enabled: !isEdit });

  const [layout, setLayout] = useState<any>(template?.layout);

  useEffect(() => {
    if (!isEdit && (defaultLayoutData as any)?.data) setLayout((defaultLayoutData as any).data);
  }, [defaultLayoutData, isEdit]);

  const { control, handleSubmit } = useForm({
    defaultValues: {
      name: template?.name ?? '', description: template?.description ?? '', branchId: template?.branchId ?? '',
      isDefault: template?.isDefault ?? false, isActive: template?.isActive ?? true,
    },
  });

  const mutation = useMutation({
    mutationFn: (data: any) => {
      const body = { ...data, branchId: data.branchId || null, layout };
      return isEdit ? apiPut(`/sales/tax-invoice-templates/${template.id}`, body) : apiPost('/sales/tax-invoice-templates', body);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['tax-invoice-templates'] });
      enqueueSnackbar(isEdit ? 'Template updated' : 'Template created', { variant: 'success' });
      onClose();
    },
    onError: (e: any) => enqueueSnackbar(e.response?.data?.error ?? 'Failed', { variant: 'error' }),
  });

  if (!layout) return null;
  const sections = layout.sections;
  const set = (path: (s: any) => void) => setLayout((prev: any) => {
    const next = JSON.parse(JSON.stringify(prev));
    path(next);
    return next;
  });

  return (
    <Dialog open={open} onClose={onClose} maxWidth="md" fullWidth>
      <form onSubmit={handleSubmit((d) => mutation.mutate(d))}>
        <DialogTitle fontWeight={700}>{isEdit ? 'Edit Tax Invoice Template' : 'New Tax Invoice Template'}</DialogTitle>
        <DialogContent sx={{ pt: 2 }}>
          <Grid container spacing={2}>
            <Grid item xs={6}>
              <Controller name="name" control={control} rules={{ required: true }}
                render={({ field, fieldState }) => <TextField {...field} fullWidth label="Template Name" error={!!fieldState.error} />} />
            </Grid>
            <Grid item xs={6}>
              <Controller name="branchId" control={control}
                render={({ field }) => (
                  <TextField {...field} select fullWidth label="Branch (optional — leave blank for company-wide)">
                    <MenuItem value="">Company-wide</MenuItem>
                    {branches.map((b: any) => <MenuItem key={b.id} value={b.id}>{b.name}</MenuItem>)}
                  </TextField>
                )} />
            </Grid>
            <Grid item xs={12}>
              <Controller name="description" control={control}
                render={({ field }) => <TextField {...field} fullWidth label="Description (optional)" />} />
            </Grid>
            <Grid item xs={6}>
              <Controller name="isDefault" control={control}
                render={({ field }) => (
                  <FormControlLabel control={<Switch checked={field.value} onChange={(e) => field.onChange(e.target.checked)} />} label="Company Default" />
                )} />
            </Grid>
            {isEdit && (
              <Grid item xs={6}>
                <Controller name="isActive" control={control}
                  render={({ field }) => (
                    <FormControlLabel control={<Switch checked={field.value} onChange={(e) => field.onChange(e.target.checked)} />} label="Active" />
                  )} />
              </Grid>
            )}

            <Grid item xs={12}><Divider /></Grid>
            <Grid item xs={12}>
              <TextField fullWidth label="Document Title" value={sections.header.title}
                onChange={(e) => set((n) => { n.sections.header.title = e.target.value; })} />
            </Grid>

            <Grid item xs={12}><Typography variant="subtitle2" sx={{ mt: 1 }}>Seller Section</Typography></Grid>
            <Grid item xs={12}>
              <CheckboxList options={SELLER_FIELDS} value={sections.seller.fields}
                onChange={(v) => set((n) => { n.sections.seller.fields = v; })} />
            </Grid>

            <Grid item xs={12}><Typography variant="subtitle2" sx={{ mt: 1 }}>Buyer Section</Typography></Grid>
            <Grid item xs={12}>
              <CheckboxList options={BUYER_FIELDS} value={sections.buyer.fields}
                onChange={(v) => set((n) => { n.sections.buyer.fields = v; })} />
            </Grid>

            <Grid item xs={12}><Typography variant="subtitle2" sx={{ mt: 1 }}>Invoice Details</Typography></Grid>
            <Grid item xs={12}>
              <CheckboxList options={INVOICE_FIELDS} value={sections.invoiceMeta.fields}
                onChange={(v) => set((n) => { n.sections.invoiceMeta.fields = v; })} />
            </Grid>

            <Grid item xs={12}><Typography variant="subtitle2" sx={{ mt: 1 }}>Item Table Columns</Typography></Grid>
            <Grid item xs={12}>
              <CheckboxList options={ITEM_COLUMNS} value={sections.items.columns}
                onChange={(v) => set((n) => { n.sections.items.columns = v; })} />
            </Grid>

            <Grid item xs={12}><Typography variant="subtitle2" sx={{ mt: 1 }}>Totals</Typography></Grid>
            <Grid item xs={12}>
              <CheckboxList options={TOTALS_FIELDS} value={sections.totals.fields}
                onChange={(v) => set((n) => { n.sections.totals.fields = v; })} />
            </Grid>

            <Grid item xs={12}><Divider /></Grid>
            <Grid item xs={6}>
              <FormControlLabel control={<Switch checked={sections.eInvoice.enabled} onChange={(e) => set((n) => { n.sections.eInvoice.enabled = e.target.checked; })} />}
                label="Show e-Invoice section when an IRN exists" />
            </Grid>
            <Grid item xs={6}>
              <FormControlLabel control={<Switch checked={sections.footer.showSignatory} onChange={(e) => set((n) => { n.sections.footer.showSignatory = e.target.checked; })} />}
                label="Show Authorized Signatory line" />
            </Grid>
            <Grid item xs={12}>
              <TextField fullWidth multiline minRows={2} label="Footer / Terms text (optional)" value={sections.footer.termsText ?? ''}
                onChange={(e) => set((n) => { n.sections.footer.termsText = e.target.value; })} />
            </Grid>
          </Grid>
        </DialogContent>
        <DialogActions sx={{ p: 2.5 }}>
          <Button startIcon={<Visibility />} onClick={() => printInvoice(sampleInvoice(layout))}>Preview</Button>
          <Box sx={{ flex: 1 }} />
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="contained" disabled={mutation.isPending}>{isEdit ? 'Save' : 'Create'}</Button>
        </DialogActions>
      </form>
    </Dialog>
  );
}

export function TaxInvoiceTemplatesPage() {
  const [dialog, setDialog] = useState<{ open: boolean; template?: any }>({ open: false });
  const qc = useQueryClient();
  const { enqueueSnackbar } = useSnackbar();
  const { hasPermission } = useAuthStore();

  const { data, isLoading } = useQuery({ queryKey: ['tax-invoice-templates'], queryFn: () => apiGet<any>('/sales/tax-invoice-templates') });
  const templates: any[] = (data as any)?.data ?? data ?? [];

  const duplicate = useMutation({
    mutationFn: (id: string) => apiPost(`/sales/tax-invoice-templates/${id}/duplicate`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['tax-invoice-templates'] }); enqueueSnackbar('Template duplicated', { variant: 'success' }); },
    onError: (e: any) => enqueueSnackbar(e.response?.data?.error ?? 'Failed', { variant: 'error' }),
  });

  return (
    <Box>
      <PageHeader title="Tax Invoice Templates"
        actions={hasPermission('taxInvoiceTemplate:create') ? [{ label: 'New Template', icon: <Add />, onClick: () => setDialog({ open: true }) }] : []} />

      <Card>
        <Box sx={{ overflowX: 'auto' }}>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Name</TableCell>
                <TableCell>Branch</TableCell>
                <TableCell>Default</TableCell>
                <TableCell>Status</TableCell>
                <TableCell />
              </TableRow>
            </TableHead>
            <TableBody>
              {isLoading ? (
                <TableRow><TableCell colSpan={5} align="center" sx={{ py: 4 }}>Loading...</TableCell></TableRow>
              ) : templates.map((t: any) => (
                <TableRow key={t.id} hover>
                  <TableCell sx={{ fontWeight: 600 }}>{t.name}</TableCell>
                  <TableCell>{t.branch?.name ?? 'Company-wide'}</TableCell>
                  <TableCell>{t.isDefault && <Chip label="Default" size="small" color="primary" />}</TableCell>
                  <TableCell><Chip label={t.isActive ? 'Active' : 'Inactive'} size="small" color={t.isActive ? 'success' : 'default'} /></TableCell>
                  <TableCell align="right">
                    <IconButton size="small" onClick={() => duplicate.mutate(t.id)} title="Duplicate"><ContentCopy fontSize="small" /></IconButton>
                    <PermissionGate permission="taxInvoiceTemplate:edit">
                      <IconButton size="small" onClick={() => setDialog({ open: true, template: t })} title="Edit"><Edit fontSize="small" /></IconButton>
                    </PermissionGate>
                  </TableCell>
                </TableRow>
              ))}
              {!isLoading && templates.length === 0 && (
                <TableRow><TableCell colSpan={5} align="center" sx={{ py: 4 }}>
                  No custom templates yet — invoices print using the built-in default layout.
                </TableCell></TableRow>
              )}
            </TableBody>
          </Table>
        </Box>
      </Card>

      {dialog.open && <TemplateDialog open={dialog.open} template={dialog.template} onClose={() => setDialog({ open: false })} />}
    </Box>
  );
}
