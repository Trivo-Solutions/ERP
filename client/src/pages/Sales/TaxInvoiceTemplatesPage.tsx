import {
  Box, Card, Table, TableHead, TableBody, TableRow, TableCell, Chip, IconButton,
} from '@mui/material';
import { Add, Edit, ContentCopy } from '@mui/icons-material';
import { useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useSnackbar } from 'notistack';
import { apiGet, apiPost } from '../../api/client';
import { PageHeader } from '../../components/common/PageHeader';
import { PermissionGate } from '../../components/auth/PermissionGate';
import { useAuthStore } from '../../store/auth.store';

export function TaxInvoiceTemplatesPage() {
  const navigate = useNavigate();
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
        actions={hasPermission('taxInvoiceTemplate:create') ? [{ label: 'New Template', icon: <Add />, onClick: () => navigate('/sales/tax-invoice-templates/designer') }] : []} />

      <Card>
        <Box sx={{ overflowX: 'auto' }}>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Name</TableCell>
                <TableCell>Branch</TableCell>
                <TableCell>Default</TableCell>
                <TableCell>Format</TableCell>
                <TableCell>Status</TableCell>
                <TableCell />
              </TableRow>
            </TableHead>
            <TableBody>
              {isLoading ? (
                <TableRow><TableCell colSpan={6} align="center" sx={{ py: 4 }}>Loading...</TableCell></TableRow>
              ) : templates.map((t: any) => (
                <TableRow key={t.id} hover>
                  <TableCell sx={{ fontWeight: 600 }}>{t.name}</TableCell>
                  <TableCell>{t.branch?.name ?? 'Company-wide'}</TableCell>
                  <TableCell>{t.isDefault && <Chip label="Default" size="small" color="primary" />}</TableCell>
                  <TableCell>{t.layout?.elements ? 'Designer' : 'Checklist (legacy)'}</TableCell>
                  <TableCell><Chip label={t.isActive ? 'Active' : 'Inactive'} size="small" color={t.isActive ? 'success' : 'default'} /></TableCell>
                  <TableCell align="right">
                    <IconButton size="small" onClick={() => duplicate.mutate(t.id)} title="Duplicate"><ContentCopy fontSize="small" /></IconButton>
                    <PermissionGate permission="taxInvoiceTemplate:edit">
                      <IconButton size="small" onClick={() => navigate(`/sales/tax-invoice-templates/designer?id=${t.id}`)} title="Edit"><Edit fontSize="small" /></IconButton>
                    </PermissionGate>
                  </TableCell>
                </TableRow>
              ))}
              {!isLoading && templates.length === 0 && (
                <TableRow><TableCell colSpan={6} align="center" sx={{ py: 4 }}>
                  No custom templates yet — invoices print using the built-in default layout.
                </TableCell></TableRow>
              )}
            </TableBody>
          </Table>
        </Box>
      </Card>
    </Box>
  );
}
