import { Prisma } from '@prisma/client';

/**
 * True if `err` is Postgres refusing a DELETE/UPDATE because another row still points at it via an
 * `onDelete: Restrict` (or default NO ACTION) foreign key. Outside a transaction/batch this surfaces
 * as a typed `PrismaClientKnownRequestError` with code P2003; inside one (tenantQuery/tenantTransaction
 * wrap everything in a $transaction to set the RLS session var) the driver instead surfaces Postgres's
 * own 23001/23503 as an untyped `PrismaClientUnknownRequestError` — so both shapes have to be checked,
 * not just P2003.
 */
export function isBlockedByForeignKey(err: unknown): boolean {
  return (
    (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2003') ||
    (err instanceof Prisma.PrismaClientUnknownRequestError && /23001|23503|violates (RESTRICT|foreign key)/.test(err.message))
  );
}
