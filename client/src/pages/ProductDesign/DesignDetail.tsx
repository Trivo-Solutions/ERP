import { useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  Box, Card, CardContent, Typography, Grid, Button, Chip, Tabs, Tab,
  Table, TableHead, TableBody, TableRow, TableCell, Alert, Divider,
  TextField, MenuItem, IconButton, Tooltip,
} from '@mui/material';
import { Add, Delete, Calculate, CheckCircle, Print } from '@mui/icons-material';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useSnackbar } from 'notistack';
import { apiGet, apiPost, apiPatch } from '../../api/client';
import { PageHeader } from '../../components/common/PageHeader';
import { StatusChip } from '../../components/common/StatusChip';
import { printEstimate } from '../../utils/printEstimate';

const PROCESSES = ['MELTING', 'CASTING', 'FILING', 'PRE_POLISH', 'SETTING', 'POLISH', 'RHODIUM'];
const MATERIAL_TYPES = ['METAL', 'DIAMOND', 'COLORED_STONE', 'FINDING'];
const CHARGE_TYPES = ['PER_GRAM', 'PER_PIECE', 'FIXED'];

export function DesignDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { enqueueSnackbar } = useSnackbar();
  const qc = useQueryClient();
  const [tab, setTab] = useState(0);

  const { data: design, isLoading } = useQuery({
    queryKey: ['design', id],
    queryFn: () => apiGet<any>(`/designs/${id}`),
  });

  const estimateMutation = useMutation({
    mutationFn: () => apiPost(`/designs/${id}/estimate`),
    onSuccess: (data: any) => {
      qc.invalidateQueries({ queryKey: ['design', id] });
      enqueueSnackbar(`Estimate generated: ₹${Number(data.sellingPrice).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`, { variant: 'success' });
    },
    onError: () => enqueueSnackbar('Failed to generate estimate', { variant: 'error' }),
  });

  const approveMutation = useMutation({
    mutationFn: () => apiPatch(`/designs/${id}`, { status: 'APPROVED' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['design', id] });
      enqueueSnackbar('Design approved', { variant: 'success' });
    },
  });

  if (isLoading) return <Typography>Loading...</Typography>;
  if (!design) return <Alert severity="error">Design not found</Alert>;

  return (
    <Box>
      <PageHeader
        title={design.name}
        subtitle={`Design Code: ${design.designCode} | Karat: ${design.metalKarat}`}
        breadcrumbs={[{ label: 'Designs', path: '/designs' }, { label: design.name }]}
        actions={[
          ...(design.status !== 'APPROVED' ? [{
            label: 'Approve Design',
            icon: <CheckCircle />,
            onClick: () => approveMutation.mutate(),
            variant: 'outlined' as const,
            color: 'success' as const,
          }] : []),
          {
            label: 'Generate Estimate',
            icon: <Calculate />,
            onClick: () => estimateMutation.mutate(),
            variant: 'contained' as const,
          },
        ]}
      />

      {/* Summary Card */}
      <Grid container spacing={2} sx={{ mb: 2 }}>
        <Grid item xs={12} sm={3}>
          <Card>
            <CardContent sx={{ p: 2 }}>
              <Typography variant="caption" color="text.secondary">Status</Typography>
              <Box sx={{ mt: 0.5 }}><StatusChip status={design.status} size="medium" /></Box>
            </CardContent>
          </Card>
        </Grid>
        <Grid item xs={12} sm={3}>
          <Card>
            <CardContent sx={{ p: 2 }}>
              <Typography variant="caption" color="text.secondary">Net Weight Range</Typography>
              <Typography variant="h6" fontWeight={700} sx={{ fontFamily: 'monospace', color: '#44C47A' }}>
                {Number(design.netWeightMin).toFixed(3)}–{Number(design.netWeightMax).toFixed(3)} g
              </Typography>
            </CardContent>
          </Card>
        </Grid>
        <Grid item xs={12} sm={3}>
          <Card>
            <CardContent sx={{ p: 2 }}>
              <Typography variant="caption" color="text.secondary">BOM Items</Typography>
              <Typography variant="h6" fontWeight={700}>{design.bomItems?.length ?? 0}</Typography>
            </CardContent>
          </Card>
        </Grid>
        <Grid item xs={12} sm={3}>
          <Card>
            <CardContent sx={{ p: 2 }}>
              <Typography variant="caption" color="text.secondary">Processes</Typography>
              <Typography variant="h6" fontWeight={700}>{design.bomProcesses?.length ?? 0}</Typography>
            </CardContent>
          </Card>
        </Grid>
      </Grid>

      <Card>
        <Tabs value={tab} onChange={(_, v) => setTab(v)} sx={{ borderBottom: 1, borderColor: 'divider', px: 2 }}>
          <Tab label="Bill of Materials" />
          <Tab label="Process Routing" />
          <Tab label="Cost Estimates" />
          <Tab label="Files / CAD" />
        </Tabs>

        {/* BOM */}
        {tab === 0 && (
          <CardContent>
            <Box sx={{ overflowX: 'auto' }}>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>#</TableCell>
                  <TableCell>Material Type</TableCell>
                  <TableCell>Code / Name</TableCell>
                  <TableCell>Quantity</TableCell>
                  <TableCell>Unit</TableCell>
                  <TableCell>Karat</TableCell>
                  <TableCell>Quality</TableCell>
                  <TableCell>Wastage %</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {(design.bomItems ?? []).map((item: any, i: number) => (
                  <TableRow key={item.id} hover>
                    <TableCell>{i + 1}</TableCell>
                    <TableCell><Chip label={item.materialType} size="small" /></TableCell>
                    <TableCell>
                      <Typography sx={{ fontFamily: 'monospace', fontSize: 13 }}>{item.materialCode}</Typography>
                      <Typography variant="caption" color="text.secondary">{item.materialName}</Typography>
                    </TableCell>
                    <TableCell sx={{ fontFamily: 'monospace' }}>{Number(item.quantity).toFixed(4)}</TableCell>
                    <TableCell>{item.unit}</TableCell>
                    <TableCell>{item.karat ?? '—'}</TableCell>
                    <TableCell>{item.quality ?? '—'}</TableCell>
                    <TableCell sx={{ color: Number(item.wastagePercent) > 3 ? 'error.main' : 'inherit' }}>
                      {Number(item.wastagePercent).toFixed(2)}%
                    </TableCell>
                  </TableRow>
                ))}
                {(design.bomItems ?? []).length === 0 && (
                  <TableRow><TableCell colSpan={8} align="center" sx={{ py: 3 }}>
                    No BOM items defined. Go to BOM Manager to configure.
                  </TableCell></TableRow>
                )}
              </TableBody>
            </Table>
            </Box>
          </CardContent>
        )}

        {/* Processes */}
        {tab === 1 && (
          <CardContent>
            <Box sx={{ overflowX: 'auto' }}>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>Seq</TableCell>
                  <TableCell>Process</TableCell>
                  <TableCell>Making Charge Type</TableCell>
                  <TableCell>Rate</TableCell>
                  <TableCell>Wastage %</TableCell>
                  <TableCell>Est. Time</TableCell>
                  <TableCell>Outsourced</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {(design.bomProcesses ?? []).map((proc: any) => (
                  <TableRow key={proc.id} hover>
                    <TableCell>
                      <Chip label={proc.sequence} size="small" sx={{ width: 32, height: 24 }} />
                    </TableCell>
                    <TableCell sx={{ fontWeight: 600 }}>{proc.processName}</TableCell>
                    <TableCell>{proc.makingChargeType}</TableCell>
                    <TableCell sx={{ fontFamily: 'monospace' }}>₹{Number(proc.makingChargeValue).toFixed(2)}</TableCell>
                    <TableCell>{Number(proc.wastagePercent).toFixed(2)}%</TableCell>
                    <TableCell>{proc.estimatedMinutes ? `${proc.estimatedMinutes} min` : '—'}</TableCell>
                    <TableCell>
                      <Chip label={proc.isOutsourced ? 'Yes' : 'No'} size="small"
                        color={proc.isOutsourced ? 'warning' : 'default'} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            </Box>
          </CardContent>
        )}

        {/* Estimates */}
        {tab === 2 && (
          <CardContent>
            {(design.costEstimates ?? []).length === 0 ? (
              <Box sx={{ textAlign: 'center', py: 4 }}>
                <Typography color="text.secondary" gutterBottom>No estimates generated yet</Typography>
                <Button variant="contained" startIcon={<Calculate />} onClick={() => estimateMutation.mutate()}>
                  Generate Now
                </Button>
              </Box>
            ) : (
              <Box sx={{ overflowX: 'auto' }}>
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>Estimate #</TableCell>
                    <TableCell>Metal Spot Rate</TableCell>
                    <TableCell>Metal Cost</TableCell>
                    <TableCell>Stone Cost</TableCell>
                    <TableCell>Making</TableCell>
                    <TableCell>Wastage</TableCell>
                    <TableCell>Total Cost</TableCell>
                    <TableCell>Selling Price</TableCell>
                    <TableCell>Valid Until</TableCell>
                    <TableCell align="center">Print</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {design.costEstimates.map((est: any) => (
                    <TableRow key={est.id} hover>
                      <TableCell sx={{ fontFamily: 'monospace', fontSize: 12 }}>{est.estimateNumber}</TableCell>
                      <TableCell sx={{ fontFamily: 'monospace' }}>₹{Number(est.metalSpotRate).toFixed(2)}/g</TableCell>
                      <TableCell sx={{ fontFamily: 'monospace' }}>₹{Number(est.metalCost).toFixed(2)}</TableCell>
                      <TableCell sx={{ fontFamily: 'monospace' }}>₹{Number(est.stoneCost).toFixed(2)}</TableCell>
                      <TableCell sx={{ fontFamily: 'monospace' }}>₹{Number(est.makingCharges).toFixed(2)}</TableCell>
                      <TableCell sx={{ fontFamily: 'monospace' }}>₹{Number(est.wastageAmount).toFixed(2)}</TableCell>
                      <TableCell sx={{ fontFamily: 'monospace', fontWeight: 700 }}>₹{Number(est.totalCost).toFixed(2)}</TableCell>
                      <TableCell sx={{ fontFamily: 'monospace', fontWeight: 700, color: '#44C47A' }}>
                        ₹{Number(est.sellingPrice).toFixed(2)}
                      </TableCell>
                      <TableCell sx={{ fontSize: 12 }}>{new Date(est.validUntil).toLocaleDateString()}</TableCell>
                      <TableCell align="center">
                        <Tooltip title="Print / Save as PDF">
                          <IconButton
                            size="small"
                            onClick={() => printEstimate(est, design)}
                            sx={{ color: '#44C47A' }}
                          >
                            <Print fontSize="small" />
                          </IconButton>
                        </Tooltip>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              </Box>
            )}
          </CardContent>
        )}

        {/* Files */}
        {tab === 3 && (
          <CardContent>
            <Box sx={{ display: 'flex', gap: 1, mb: 2 }}>
              <Button variant="outlined" size="small" startIcon={<Add />}>Upload CAD File</Button>
              <Button variant="outlined" size="small" startIcon={<Add />}>Upload 3D Render</Button>
            </Box>
            {(design.designFiles ?? []).length === 0 ? (
              <Typography color="text.secondary" sx={{ textAlign: 'center', py: 4 }}>
                No files uploaded. Upload .stl, .3dm, renders, or sketches.
              </Typography>
            ) : (
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>File Name</TableCell>
                    <TableCell>Type</TableCell>
                    <TableCell>Version</TableCell>
                    <TableCell>Uploaded</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {design.designFiles.map((f: any) => (
                    <TableRow key={f.id} hover>
                      <TableCell>{f.fileName}</TableCell>
                      <TableCell><Chip label={f.fileType} size="small" /></TableCell>
                      <TableCell>v{f.version}</TableCell>
                      <TableCell sx={{ fontSize: 12 }}>{new Date(f.uploadedAt).toLocaleDateString()}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        )}
      </Card>
    </Box>
  );
}
