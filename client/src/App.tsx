import { useEffect } from 'react';
import { Alert, Box, Button } from '@mui/material';
import { Routes, Route, Navigate } from 'react-router-dom';
import { useAuthStore } from './store/auth.store';
import { AppShell } from './components/Layout/AppShell';
import { LoginPage } from './pages/Login/LoginPage';
import { AcceptInvitationPage } from './pages/Login/AcceptInvitationPage';
import { ChangePasswordPage } from './pages/Account/ChangePasswordPage';

// isAuthenticated alone is not a valid session — setAuth() always sets user/company/isAuthenticated
// together (auth.store.ts), so the only way to see isAuthenticated=true with company/user missing is
// a corrupted or pre-multi-company persisted blob. Rendering AppShell on that half-state used to just
// show a broken shell (Sidebar's `company?.name ?? 'Jewelry Suite'` fallback, blank content — AppShell
// derives its tab identity from company+user and renders nothing without them). Self-heal instead: log
// the bad session out so the user gets a clean login form, not a silently broken app.
function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const hasValidSession = useAuthStore((s) => s.isAuthenticated && !!s.company && !!s.user);
  useEffect(() => {
    if (isAuthenticated && !hasValidSession) useAuthStore.getState().logout();
  }, [isAuthenticated, hasValidSession]);
  const mustChangePassword = useAuthStore((s) => !!s.user?.mustChangePassword);
  if (!hasValidSession) return <Navigate to="/login" replace />;
  // The server refuses everything else until the temporary password is replaced (middleware/auth.ts); this is the screen for it.
  if (mustChangePassword) return <ForcedPasswordChange />;
  return <>{children}</>;
}

function ForcedPasswordChange() {
  const logout = useAuthStore((s) => s.logout);
  return (
    <Box sx={{ maxWidth: 520, mx: 'auto', p: 3 }}>
      <Alert severity="warning" sx={{ mb: 2 }}>You signed in with a temporary password. Choose your own password to continue.</Alert>
      <ChangePasswordPage />
      <Button sx={{ mt: 2 }} onClick={logout}>Sign out</Button>
    </Box>
  );
}

export default function App() {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);

  return (
    <Routes>
      <Route path="/login" element={isAuthenticated ? <Navigate to="/" replace /> : <LoginPage />} />
      <Route path="/accept-invitation" element={<AcceptInvitationPage />} />

      {/* AppShell renders the pages itself (one kept-alive pane per open tab) — see pageRoutes.tsx */}
      <Route path="/*" element={<ProtectedRoute><AppShell /></ProtectedRoute>} />
    </Routes>
  );
}
