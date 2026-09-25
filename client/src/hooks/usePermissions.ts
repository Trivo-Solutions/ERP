import { useAuthStore } from '../store/auth.store';

export function usePermissions() {
  const { hasPermission, hasAnyPermission, user } = useAuthStore();
  return { hasPermission, hasAnyPermission, user, role: user?.role };
}

export function useCanAccess(permission: string): boolean {
  return useAuthStore((s) => s.hasPermission(permission));
}
