import { Box, Card, Table, TableHead, TableBody, TableRow, TableCell, Chip, Tab, Tabs } from '@mui/material';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { apiGet } from '../../api/client';
import { PageHeader } from '../../components/common/PageHeader';

// Roles & Permissions moved out to its own dedicated page (Management > Roles & Permissions,
// /settings/roles + /settings/roles/:id/edit) — see RolesListPage.tsx / RoleEditorPage.tsx.
export function SettingsPage() {
  const [tab, setTab] = useState(0);
  const { data: tolerances } = useQuery({ queryKey: ['tolerances'], queryFn: () => apiGet<any[]>('/settings/process-tolerances') });
  const { data: categories } = useQuery({ queryKey: ['design-categories'], queryFn: () => apiGet<any[]>('/settings/design-categories') });
  const { data: auditLogs } = useQuery({ queryKey: ['audit-logs'], queryFn: () => apiGet<any[]>('/settings/audit-logs') });

  return (
    <Box>
      <PageHeader title="System Settings" />

      <Tabs value={tab} onChange={(_, v) => setTab(v)} sx={{ mb: 2 }}>
        <Tab label="Process Tolerances" />
        <Tab label="Design Categories" />
        <Tab label="Audit Log" />
      </Tabs>

      {tab === 0 && (
        <Card>
          <Table size="small">
            <TableHead><TableRow><TableCell>Process</TableCell><TableCell align="right">Max Loss %</TableCell><TableCell align="right">Deduction Rate (₹/g)</TableCell><TableCell align="right">Alert Threshold %</TableCell></TableRow></TableHead>
            <TableBody>
              {(tolerances ?? []).map((t: any) => (
                <TableRow key={t.id} hover>
                  <TableCell sx={{ fontWeight: 600 }}>{t.processName}</TableCell>
                  <TableCell align="right" sx={{ fontFamily: 'monospace', color: '#E65100', fontWeight: 700 }}>{Number(t.maxLossPercent).toFixed(2)}%</TableCell>
                  <TableCell align="right" sx={{ fontFamily: 'monospace' }}>₹{Number(t.deductionRate).toFixed(2)}</TableCell>
                  <TableCell align="right" sx={{ fontFamily: 'monospace' }}>{Number(t.alertThreshold).toFixed(2)}%</TableCell>
                </TableRow>
              ))}
              {!tolerances?.length && <TableRow><TableCell colSpan={4} align="center" sx={{ py: 3, color: 'text.secondary' }}>No tolerances configured. Set up in system config.</TableCell></TableRow>}
            </TableBody>
          </Table>
        </Card>
      )}

      {tab === 1 && (
        <Card>
          <Table size="small">
            <TableHead><TableRow><TableCell>Code</TableCell><TableCell>Category Name</TableCell></TableRow></TableHead>
            <TableBody>
              {(categories ?? []).map((c: any) => (
                <TableRow key={c.id} hover>
                  <TableCell sx={{ fontFamily: 'monospace', fontWeight: 700, color: '#44C47A' }}>{c.code}</TableCell>
                  <TableCell>{c.name}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}

      {tab === 2 && (
        <Card>
          <Table size="small">
            <TableHead><TableRow><TableCell>Timestamp</TableCell><TableCell>User</TableCell><TableCell>Table</TableCell><TableCell>Record ID</TableCell><TableCell>Action</TableCell></TableRow></TableHead>
            <TableBody>
              {(auditLogs ?? []).map((log: any) => (
                <TableRow key={log.id} hover>
                  <TableCell sx={{ fontSize: 11, fontFamily: 'monospace' }}>{new Date(log.timestamp).toLocaleString('en-IN')}</TableCell>
                  <TableCell sx={{ fontSize: 12 }}>{log.user?.name}</TableCell>
                  <TableCell sx={{ fontFamily: 'monospace', fontSize: 11 }}>{log.tableName}</TableCell>
                  <TableCell sx={{ fontFamily: 'monospace', fontSize: 10 }}>{log.recordId.slice(0, 12)}…</TableCell>
                  <TableCell><Chip label={log.action} size="small" color={log.action === 'CREATE' ? 'success' : log.action === 'DELETE' ? 'error' : 'warning'} /></TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}
    </Box>
  );
}
