import type { ReactNode } from 'react';
import { useAuthStore } from '../../store/auth.store';

interface PermissionGateProps {
  /** A single required permission. */
  permission?: string;
  /** Rendered if the user holds ANY one of these. */
  anyOf?: string[];
  /** Rendered only if the user holds ALL of these. */
  allOf?: string[];
  /** Shown instead when the permission check fails. Defaults to nothing (hide, don't disable) — a
   *  page that needs a disabled/explained state instead of hiding should check hasPermission()
   *  itself rather than relying on this default. */
  fallback?: ReactNode;
  children: ReactNode;
}

/**
 * The single place a component decides "does the current user get to see/do this" for anything
 * short of a whole page (see RequirePermission for that). Reuses auth.store's hasPermission —
 * exact match / resource:* / '*' — the SAME algorithm the backend's requirePermission(...) uses
 * (middleware/rbac.ts), so a role that passes here is never surprised by a 403 from the server.
 * Backend authorization remains authoritative regardless of what this renders — this is UX/defense
 * in depth, not the security boundary.
 */
export function PermissionGate({ permission, anyOf, allOf, fallback = null, children }: PermissionGateProps) {
  const hasPermission = useAuthStore((s) => s.hasPermission);

  const allowed = permission
    ? hasPermission(permission)
    : anyOf
      ? anyOf.some((p) => hasPermission(p))
      : allOf
        ? allOf.every((p) => hasPermission(p))
        : true;

  return <>{allowed ? children : fallback}</>;
}
