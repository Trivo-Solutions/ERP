import { useState } from 'react';
import {
  Box, Card, CardContent, TextField, Button, Typography,
  InputAdornment, IconButton, Alert, CircularProgress,
} from '@mui/material';
import { Visibility, VisibilityOff, Diamond } from '@mui/icons-material';
import { useForm } from 'react-hook-form';
import { useSnackbar } from 'notistack';
import { api } from '../../api/client';
import { useAuthStore } from '../../store/auth.store';

interface FormData { companyCode: string; identifier: string; password: string }

export function LoginPage() {
  const { setAuth } = useAuthStore();
  const { enqueueSnackbar } = useSnackbar();
  const [showPass, setShowPass] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const { register, handleSubmit, formState: { errors } } = useForm<FormData>();

  const onSubmit = async (data: FormData) => {
    setLoading(true);
    setError('');
    try {
      // companyCode resolves which tenant to authenticate against — the backend looks up the
      // Company first, then the identifier's membership within it, and embeds companyId in the
      // issued JWT itself. The frontend never supplies a companyId directly, here or anywhere
      // else — the backend remains the sole source of truth for tenant context on every request.
      const res = await api.post<{ data: { user: any; company: any; accessToken: string; refreshToken: string } }>(
        '/auth/login', {
          companyCode: data.companyCode.trim().toUpperCase(),
          identifier: data.identifier.trim(),
          password: data.password,
        }
      );
      setAuth(res.data.data.user, res.data.data.accessToken, res.data.data.refreshToken, res.data.data.company);
      enqueueSnackbar('Welcome back!', { variant: 'success' });
    } catch (err: any) {
      setError(err.response?.data?.error ?? 'Login failed. Please check your company code and credentials.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Box
      sx={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'linear-gradient(135deg, #0D1B4B 0%, #122262 40%, #0D1B4B 100%)',
        p: 2,
      }}
    >
      <Card sx={{ maxWidth: 420, width: '100%', borderRadius: 4, boxShadow: '0 24px 64px rgba(0,0,0,0.4)' }}>
        <CardContent sx={{ p: 4 }}>
          {/* Logo */}
          <Box sx={{ textAlign: 'center', mb: 4 }}>
            <Box
              sx={{
                width: 64, height: 64, borderRadius: 3,
                background: 'linear-gradient(135deg, #44C47A 0%, #44C47A 100%)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                mx: 'auto', mb: 2, boxShadow: '0 8px 24px rgba(204,136,0,0.3)',
              }}
            >
              <Diamond sx={{ fontSize: 32, color: '#FFF' }} />
            </Box>
            <Typography variant="h5" fontWeight={800} color="#44C47A">
              TRIVO ERP
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
              Jewellery retail & wholesale management
            </Typography>
          </Box>

          {error && <Alert severity="error" sx={{ mb: 2, borderRadius: 2 }}>{error}</Alert>}

          <form onSubmit={handleSubmit(onSubmit)}>
            <TextField
              fullWidth label="Company Code" sx={{ mb: 2 }}
              autoCapitalize="characters"
              inputProps={{ style: { textTransform: 'uppercase' } }}
              {...register('companyCode', { required: 'Company Code is required' })}
              error={!!errors.companyCode} helperText={errors.companyCode?.message}
            />
            <TextField
              fullWidth label="Email or Username" sx={{ mb: 2 }}
              {...register('identifier', { required: 'Email or Username is required' })}
              error={!!errors.identifier} helperText={errors.identifier?.message}
            />
            <TextField
              fullWidth label="Password" type={showPass ? 'text' : 'password'} sx={{ mb: 3 }}
              {...register('password', { required: 'Password is required' })}
              error={!!errors.password} helperText={errors.password?.message}
              InputProps={{
                endAdornment: (
                  <InputAdornment position="end">
                    <IconButton onClick={() => setShowPass(!showPass)} size="small">
                      {showPass ? <VisibilityOff /> : <Visibility />}
                    </IconButton>
                  </InputAdornment>
                ),
              }}
            />
            <Button
              type="submit" fullWidth variant="contained" size="large"
              disabled={loading}
              sx={{
                py: 1.5, fontSize: 16, fontWeight: 700,
                background: 'linear-gradient(135deg, #44C47A 0%, #FFB000 100%)',
                '&:hover': { background: 'linear-gradient(135deg, #A06600 0%, #44C47A 100%)' },
              }}
            >
              {loading ? <CircularProgress size={22} sx={{ color: '#FFF' }} /> : 'Sign In'}
            </Button>
          </form>

          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', textAlign: 'center', mt: 3 }}>
            © 2026 TRIVO ERP
          </Typography>
        </CardContent>
      </Card>
    </Box>
  );
}
