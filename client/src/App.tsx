import { Routes, Route, Navigate } from 'react-router-dom';
import { useAuthStore } from './store/auth.store';
import { AppShell } from './components/Layout/AppShell';
import { LoginPage } from './pages/Login/LoginPage';

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  return isAuthenticated ? <>{children}</> : <Navigate to="/login" replace />;
}

export default function App() {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);

  return (
    <Routes>
      <Route path="/login" element={isAuthenticated ? <Navigate to="/" replace /> : <LoginPage />} />

      {/* AppShell renders the pages itself (one kept-alive pane per open tab) — see pageRoutes.tsx */}
      <Route path="/*" element={<ProtectedRoute><AppShell /></ProtectedRoute>} />
    </Routes>
  );
}
