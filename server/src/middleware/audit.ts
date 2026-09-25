import { Prisma } from '@prisma/client';
import { prisma } from '../config/database';
import { logger } from '../config/logger';
import { AppError } from './error';
import { tenantQuery, runAsPlatform } from '../shared/tenantContext';

// ═══════════════════════════════════════════════════════════════════════════
// Audit logging has exactly TWO paths, and they never mix:
//
//   createAuditEntry()         — a COMPANY event. companyId is a required argument (the compiler
//                                refuses a call without it) and audit_logs.companyId is NOT NULL.
//   createPlatformAuditEntry() — a TRIVO PLATFORM event (an operator action, e.g. provisioning or
//                                suspending a company). Written to platform_audit_logs, a separate
//                                table with no companyId that no company route can read.
//
// A company event is never "unscoped" and a platform event is never silently attributed to a
// company. (The old auditLog() Express middleware wrote rows with no company at all; it had no
// callers and has been removed.)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Records an audit event for ONE company.
 *
 * Two safeguards beyond the type system:
 *  - `companyId` must be present (a JS caller / `as any` cannot skip it);
 *  - the acting user must actually be a member of that company. A wrong companyId — a bug, or an
 *    attempt to write an event into another company's trail — is refused loudly instead of being
 *    stored: writing into the wrong company's audit log would corrupt that company's record.
 *
 * Failures to WRITE the row (DB down, etc.) are logged and swallowed so an audit hiccup never
 * fails the business operation that already succeeded; the two guard failures above are
 * programmer/forgery errors and are thrown.
 */
export async function createAuditEntry(
  tableName: string,
  recordId: string,
  userId: string,
  action: string,
  oldValues: Record<string, unknown> | undefined,
  newValues: Record<string, unknown> | undefined,
  companyId: string,
) {
  if (!companyId) throw new AppError('Audit event requires a companyId', 500);

  const isMember = await tenantQuery(companyId, (_tx) => _tx.companyUser.count({ where: { companyId, userId } }));
  if (isMember === 0) {
    throw new AppError('Audit event rejected: the acting user is not a member of the given company', 500);
  }

  try {
    await tenantQuery(companyId, (tx) =>
      tx.auditLog.create({
        data: {
          companyId,
          tableName,
          recordId,
          userId,
          action,
          oldValues: oldValues ? (oldValues as Prisma.InputJsonValue) : undefined,
          newValues: newValues ? (newValues as Prisma.InputJsonValue) : undefined,
        },
      })
    );
  } catch (err) {
    logger.error('Audit log failed:', err);
  }
}

/**
 * Records an event that belongs to the TRIVO platform itself rather than to any company.
 * Currently used for: legacy audit rows that could not be attributed to a company without
 * guessing (moved here by migration 20260924030000). Phase 3's company provisioning is the next
 * legitimate producer. Never call this for something a company user did inside a company.
 */
export async function createPlatformAuditEntry(entry: {
  actorUserId?: string;
  action: string;
  subjectType?: string;
  subjectId?: string;
  metadata?: Record<string, unknown>;
}) {
  try {
    await runAsPlatform((db) =>
      db.platformAuditLog.create({
        data: {
          actorUserId: entry.actorUserId,
          action: entry.action,
          subjectType: entry.subjectType,
          subjectId: entry.subjectId,
          metadata: entry.metadata ? (entry.metadata as Prisma.InputJsonValue) : undefined,
        },
      })
    );
  } catch (err) {
    logger.error('Platform audit log failed:', err);
  }
}
