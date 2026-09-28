import { useState } from 'react';
import {
  Box, Card, CardContent, TextField, Button, Typography,
  InputAdornment, IconButton, Alert, CircularProgress,
} from '@mui/material';
import { Visibility, VisibilityOff, Diamond } from '@mui/icons-material';
import { useForm } from 'react-hook-form';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../../api/client';
import { useAuthStore } from '../../store/auth.store';

interface FormData { name: string; password: string; confirmPassword: string }

// PUBLIC — reached from a link an admin hands an invitee directly (no email provider is wired up
// yet, see auth.service.ts: createInvitation). Accepting does not sign the invitee in; they land on
// the normal login screen and sign in with their company code + email/username + this password.
export function AcceptInvitationPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const token = params.get('token') ?? '';
  const [showPass, setShowPass] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);

  const { register, handleSubmit, watch, formState: { errors } } = useForm<FormData>();

  const onSubmit = async (data: FormData) => {
    setLoading(true);
    setError('');
    try {
      await api.post('/auth/invitations/accept', { token, name: data.name.trim(), password: data.password });
      setDone(true);
    } catch (err: any) {
      setError(err.response?.data?.error ?? 'Invalid or expired invitation');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Box
      sx={{
        minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'linear-gradient(135deg, #0D1B4B 0%, #122262 40%, #0D1B4B 100%)', p: 2,
      }}
    >
      <Card sx={{ maxWidth: 420, width: '100%', borderRadius: 4, boxShadow: '0 24px 64px rgba(0,0,0,0.4)' }}>
        <CardContent sx={{ p: 4 }}>
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
            <Typography variant="h5" fontWeight={800} color="#44C47A">TRIVO ERP</Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
              Accept your invitation
            </Typography>
          </Box>

          {!token && <Alert severity="error" sx={{ mb: 2, borderRadius: 2 }}>This link is missing its invitation token.</Alert>}

          {done ? (
            <>
              <Alert severity="success" sx={{ mb: 3, borderRadius: 2 }}>
                You're in! Sign in with your company code and the password you just set.
              </Alert>
              <Button
                fullWidth variant="contained" size="large"
                onClick={() => {
                  // This link is often opened in the same browser as whoever sent the invite — if
                  // that admin (or anyone) is still logged in here, /login's own redirect would
                  // otherwise bounce straight past the form into THEIR session instead of letting
                  // the invitee sign in as themselves. Force a clean slate first.
                  useAuthStore.getState().logout();
                  navigate('/login', { replace: true });
                }}
              >
                Go to Sign In
              </Button>
            </>
          ) : (
            <>
              {error && <Alert severity="error" sx={{ mb: 2, borderRadius: 2 }}>{error}</Alert>}
              <form onSubmit={handleSubmit(onSubmit)}>
                <TextField
                  fullWidth label="Your Name" sx={{ mb: 2 }}
                  {...register('name', { required: 'Name is required', minLength: { value: 2, message: 'Too short' } })}
                  error={!!errors.name} helperText={errors.name?.message}
                />
                <TextField
                  fullWidth label="Password" type={showPass ? 'text' : 'password'} sx={{ mb: 2 }}
                  {...register('password', { required: 'Password is required', minLength: { value: 8, message: 'At least 8 characters' } })}
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
                <TextField
                  fullWidth label="Confirm Password" type={showPass ? 'text' : 'password'} sx={{ mb: 3 }}
                  {...register('confirmPassword', {
                    required: 'Please confirm your password',
                    validate: (v) => v === watch('password') || 'Passwords do not match',
                  })}
                  error={!!errors.confirmPassword} helperText={errors.confirmPassword?.message}
                />
                <Button
                  type="submit" fullWidth variant="contained" size="large"
                  disabled={loading || !token}
                  sx={{
                    py: 1.5, fontSize: 16, fontWeight: 700,
                    background: 'linear-gradient(135deg, #44C47A 0%, #FFB000 100%)',
                    '&:hover': { background: 'linear-gradient(135deg, #A06600 0%, #44C47A 100%)' },
                  }}
                >
                  {loading ? <CircularProgress size={22} sx={{ color: '#FFF' }} /> : 'Accept Invitation'}
                </Button>
              </form>
            </>
          )}

          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', textAlign: 'center', mt: 3 }}>
            © 2026 TRIVO ERP
          </Typography>
        </CardContent>
      </Card>
    </Box>
  );
}
