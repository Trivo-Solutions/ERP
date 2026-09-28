import type { ReactNode } from 'react';
import { Box, Typography } from '@mui/material';
import { LockOutlined } from '@mui/icons-material';
import { useAuthStore } from '../../store/auth.store';

/**
 * Full-page fallback for a route the current user's permissions don't reach. Deep-linking (typing
 * the URL, a stale bookmark, a link shared by someone with broader access) must land here, not on
 * the page's own content or a blank screen — hiding the nav entry alone (navItems.tsx) was never a
 * security boundary, only a convenience.
 */
function AccessRestricted({ required }: { required?: string }) {
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '70vh', gap: 1.5, textAlign: 'center' }}>
      <LockOutlined sx={{ fontSize: 40, color: 'text.disabled' }} />
      <Typography variant="h6" fontWeight={700}>Access Restricted</Typography>
      <Typography variant="body2" color="text.secondary" sx={{ maxWidth: 420 }}>
        You don't have permission to view this page. Ask a Super Admin or your administrator to grant
        you access{required ? ` (${required})` : ''}.
      </Typography>
    </Box>
  );
}

interface RequirePermissionProps {
  /** A single required permission. */
  permission?: string;
  /** Allowed if the user holds ANY one of these. */
  anyOf?: string[];
  children: ReactNode;
}

/**
 * Route-level guard: renders `children` only if the signed-in user's permissions (set once at
 * login — see auth.store.ts) satisfy the requirement, using the exact same exact/resource-wildcard/
 * '*' algorithm the backend's requirePermission(...) middleware enforces. This stops a user without
 * the permission from reaching a protected page by typing/bookmarking/being sent its URL directly —
 * previously every route in pageRoutes.tsx rendered for any authenticated user regardless of role.
 *
 * This is defense in depth, not the security boundary: every mutation the page can trigger is still
 * independently checked by the server's own requirePermission(...), and every button/action inside
 * a page must still be gated with PermissionGate on its OWN specific permission (a page reachable
 * with a "view" permission can still expose "create"/"edit" controls that need more).
 */
export function RequirePermission({ permission, anyOf, children }: RequirePermissionProps) {
  const hasPermission = useAuthStore((s) => s.hasPermission);
  const allowed = permission ? hasPermission(permission) : anyOf ? anyOf.some((p) => hasPermission(p)) : true;
  return allowed ? <>{children}</> : <AccessRestricted required={permission ?? anyOf?.join(' or ')} />;
}
