// Shared base pattern for list+create pages
import { useState } from 'react';
import { Box, Card, Table, TableHead, TableBody, TableRow, TableCell, Typography, Button, TextField, MenuItem, Grid, Dialog, DialogTitle, DialogContent, DialogActions } from '@mui/material';
import { Add } from '@mui/icons-material';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { useSnackbar } from 'notistack';
import { apiGet, apiPost } from '../../api/client';
import { PageHeader } from '../../components/common/PageHeader';
import { StatusChip } from '../../components/common/StatusChip';

export interface ColumnDef {
  key: string;
  label: string;
  render?: (row: any) => React.ReactNode;
  mono?: boolean;
}

interface Props {
  title: string;
  subtitle?: string;
  apiPath: string;
  queryKey: string;
  columns: ColumnDef[];
  createForm?: React.ReactNode;
  createTitle?: string;
  breadcrumbs?: Array<{ label: string; path?: string }>;
  filterBar?: React.ReactNode;
}

export function ModulePage({ title, subtitle, apiPath, queryKey, columns, createForm, createTitle, breadcrumbs, filterBar }: Props) {
  const { enqueueSnackbar } = useSnackbar();
  const [createOpen, setCreateOpen] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: [queryKey],
    queryFn: () => apiGet<any>(apiPath),
  });

  const rows: any[] = Array.isArray(data) ? data : (data as any)?.data ?? [];

  return (
    <Box>
      <PageHeader
        title={title}
        subtitle={subtitle}
        breadcrumbs={breadcrumbs}
        actions={createForm ? [{ label: createTitle ?? 'Create New', icon: <Add />, onClick: () => setCreateOpen(true) }] : []}
      />

      {filterBar && <Card sx={{ mb: 2, p: 1.5 }}>{filterBar}</Card>}

      <Card>
        <Table size="small">
          <TableHead>
            <TableRow>
              {columns.map((col) => <TableCell key={col.key}>{col.label}</TableCell>)}
            </TableRow>
          </TableHead>
          <TableBody>
            {isLoading ? (
              <TableRow><TableCell colSpan={columns.length} align="center" sx={{ py: 4 }}>Loading...</TableCell></TableRow>
            ) : rows.length === 0 ? (
              <TableRow><TableCell colSpan={columns.length} align="center" sx={{ py: 4 }}>No records found</TableCell></TableRow>
            ) : rows.map((row: any) => (
              <TableRow key={row.id} hover>
                {columns.map((col) => (
                  <TableCell key={col.key} sx={{ fontFamily: col.mono ? 'monospace' : undefined, fontSize: col.mono ? 12 : undefined }}>
                    {col.render ? col.render(row) : row[col.key] ?? '—'}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>

      {createForm && (
        <Dialog open={createOpen} onClose={() => setCreateOpen(false)} maxWidth="sm" fullWidth>
          <DialogTitle fontWeight={700}>{createTitle ?? 'Create New'}</DialogTitle>
          <DialogContent sx={{ pt: 2 }}>{createForm}</DialogContent>
          <DialogActions sx={{ p: 2.5 }}>
            <Button onClick={() => setCreateOpen(false)}>Cancel</Button>
          </DialogActions>
        </Dialog>
      )}
    </Box>
  );
}
