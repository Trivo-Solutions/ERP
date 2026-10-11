import { AppError } from '../middleware/error';
import { hasPermission } from '../middleware/rbac';

// Privilege-escalation guard: a person can only hand out authority they hold themselves. Without this, anyone who may
// edit roles AND invite/assign users can write a '*' role and give it to themselves. Company SUPER_ADMIN holds '*', so
// is unaffected. Applies to the permissions being ADDED (removing authority is always allowed).
export function assertCanGrant(actorPermissions: string[], granted: string[], existing: string[] = []): void {
  const added = granted.filter((p) => !existing.includes(p));
  const beyond = added.filter((p) => !hasPermission(actorPermissions, p));
  if (beyond.length > 0) {
    throw new AppError(`You cannot grant permissions you do not hold yourself: ${beyond.slice(0, 5).join(', ')}${beyond.length > 5 ? '…' : ''}`, 403);
  }
}
