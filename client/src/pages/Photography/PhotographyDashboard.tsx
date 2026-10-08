import { Alert, Box, Button, Card, CardContent, Grid, Typography } from '@mui/material';
import { CameraAlt, HourglassTop, ErrorOutline, RateReview, DeleteOutline, Storage, DevicesOther, QrCodeScanner } from '@mui/icons-material';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { PageHeader } from '../../components/common/PageHeader';
import { KpiCard } from '../../components/common/KpiCard';
import { PermissionGate } from '../../components/auth/PermissionGate';
import { getDashboard, photoKeys, errorMessage, type PhotographyDashboardData } from './photographyApi';

interface ViewProps {
  data?: PhotographyDashboardData;
  loading?: boolean;
  error?: unknown;
}

const n = (v: number) => v.toLocaleString('en-IN');

/** Presentational — numbers are shown exactly as the API returns them; nothing is recomputed here. */
export function DashboardView({ data, loading, error }: ViewProps) {
  if (error) return <Alert severity="error" role="alert">{errorMessage(error, 'Failed to load the photography dashboard')}</Alert>;
  const d = data;
  const failed = d?.processingFailed ?? 0;
  return (
    <>
      <Typography variant="subtitle2" color="text.secondary" sx={{ mb: 1 }}>Today's activity</Typography>
      <Grid container spacing={2} sx={{ mb: 3 }}>
        <Grid item xs={12} sm={6} md={4} lg={2.4}><KpiCard title="Today's photos" value={d ? n(d.todaysPhotos) : '—'} icon={<CameraAlt />} loading={loading} /></Grid>
        <Grid item xs={12} sm={6} md={4} lg={2.4}><KpiCard title="Pending processing" value={d ? n(d.pendingProcessing) : '—'} icon={<HourglassTop />} color="#F5A524" loading={loading} /></Grid>
        <Grid item xs={12} sm={6} md={4} lg={2.4}><KpiCard title="Processing failed" value={d ? n(d.processingFailed) : '—'} icon={<ErrorOutline />} color={failed > 0 ? '#E5484D' : '#44C47A'} loading={loading} /></Grid>
        <Grid item xs={12} sm={6} md={6} lg={2.4}><KpiCard title="Reviewed images" value={d ? n(d.imagesReviewed) : '—'} icon={<RateReview />} color="#3E8EF7" loading={loading} /></Grid>
        <Grid item xs={12} sm={6} md={6} lg={2.4}><KpiCard title="Deleted today" value={d ? n(d.imagesDeletedToday) : '—'} icon={<DeleteOutline />} color="#8A8F98" loading={loading} /></Grid>
      </Grid>

      <Grid container spacing={2}>
        <Grid item xs={12} md={6}>
          <Card sx={{ height: '100%' }}>
            <CardContent>
              <Typography variant="subtitle1" fontWeight={700} gutterBottom>Processing status</Typography>
              {d && failed > 0 && (
                <Alert severity="warning" sx={{ mb: 1.5 }}>
                  {n(failed)} {failed === 1 ? 'image' : 'images'} failed processing. The original is kept; optimized and thumbnail
                  versions are missing for {failed === 1 ? 'it' : 'them'}.
                </Alert>
              )}
              <Typography variant="body2">Pending: <b>{d ? n(d.pendingProcessing) : '—'}</b></Typography>
              <Typography variant="body2">Failed: <b>{d ? n(d.processingFailed) : '—'}</b></Typography>
              {d && failed === 0 && d.pendingProcessing === 0 && (
                <Typography variant="caption" color="text.secondary">Nothing waiting or failed.</Typography>
              )}
            </CardContent>
          </Card>
        </Grid>
        <Grid item xs={12} md={3}>
          <KpiCard title="Active stations" value={d ? n(d.activeStations) : '—'} icon={<DevicesOther />} color="#8B5CF6" loading={loading} />
        </Grid>
        <Grid item xs={12} md={3}>
          <Card sx={{ height: '100%' }}>
            <CardContent>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 0.5 }}>
                <Storage fontSize="small" color="disabled" />
                <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.08em' }}>Storage usage</Typography>
              </Box>
              {d?.storageUsage.available ? (
                <Typography variant="body2">Reported by the server.</Typography>
              ) : (
                <>
                  <Typography variant="h6" color="text.secondary">Not available</Typography>
                  {d?.storageUsage.reason && <Typography variant="caption" color="text.secondary">{d.storageUsage.reason}</Typography>}
                </>
              )}
            </CardContent>
          </Card>
        </Grid>
      </Grid>
    </>
  );
}

export function PhotographyDashboard() {
  const navigate = useNavigate();
  const { data, isLoading, error } = useQuery({ queryKey: photoKeys.dashboard, queryFn: getDashboard });
  return (
    <Box>
      <PageHeader title="Photography" subtitle="Tag photo activity" />
      <PermissionGate permission="photography:capture">
        <Button variant="contained" startIcon={<QrCodeScanner />} sx={{ mb: 2 }} onClick={() => navigate('/photography/capture')}>
          Open capture
        </Button>
      </PermissionGate>
      <DashboardView data={data} loading={isLoading} error={error} />
    </Box>
  );
}
