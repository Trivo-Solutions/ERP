import { useState } from 'react';
import { Alert, Box, Button, Paper, Stack, TextField, Typography } from '@mui/material';
import { useMutation } from '@tanstack/react-query';
import { useSnackbar } from 'notistack';
import { api } from '../../api/client';
import { PageHeader } from '../../components/common/PageHeader';
import { useAuthStore } from '../../store/auth.store';

// Self-service password change for whoever is signed in (no permission needed — it only ever changes the caller's own
// password, and the server demands the current one). On success every OTHER session is signed out by the server and
// this one is carried on with the fresh tokens it returns. The password is never stored, logged or shown.

export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_LENGTH = 128;

/** Mirror of the server's rules so an obviously unacceptable password is stopped before the round trip. */
export function passwordFormError(f: { current: string; next: string; confirm: string }, who: { email?: string; name?: string } = {}): string {
  if (!f.current) return 'Enter your current password';
  if (f.next.length < MIN_PASSWORD_LENGTH) return `The new password must be at least ${MIN_PASSWORD_LENGTH} characters`;
  if (f.next.length > MAX_PASSWORD_LENGTH) return `The new password must be at most ${MAX_PASSWORD_LENGTH} characters`;
  if (f.next === f.current) return 'The new password must be different from the current one';
  const lower = f.next.toLowerCase();
  if ((who.email && lower.includes(who.email.toLowerCase())) || ((who.name?.trim().length ?? 0) >= 4 && lower.includes(who.name!.trim().toLowerCase()))) {
    return 'The new password must not contain your e-mail or name';
  }
  if (new Set(f.next).size < 5) return 'The new password is too repetitive';
  if (f.next !== f.confirm) return 'The two new passwords do not match';
  return '';
}

export function ChangePasswordPage() {
  const { enqueueSnackbar } = useSnackbar();
  const user = useAuthStore((s) => s.user);
  const [form, setForm] = useState({ current: '', next: '', confirm: '' });
  const [touched, setTouched] = useState(false);
  const [serverError, setServerError] = useState('');
  const clientError = passwordFormError(form, user ?? {});

  const change = useMutation({
    mutationFn: () => api.post<{ data: { accessToken: string; refreshToken: string } }>('/auth/change-password', { current: form.current, next: form.next }),
    onSuccess: (res) => {
      const t = res.data.data;
      useAuthStore.setState((s) => ({ accessToken: t.accessToken, refreshToken: t.refreshToken, user: s.user ? { ...s.user, mustChangePassword: false } : s.user }));
      setForm({ current: '', next: '', confirm: '' }); setTouched(false); setServerError('');
      enqueueSnackbar('Password changed. Other devices have been signed out.', { variant: 'success' });
    },
    // The server's message is deliberately generic and safe to show; nothing typed is ever echoed back.
    onError: (e: any) => setServerError(e?.response?.data?.error ?? 'Could not change the password. Please try again.'),
  });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setTouched(true); setServerError('');
    if (!clientError) change.mutate();
  };
  const set = (k: 'current' | 'next' | 'confirm') => (e: React.ChangeEvent<HTMLInputElement>) => { setForm({ ...form, [k]: e.target.value }); setServerError(''); };

  return (
    <Box>
      <PageHeader title="Change Password" />
      <Paper component="form" onSubmit={submit} sx={{ p: 3, maxWidth: 460 }} noValidate>
        <Stack spacing={2}>
          <Typography variant="body2" color="text.secondary">
            Choose a password of at least {MIN_PASSWORD_LENGTH} characters that you use nowhere else. Changing it signs you out of every other device.
          </Typography>
          <TextField label="Current password" type="password" size="small" required autoFocus autoComplete="current-password"
            value={form.current} onChange={set('current')} />
          <TextField label="New password" type="password" size="small" required autoComplete="new-password"
            value={form.next} onChange={set('next')} />
          <TextField label="Confirm new password" type="password" size="small" required autoComplete="new-password"
            value={form.confirm} onChange={set('confirm')} />
          {touched && clientError && <Alert severity="warning">{clientError}</Alert>}
          {serverError && <Alert severity="error">{serverError}</Alert>}
          <Box><Button type="submit" variant="contained" disabled={change.isPending}>{change.isPending ? 'Changing…' : 'Change password'}</Button></Box>
        </Stack>
      </Paper>
    </Box>
  );
}
